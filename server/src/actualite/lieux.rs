//! Placer un titre sur une commune : la liste des communes (geo.api.gouv.fr, base INSEE) et la recherche d'un nom dans un titre.
//!
//! # Ce qui place un titre, dans l'ordre
//!
//! 1. **L'adresse de l'article**, quand l'éditeur y met le lieu : `/bretagne/cotes-d-armor/saint-brieuc/…` (France 3),
//!    `/pays-de-la-loire/mayenne-53/laval/…` (ICI), `/normandie/caen_14118/…` (actu.fr, avec le code INSEE). C'est l'information
//!    de la rédaction, pas une devinette : elle gagne sur le titre. On ne lit jamais la page : l'adresse est dans le fil.
//! 2. **Le nom d'une commune dans le titre**, en correspondance exacte : minuscules, accents et tirets effacés, « Saint » et
//!    « St » confondus, articles et contractions défaits (« au Havre » = « à le Havre » = « Le Havre »), le plus long nom gagnant
//!    (« Saint-Denis-de-la-Réunion » avant « Saint-Denis »). Le nom doit commencer par une majuscule dans le titre, et selon
//!    le contexte il faut un indice de plus (voir [`Context`]) : un nom de commune est souvent un mot courant ou un nom de famille.
//! 3. **Le département**, d'après l'adresse ou le nom du département dans le titre (« Haute-Loire. Face aux attaques… ») : le titre
//!    est alors rattaché au département, et le site le dit (« département », pas un point précis).
//!
//! Rien d'autre : pas de région, pas de « ville la plus proche ». Un titre qui ne dit pas où il se passe n'est pas gardé.
//!
//! # Homonymes
//!
//! Il y a 31 communes « Saint-Denis »… Parmi les homonymes, celle d'un département connu (celui de l'adresse, sinon ceux du fil)
//! l'emporte, la plus peuplée si elles sont plusieurs. Sans indice, le nom doit être unique en France ou une commune de loin la plus
//! peuplée (au moins cinq fois la suivante) ; sinon le titre n'est pas placé.

use std::collections::HashMap;

use anyhow::{Context as _, Result};
use serde::Deserialize;

/// Départements : code, nom. (Collectivités d'outre-mer comprises quand geo.api.gouv.fr leur donne un code.)
const DEPARTMENTS: &[(&str, &str)] = &[
    ("01", "Ain"), ("02", "Aisne"), ("03", "Allier"), ("04", "Alpes-de-Haute-Provence"), ("05", "Hautes-Alpes"), ("06", "Alpes-Maritimes"),
    ("07", "Ardèche"), ("08", "Ardennes"), ("09", "Ariège"), ("10", "Aube"), ("11", "Aude"), ("12", "Aveyron"), ("13", "Bouches-du-Rhône"),
    ("14", "Calvados"), ("15", "Cantal"), ("16", "Charente"), ("17", "Charente-Maritime"), ("18", "Cher"), ("19", "Corrèze"), ("2A", "Corse-du-Sud"),
    ("2B", "Haute-Corse"), ("21", "Côte-d'Or"), ("22", "Côtes-d'Armor"), ("23", "Creuse"), ("24", "Dordogne"), ("25", "Doubs"), ("26", "Drôme"),
    ("27", "Eure"), ("28", "Eure-et-Loir"), ("29", "Finistère"), ("30", "Gard"), ("31", "Haute-Garonne"), ("32", "Gers"), ("33", "Gironde"),
    ("34", "Hérault"), ("35", "Ille-et-Vilaine"), ("36", "Indre"), ("37", "Indre-et-Loire"), ("38", "Isère"), ("39", "Jura"), ("40", "Landes"),
    ("41", "Loir-et-Cher"), ("42", "Loire"), ("43", "Haute-Loire"), ("44", "Loire-Atlantique"), ("45", "Loiret"), ("46", "Lot"),
    ("47", "Lot-et-Garonne"), ("48", "Lozère"), ("49", "Maine-et-Loire"), ("50", "Manche"), ("51", "Marne"), ("52", "Haute-Marne"),
    ("53", "Mayenne"), ("54", "Meurthe-et-Moselle"), ("55", "Meuse"), ("56", "Morbihan"), ("57", "Moselle"), ("58", "Nièvre"), ("59", "Nord"),
    ("60", "Oise"), ("61", "Orne"), ("62", "Pas-de-Calais"), ("63", "Puy-de-Dôme"), ("64", "Pyrénées-Atlantiques"), ("65", "Hautes-Pyrénées"),
    ("66", "Pyrénées-Orientales"), ("67", "Bas-Rhin"), ("68", "Haut-Rhin"), ("69", "Rhône"), ("70", "Haute-Saône"), ("71", "Saône-et-Loire"),
    ("72", "Sarthe"), ("73", "Savoie"), ("74", "Haute-Savoie"), ("75", "Paris"), ("76", "Seine-Maritime"), ("77", "Seine-et-Marne"),
    ("78", "Yvelines"), ("79", "Deux-Sèvres"), ("80", "Somme"), ("81", "Tarn"), ("82", "Tarn-et-Garonne"), ("83", "Var"), ("84", "Vaucluse"),
    ("85", "Vendée"), ("86", "Vienne"), ("87", "Haute-Vienne"), ("88", "Vosges"), ("89", "Yonne"), ("90", "Territoire de Belfort"),
    ("91", "Essonne"), ("92", "Hauts-de-Seine"), ("93", "Seine-Saint-Denis"), ("94", "Val-de-Marne"), ("95", "Val-d'Oise"),
    ("971", "Guadeloupe"), ("972", "Martinique"), ("973", "Guyane"), ("974", "La Réunion"), ("976", "Mayotte"),
];

/// Les plus longs noms de commune comptent huit mots ; au-delà, un titre n'en contient pas.
const MAX_WORDS: usize = 10;
/// Une commune « très peuplée » : son nom seul, sans indice, suffit.
const BIG: u32 = 30_000;
/// Rapport de population qui départage des homonymes sans indice de département.
const DOMINANCE: u32 = 5;

#[derive(Debug)]
pub struct Commune {
    pub insee: Box<str>,
    pub name: Box<str>,
    /// Indice dans `Gazetteer::depts`.
    pub dept: u16,
    pub lon: f32,
    pub lat: f32,
    pub pop: u32,
}

#[derive(Debug)]
pub struct Dept {
    pub code: &'static str,
    pub name: &'static str,
    /// Milieu des centres de ses communes.
    pub lon: f32,
    pub lat: f32,
}

/// Où un titre a été placé.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Place {
    Commune(u32),
    Dept(u16),
}

/// Comment : l'adresse de l'article ou le titre, au niveau de la commune ou du seul département.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    UrlCommune,
    TitleCommune,
    UrlDept,
    TitleDept,
}

#[derive(Debug, Default)]
pub struct Gazetteer {
    pub communes: Vec<Commune>,
    pub depts: Vec<Dept>,
    /// Nom normalisé (mots séparés par une espace) → communes qui le portent.
    by_name: HashMap<Box<str>, Vec<u32>>,
    by_insee: HashMap<Box<str>, u32>,
    dept_by_code: HashMap<&'static str, u16>,
    dept_by_name: HashMap<Box<str>, u16>,
    /// Les communes d'un département, par nom normalisé (pour lire l'adresse d'un article).
    in_dept: HashMap<(u16, Box<str>), u32>,
}

#[derive(Deserialize)]
struct RawCommune {
    nom: String,
    code: String,
    #[serde(rename = "codeDepartement")]
    department: Option<String>,
    centre: Option<RawPoint>,
    population: Option<u32>,
}

#[derive(Deserialize)]
struct RawPoint {
    coordinates: [f64; 2],
}

// --- Normalisation -----------------------------------------------------------------------------------------------------

/// Un mot du titre, défait de ses accents et de sa casse.
#[derive(Debug, Clone)]
struct Word {
    text: String,
    /// Écrit avec une majuscule dans le titre.
    capital: bool,
    /// Ponctuation qui suit le mot (« : », « . », « , », « ( », « – ») : le mot termine un groupe.
    stops: bool,
}

fn fold(c: char) -> Option<&'static str> {
    Some(match c {
        'à' | 'â' | 'ä' | 'á' | 'ã' | 'å' | 'À' | 'Â' | 'Ä' | 'Á' | 'Ã' | 'Å' => "a",
        'ç' | 'Ç' => "c",
        'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => "e",
        'î' | 'ï' | 'í' | 'Î' | 'Ï' | 'Í' => "i",
        'ô' | 'ö' | 'ó' | 'õ' | 'Ô' | 'Ö' | 'Ó' | 'Õ' => "o",
        'ù' | 'û' | 'ü' | 'ú' | 'Ù' | 'Û' | 'Ü' | 'Ú' => "u",
        'ÿ' | 'ý' | 'Ý' => "y",
        'ñ' | 'Ñ' => "n",
        'œ' | 'Œ' => "oe",
        'æ' | 'Æ' => "ae",
        _ => return None,
    })
}

/// Les mots d'un texte : lettres et chiffres, tout le reste sépare (l'apostrophe et le tiret aussi : « L'Isle-Adam » = l, isle, adam).
/// « Saint » devient « st », « Sainte » « ste » ; « au », « aux », « du », « des » sont défaits en « à le », « à les », « de le », « de les ».
fn words(text: &str) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::new();
    let mut current = String::new();
    let mut capital = false;
    let mut separator = String::new();
    let mut flush = |out: &mut Vec<Word>, current: &mut String, capital: bool| {
        if current.is_empty() {
            return;
        }
        let word = std::mem::take(current);
        let mut push = |text: &str, cap: bool| out.push(Word { text: text.to_string(), capital: cap, stops: false });
        match word.as_str() {
            "saint" => push("st", capital),
            "sainte" => push("ste", capital),
            "au" => {
                push("a", false);
                push("le", false);
            }
            "aux" => {
                push("a", false);
                push("les", false);
            }
            "du" => {
                push("de", false);
                push("le", false);
            }
            "des" => {
                push("de", false);
                push("les", false);
            }
            _ => push(&word, capital),
        }
    };
    for c in text.chars() {
        if c.is_alphanumeric() {
            if !separator.is_empty() {
                if let Some(last) = out.last_mut() {
                    last.stops = separator.chars().any(|s| ":.,()–—|;!?«»".contains(s)) || separator.trim() == "-" && separator.len() > 1;
                }
                separator.clear();
            }
            if current.is_empty() {
                capital = c.is_uppercase();
            }
            match fold(c) {
                Some(folded) => current.push_str(folded),
                None => current.extend(c.to_lowercase()),
            }
        } else {
            flush(&mut out, &mut current, capital);
            separator.push(c);
        }
    }
    flush(&mut out, &mut current, capital);
    out
}

fn key_of(text: &str) -> String {
    words(text).iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
}

const ARTICLES: &[&str] = &["le", "la", "les", "l", "de", "d", "du", "des", "en", "sur", "sous", "et", "a", "aux", "au", "lès", "les"];

fn is_article(word: &str) -> bool {
    ARTICLES.contains(&word)
}

/// Noms de commune qui sont aussi des mots courants, des prénoms ou des marques : jamais pris sans un vrai indice.
const COMMON: &[&str] = &[
    "bar", "vue", "plan", "st", "ste", "mont", "monts", "pont", "port", "ville", "bois", "val", "lac", "pres", "eau", "haut", "haute", "bas",
    "basse", "grand", "grande", "petit", "petite", "vallee", "ferme", "moulin", "grange", "tour", "chateau", "eglise", "bourg", "roche",
    "pierre", "marie", "jean", "louis", "paul", "luc", "marc", "antoine", "andre", "michel", "martin", "laurent", "claude", "vincent",
    "nord", "sud", "est", "ouest", "centre", "orange", "ensemble", "avenir", "amour", "bonne", "belle", "bon", "point", "gare", "croix",
    "place", "route", "rue", "pays", "terre", "mer", "ile", "ciel", "feu", "sept", "six", "trois", "neuf", "onze", "mars", "mai", "juin",
    "ancien", "ancienne", "nouveau", "nouvelle", "vie", "monde", "force", "soleil", "ligne", "cours", "tous", "bien", "mieux", "lorraine",
    "alsace", "bretagne", "normandie", "provence", "champagne", "bourgogne", "auvergne", "savoie", "vendee", "occitanie", "picardie",
];

// --- Le contexte d'un nom ------------------------------------------------------------------------------------------------------

/// Ce qui entoure un nom de lieu dans un titre.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Context {
    /// Rien d'utile autour (« Toulouse bat Bordeaux »).
    Bare,
    /// « de Toulouse », « du Nord », « entre Nantes et Rennes ».
    Weak,
    /// « à Toulouse », « dans la Manche », « près de Laval », « commune de… », ou le nom ouvre le titre (« Toulouse : un homme… »).
    Strong,
}

const STRONG_BEFORE: &[&str] = &["a", "en", "dans", "sur", "vers", "chez"];
/// « près de », « commune de »… : un mot, puis « de » ou « d' ».
const STRONG_BEFORE_DE: &[&str] =
    &["pres", "autour", "commune", "ville", "village", "metropole", "agglomeration", "banlieue", "environs", "proximite", "nord", "sud", "est", "ouest", "centre", "departement", "cote", "port", "bord"];

fn context_of(w: &[Word], start: usize, end: usize) -> Context {
    // Un nom qui ouvre le titre (ou ouvre après un seul mot : « VIDÉO - Toulouse : … ») et finit sur une ponctuation.
    if w[end - 1].stops && start <= 1 {
        return Context::Strong;
    }
    let mut i = start;
    // On remonte au-dessus des articles : « dans la Manche » → « dans ».
    while i > 0 && matches!(w[i - 1].text.as_str(), "le" | "la" | "les" | "l") {
        i -= 1;
    }
    if i == 0 {
        return Context::Bare;
    }
    let previous = w[i - 1].text.as_str();
    if STRONG_BEFORE.contains(&previous) {
        return Context::Strong;
    }
    if matches!(previous, "de" | "d") {
        if i >= 2 && STRONG_BEFORE_DE.contains(&w[i - 2].text.as_str()) {
            return Context::Strong;
        }
        return Context::Weak;
    }
    if matches!(previous, "entre" | "et" | "ou" | "pour" | "contre" | "face") {
        return Context::Weak;
    }
    Context::Bare
}

// --- Chargement ---------------------------------------------------------------------------------------------------------------

impl Gazetteer {
    /// Lit la réponse de `geo.api.gouv.fr/communes?fields=nom,code,codeDepartement,centre,population&format=json&geometry=centre`.
    pub fn from_json(json: &[u8]) -> Result<Gazetteer> {
        let raw: Vec<RawCommune> = serde_json::from_slice(json).context("liste des communes illisible")?;
        let mut gazetteer = Gazetteer::default();
        let mut sums: Vec<(f64, f64, u32)> = Vec::new();
        for (index, &(code, name)) in DEPARTMENTS.iter().enumerate() {
            gazetteer.dept_by_code.insert(code, index as u16);
            gazetteer.dept_by_name.insert(key_of(name).into(), index as u16);
            gazetteer.depts.push(Dept { code, name, lon: 0.0, lat: 0.0 });
            sums.push((0.0, 0.0, 0));
        }
        for commune in raw {
            let (Some(code), Some(centre)) = (commune.department, commune.centre) else { continue };
            let Some(&dept) = gazetteer.dept_by_code.get(code.as_str()) else { continue };
            let [lon, lat] = centre.coordinates;
            let id = gazetteer.communes.len() as u32;
            let key: Box<str> = key_of(&commune.nom).into();
            if key.is_empty() {
                continue;
            }
            gazetteer.by_insee.insert(commune.code.as_str().into(), id);
            gazetteer.in_dept.insert((dept, key.clone()), id);
            gazetteer.by_name.entry(key).or_default().push(id);
            let sum = &mut sums[usize::from(dept)];
            *sum = (sum.0 + lon, sum.1 + lat, sum.2 + 1);
            gazetteer.communes.push(Commune {
                insee: commune.code.into(),
                name: commune.nom.into(),
                dept,
                lon: lon as f32,
                lat: lat as f32,
                pop: commune.population.unwrap_or(0),
            });
        }
        for (dept, sum) in gazetteer.depts.iter_mut().zip(&sums) {
            if sum.2 > 0 {
                dept.lon = (sum.0 / f64::from(sum.2)) as f32;
                dept.lat = (sum.1 / f64::from(sum.2)) as f32;
            }
        }
        anyhow::ensure!(gazetteer.communes.len() > 30_000, "liste des communes trop courte : {}", gazetteer.communes.len());
        Ok(gazetteer)
    }

    pub fn dept_index(&self, code: &str) -> Option<u16> {
        self.dept_by_code.get(code).copied()
    }

    /// Les départements d'un fil, en indices (un code inconnu est ignoré).
    pub fn dept_indices(&self, codes: &[String]) -> Vec<u16> {
        codes.iter().filter_map(|c| self.dept_index(c)).collect()
    }

    /// La commune qui représente un département : Paris est à la fois l'un et l'autre.
    pub fn place_of_dept(&self, dept: u16) -> Place {
        if self.depts[usize::from(dept)].code == "75" {
            if let Some(&paris) = self.by_insee.get("75056") {
                return Place::Commune(paris);
            }
        }
        Place::Dept(dept)
    }

    // --- Adresse de l'article ------------------------------------------------------------------------------------------------

    /// Le lieu que l'adresse de l'article dit, selon la convention de l'éditeur (`geo` : voir flux.json).
    fn from_url(&self, geo: &str, url: &str) -> Option<(Place, Method)> {
        let path = url.split_once("://").map_or(url, |(_, rest)| rest).split_once('/').map_or("", |(_, path)| path);
        let path = path.split(['?', '#']).next().unwrap_or("");
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        match geo {
            "actufr" => {
                // `/bretagne/saint-malo_35288/titre_65069638.html` : le code INSEE est collé au nom de la commune.
                let segment = segments.get(1)?;
                let (_, insee) = segment.rsplit_once('_')?;
                let id = *self.by_insee.get(insee)?;
                Some((Place::Commune(id), Method::UrlCommune))
            }
            "france3" | "ici" => {
                // `/région/département/commune/…` : le département est le deuxième segment.
                let segment = segments.get(1)?;
                let dept = if geo == "ici" { self.ici_dept(segment)? } else { *self.dept_by_name.get(key_of(&segment.replace('-', " ")).as_str())? };
                // Le segment suivant est la commune quand son nom est celui d'une commune du département : sinon c'est le titre de l'article.
                if let Some(next) = segments.get(2) {
                    if let Some(&id) = self.in_dept.get(&(dept, key_of(&next.replace('-', " ")).into())) {
                        return Some((Place::Commune(id), Method::UrlCommune));
                    }
                }
                Some((self.place_of_dept(dept), Method::UrlDept))
            }
            _ => None,
        }
    }

    /// `haute-garonne-31`, `corse-du-sud-2a` : le code est en fin de segment.
    fn ici_dept(&self, segment: &str) -> Option<u16> {
        let (_, code) = segment.rsplit_once('-')?;
        if code.len() < 2 || code.len() > 3 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        self.dept_index(&code.to_uppercase())
    }

    // --- Titre -------------------------------------------------------------------------------------------------------------------

    /// Où se passe cet article ? `geo` et `url` : voir `from_url` ; `feed_depts` : les départements du fil, pour départager des homonymes.
    pub fn locate(&self, title: &str, url: &str, geo: &str, feed_depts: &[u16]) -> Option<(Place, Method)> {
        let from_url = self.from_url(geo, url);
        if let Some((place @ Place::Commune(_), method)) = from_url {
            return Some((place, method));
        }
        let url_dept = match from_url {
            Some((Place::Dept(d), _)) => Some(d),
            Some((Place::Commune(c), _)) => Some(self.communes[c as usize].dept),
            None => None,
        };
        let hint: Vec<u16> = url_dept.map(|d| vec![d]).unwrap_or_else(|| feed_depts.to_vec());
        let title_words = words(title);
        if let Some(id) = self.commune_in(&title_words, &hint) {
            return Some((Place::Commune(id), Method::TitleCommune));
        }
        if let Some((place, method)) = from_url {
            return Some((place, method));
        }
        let dept = self.dept_in(&title_words)?;
        Some((self.place_of_dept(dept), Method::TitleDept))
    }

    /// La meilleure commune citée par le titre.
    fn commune_in(&self, w: &[Word], hint: &[u16]) -> Option<u32> {
        let mut taken = vec![false; w.len()];
        let mut best: Option<(i32, u32)> = None;
        // Les noms les plus longs d'abord : « Saint-Denis-de-la-Réunion » avant « Saint-Denis ».
        for len in (1..=MAX_WORDS.min(w.len())).rev() {
            for start in 0..=w.len() - len {
                if taken[start..start + len].iter().any(|&t| t) {
                    continue;
                }
                let span = &w[start..start + len];
                // Ni commençant, ni finissant par un article seul (« de », « la » ne sont pas des noms), sauf « Le/La/Les/L' » en tête.
                if is_article(&span[len - 1].text) && !(len == 1) {
                    continue;
                }
                let key = span.iter().map(|x| x.text.as_str()).collect::<Vec<_>>().join(" ");
                let Some(candidates) = self.by_name.get(key.as_str()) else { continue };
                // Le premier mot qui compte doit avoir une majuscule dans le titre.
                let Some(main) = span.iter().find(|x| !is_article(&x.text)) else { continue };
                if !main.capital {
                    continue;
                }
                // « Haute-Vienne », « Basse-Normandie » : le nom qui suit un tel adjectif n'est pas la commune.
                if start > 0 && matches!(w[start - 1].text.as_str(), "haut" | "haute" | "hautes" | "bas" | "basse" | "basses" | "grand" | "grande" | "petit" | "petite" | "nouveau" | "nouvelle") {
                    continue;
                }
                let context = context_of(w, start, start + len);
                let Some(id) = self.choose(candidates, &key, span, context, hint) else { continue };
                taken[start..start + len].iter_mut().for_each(|t| *t = true);
                let score = match context {
                    Context::Strong => 3,
                    Context::Weak => 1,
                    Context::Bare => 0,
                } * 10
                    + i32::from(hint.contains(&self.communes[id as usize].dept)) * 20
                    + (len as i32).min(4)
                    - (start as i32).min(9) / 3;
                if best.is_none_or(|(s, _)| score > s) {
                    best = Some((score, id));
                }
            }
        }
        best.map(|(_, id)| id)
    }

    /// Parmi des homonymes, la commune retenue, ou aucune si le contexte ne suffit pas.
    fn choose(&self, candidates: &[u32], key: &str, span: &[Word], context: Context, hint: &[u16]) -> Option<u32> {
        let significant = span.iter().filter(|x| !is_article(&x.text)).count();
        let hinted: Vec<u32> = candidates.iter().copied().filter(|&c| hint.contains(&self.communes[c as usize].dept)).collect();
        // Un nom qui est aussi celui d'un département (« l'Indre », « la Marne ») est le département, sauf indice contraire.
        if hinted.is_empty() && key != "paris" && self.dept_by_name.contains_key(key) {
            return None;
        }
        // Un fil ou une adresse qui dit où l'on est : une commune d'ailleurs n'est prise que si c'est une vraie ville
        // (« à Paris » dans un fil d'Occitanie), pas un petit homonyme (« l'Union Départementale » n'est pas L'Union).
        if hinted.is_empty() && !hint.is_empty() && candidates.iter().map(|&c| self.communes[c as usize].pop).max().unwrap_or(0) < BIG {
            return None;
        }
        let pool: &[u32] = if hinted.is_empty() { candidates } else { &hinted };
        let top = *pool.iter().max_by_key(|&&c| self.communes[c as usize].pop)?;
        let pop = self.communes[top as usize].pop;
        if hinted.is_empty() {
            // Sans indice de département : un nom unique, ou de loin le plus peuplé.
            if pool.len() > 1 {
                let second = pool.iter().filter(|&&c| c != top).map(|&c| self.communes[c as usize].pop).max().unwrap_or(0);
                if pop < 3000 || pop < DOMINANCE * second {
                    return None;
                }
            }
        }
        let common = significant == 1 && COMMON.contains(&span.iter().find(|x| !is_article(&x.text))?.text.as_str());
        let accepted = if common {
            // Un mot courant : il faut « à X » ou « X : » ET un indice (département du fil, ou une vraie ville).
            context == Context::Strong && (!hinted.is_empty() || pop >= 3000)
        } else if significant == 1 {
            match context {
                Context::Strong => !hinted.is_empty() || pop >= 1000,
                Context::Weak => !hinted.is_empty() && pop >= 1000 || pop >= 5000,
                Context::Bare => !hinted.is_empty() && pop >= 2000 || pop >= BIG,
            }
        } else {
            // Un nom de plusieurs mots (« Saint-Brieuc », « Le Havre » est à un mot) : rarement autre chose qu'un lieu.
            !hinted.is_empty() || pop >= 1000 || context == Context::Strong
        };
        let _ = key;
        accepted.then_some(top)
    }

    /// Le département nommé par le titre.
    fn dept_in(&self, w: &[Word]) -> Option<u16> {
        let mut best: Option<(u8, u16)> = None;
        for len in (1..=5.min(w.len())).rev() {
            for start in 0..=w.len() - len {
                let span = &w[start..start + len];
                let key = span.iter().map(|x| x.text.as_str()).collect::<Vec<_>>().join(" ");
                let Some(&dept) = self.dept_by_name.get(key.as_str()) else { continue };
                if !span.iter().find(|x| !is_article(&x.text)).is_some_and(|x| x.capital) {
                    continue;
                }
                let context = context_of(w, start, start + len);
                // « du Nord », « le Var » : seuls les noms de plusieurs mots passent sans « dans », « en » ou un titre qui les ouvre.
                let ok = context == Context::Strong || (context == Context::Weak && len > 1);
                if !ok {
                    continue;
                }
                let score = (context as u8) * 4 + len as u8;
                if best.is_none_or(|(s, _)| score > s) {
                    best = Some((score, dept));
                }
            }
        }
        best.map(|(_, d)| d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une mini-liste : de quoi tester chaque règle sans les 35 000 communes.
    fn gazetteer() -> Gazetteer {
        let mut rows = String::from("[");
        let mut add = |nom: &str, code: &str, dept: &str, pop: u32| {
            rows.push_str(&format!(r#"{{"nom":"{nom}","code":"{code}","codeDepartement":"{dept}","centre":{{"type":"Point","coordinates":[2.0,47.0]}},"population":{pop}}},"#));
        };
        add("Rennes", "35238", "35", 220_000);
        add("Saint-Brieuc", "22278", "22", 44_000);
        add("Saint-Denis", "97411", "974", 150_000);
        add("Saint-Denis", "93066", "93", 110_000);
        add("Saint-Denis", "11339", "11", 523);
        add("Saint-Denis-de-la-Réunion", "97499", "974", 10);
        add("Le Havre", "76351", "76", 170_000);
        add("Laval", "53130", "53", 50_000);
        add("Laval", "38200", "38", 1_000);
        add("Bar", "19020", "19", 300);
        add("Plan", "38300", "38", 100);
        add("Vue", "44200", "44", 2_000);
        add("Orange", "84087", "84", 29_000);
        add("Trans", "53270", "53", 400);
        add("Paris", "75056", "75", 2_100_000);
        add("L'Isle-Adam", "95313", "95", 12_000);
        add("Toulouse", "31555", "31", 500_000);
        add("Vienne", "38544", "38", 29_000);
        add("Indre", "44074", "44", 4_000);
        add("L'Union", "31560", "31", 12_000);
        add("Bordeaux", "33063", "33", 260_000);
        add("Les Sables-d'Olonne", "85194", "85", 45_000);
        for i in 0..30_000 {
            add(&format!("Zzz{i}"), &format!("9{i:04}"), "01", 5);
        }
        rows.pop();
        rows.push(']');
        Gazetteer::from_json(rows.as_bytes()).unwrap()
    }

    fn place(g: &Gazetteer, title: &str, geo: &str, url: &str, feed: &[&str]) -> Option<String> {
        let feed: Vec<u16> = feed.iter().filter_map(|c| g.dept_index(c)).collect();
        g.locate(title, url, geo, &feed).map(|(p, m)| match p {
            Place::Commune(c) => format!("{}/{:?}", g.communes[c as usize].name, m),
            Place::Dept(d) => format!("{}/{:?}", g.depts[usize::from(d)].name, m),
        })
    }

    fn title(g: &Gazetteer, t: &str, feed: &[&str]) -> Option<String> {
        place(g, t, "aucune", "https://exemple.fr/x", feed)
    }

    #[test]
    fn normalizes_accents_saint_and_contractions() {
        assert_eq!(key_of("Saint-Étienne-du-Rouvray"), "st etienne de le rouvray");
        assert_eq!(key_of("St Étienne du Rouvray"), "st etienne de le rouvray");
        assert_eq!(key_of("L’Isle-Adam"), "l isle adam");
        assert_eq!(key_of("aux Sables-d'Olonne"), "a les sables d olonne");
    }

    #[test]
    fn finds_a_commune_after_a_preposition_and_with_articles() {
        let g = gazetteer();
        assert_eq!(title(&g, "Un homme blessé à Rennes", &[]).as_deref(), Some("Rennes/TitleCommune"));
        assert_eq!(title(&g, "Le port du Havre bloqué", &[]).as_deref(), Some("Le Havre/TitleCommune"));
        assert_eq!(title(&g, "Incendie au Havre : trois blessés", &[]).as_deref(), Some("Le Havre/TitleCommune"));
        assert_eq!(title(&g, "Incendie à l'Isle-Adam", &[]).as_deref(), Some("L'Isle-Adam/TitleCommune"));
        assert_eq!(title(&g, "Fête foraine aux Sables-d'Olonne", &[]).as_deref(), Some("Les Sables-d'Olonne/TitleCommune"));
        assert_eq!(title(&g, "St Brieuc : le maire démissionne", &[]).as_deref(), Some("Saint-Brieuc/TitleCommune"));
    }

    #[test]
    fn needs_a_capital_and_ignores_common_words() {
        let g = gazetteer();
        assert_eq!(title(&g, "Un bar ouvert à la nuit, une vue superbe, un plan d'urgence", &["19", "44", "38"]), None);
        assert_eq!(title(&g, "Plan d'urgence pour les hôpitaux", &["38"]), None);
        assert_eq!(title(&g, "Orange annonce la fermeture de boutiques", &["84"]), None);
        assert_eq!(title(&g, "Une panne à Orange", &["84"]).as_deref(), Some("Orange/TitleCommune"));
        // Un petit village du fil, avec un indice net.
        assert_eq!(title(&g, "Une grosse frayeur : le village de Trans frappé par le vent", &["53"]).as_deref(), Some("Trans/TitleCommune"));
        assert_eq!(title(&g, "Trans est un nom court", &[]), None);
    }

    #[test]
    fn picks_the_homonym_from_the_feed_department_or_the_dominant_one() {
        let g = gazetteer();
        assert_eq!(title(&g, "Un blessé à Laval", &["53"]).as_deref(), Some("Laval/TitleCommune"));
        assert_eq!(title(&g, "Un blessé à Laval", &[]).as_deref(), Some("Laval/TitleCommune"), "50 000 contre 1 000 : de loin la plus peuplée");
        assert_eq!(title(&g, "Un blessé à Saint-Denis", &[]), None, "deux grandes communes : ambigu sans indice");
        assert_eq!(title(&g, "Un blessé à Saint-Denis", &["93"]).as_deref(), Some("Saint-Denis/TitleCommune"));
        let (p, _) = g.locate("Un blessé à Saint-Denis", "", "aucune", &[g.dept_index("974").unwrap()]).unwrap();
        assert!(matches!(p, Place::Commune(c) if &*g.communes[c as usize].insee == "97411"));
        // Le plus long nom l'emporte.
        let (p, _) = g.locate("Visite à Saint-Denis-de-la-Réunion", "", "aucune", &[]).unwrap();
        assert!(matches!(p, Place::Commune(c) if &*g.communes[c as usize].insee == "97499"));
    }

    #[test]
    fn a_department_or_an_organisation_is_not_a_homonymous_commune() {
        let g = gazetteer();
        // « Haute-Vienne » n'est pas Vienne (Isère) ; « l'Indre » est le département, pas la commune de Loire-Atlantique.
        assert_eq!(title(&g, "Ça baisse : en Haute-Vienne, les Restos du Cœur lancent leur campagne", &["87"]).as_deref(), Some("Haute-Vienne/TitleDept"));
        assert_eq!(title(&g, "La pauvreté a atteint un niveau historique dans l'Indre et le Cher", &["18", "36"]).as_deref(), Some("Indre/TitleDept"));
        assert_eq!(title(&g, "Une responsable à l'Union Départementale des Associations", &["24"]), None);
    }

    #[test]
    fn falls_back_to_the_department_named_in_the_title() {
        let g = gazetteer();
        assert_eq!(title(&g, "Ille-et-Vilaine. Une récolte exceptionnelle", &[]).as_deref(), Some("Ille-et-Vilaine/TitleDept"));
        assert_eq!(title(&g, "Tempête dans le Var, des dégâts", &[]).as_deref(), Some("Var/TitleDept"));
        assert_eq!(title(&g, "Le var est un mot, le nord aussi", &[]), None);
        assert_eq!(title(&g, "Pas de lieu du tout dans ce titre", &["53"]), None);
        // Paris est une commune ET un département : une seule place.
        assert_eq!(title(&g, "Grève à Paris", &[]).as_deref(), Some("Paris/TitleCommune"));
    }

    #[test]
    fn the_article_address_beats_the_title() {
        let g = gazetteer();
        assert_eq!(
            place(&g, "Un titre sans lieu", "ici", "https://www.ici.fr/bretagne/ille-et-vilaine-35/rennes/un-titre-1234?at_medium=lien_RSS", &[]).as_deref(),
            Some("Rennes/UrlCommune")
        );
        assert_eq!(
            place(&g, "Un titre sans lieu", "france3", "https://france3-regions.franceinfo.fr/bretagne/cotes-d-armor/saint-brieuc/un-titre-12.html", &[]).as_deref(),
            Some("Saint-Brieuc/UrlCommune")
        );
        assert_eq!(
            place(&g, "Un titre sans lieu", "actufr", "https://actu.fr/normandie/le-havre_76351/un-titre_65069638.html", &[]).as_deref(),
            Some("Le Havre/UrlCommune")
        );
        // Département seul : l'adresse n'a pas de commune connue ; le titre, s'il en cite une du même département, la précise.
        assert_eq!(
            place(&g, "Un titre sans lieu", "ici", "https://www.ici.fr/pays-de-la-loire/mayenne-53/le-titre-de-l-article-99", &[]).as_deref(),
            Some("Mayenne/UrlDept")
        );
        assert_eq!(
            place(&g, "Coup de vent à Trans", "ici", "https://www.ici.fr/pays-de-la-loire/mayenne-53/le-titre-de-l-article-99", &[]).as_deref(),
            Some("Trans/TitleCommune")
        );
        // Une émission nationale : l'adresse n'en dit rien.
        assert_eq!(place(&g, "Consultation « Dites-le ICI »", "ici", "https://www.ici.fr/emissions/les-infos-d-ici/consultation-1", &["53"]), None);
    }
}
