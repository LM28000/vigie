//! Événements publics du jour et des 30 prochains jours (fêtes, marchés, concerts, spectacles, expositions, salons,
//! sport, patrimoine…), rassemblés de trois sources ouvertes et rangés dans un format commun.
//!
//! # Sources
//!
//! 1. **DATAtourisme** (base nationale des offices de tourisme, Licence Ouverte 2.0), de deux façons :
//!    - **sans clé** : l'export CSV « fêtes et manifestations » (`datatourisme-fma.csv`, 50 Mo, mis à jour chaque jour sur
//!      data.gouv.fr), lu en continu, qui donne les dates (sans horaires) ;
//!    - **avec le flux de l'utilisateur** (`DATATOURISME_FLUX_URL`, secrète : elle contient une clé) : un ZIP de fichiers
//!      JSON-LD (un objet par fichier) ou un JSON-LD unique, qui donne en plus les horaires, les tarifs et les lieux.
//!      Quand elle est définie, le flux remplace l'export CSV.
//! 2. **« Que faire à Paris »** (opendata.paris.fr, Opendatasoft, sans clé, licence ODbL) : environ 3 000 événements.
//! 3. **OpenAgenda** (agendas publics, via le jeu Opendatasoft « evenements-publics-openagenda », sans clé, Licence
//!    Ouverte 1.0) : environ 20 000 événements par mois, toute la France.
//!
//! # Mémoire
//!
//! Aucun fichier n'est chargé en entier : chaque source est téléchargée sur le disque puis lue **en continu** (flux JSON
//! ou CSV, une entrée de ZIP à la fois), et seuls les événements qui ont lieu dans la fenêtre (de 36 h avant à 31 jours
//! après maintenant) sont gardés, en champs compacts. Chaque source est rangée dans `DATA_DIR/evenements/<source>.json.gz`
//! (relue au démarrage) ; la fusion (dédoublonnage : même titre normalisé, même jour, moins de 300 m) se fait en mémoire
//! sur ces trois jeux, puis la liste servie est gardée **compressée**.
//!
//! # API
//!
//! `GET /api/evenements` : `{ "updatedAt", "sources": [{ nom, licence, url }…], "events": [[id, lon, lat, catégorie, source,
//! drapeaux, titre, commune, [début, fin, …]]…] }` (instants en minutes depuis 1970 ; drapeaux : 1 longue durée, 2 gratuit,
//! 4 payant) ; `GET /api/evenements/fiche?id=…` : le détail d'un événement (lieu, adresse, tarif, description, lien).
//! Contenu : uniquement des événements publics ; ceux qui relèvent du contenu adulte sont écartés (`adult`).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::extract::Query;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde::de::{DeserializeOwned, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

/// De 36 h avant maintenant à 31 jours après : la fenêtre des événements gardés.
const BACK_S: i64 = 36 * 3600;
const AHEAD_S: i64 = 31 * 24 * 3600;
/// Au-delà de 45 jours d'affilée (expositions permanentes, activités à l'année), un événement est « de longue durée ».
const LONG_S: i64 = 45 * 24 * 3600;
const MAX_SPANS: usize = 40;
const MAX_DOWNLOAD_BYTES: u64 = 600 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;

/// Export CSV « fêtes et manifestations » de DATAtourisme sur data.gouv.fr (adresse stable, le fichier est remplacé chaque jour).
const DATATOURISME_CSV_URL: &str = "https://www.data.gouv.fr/api/1/datasets/r/2c6023f2-ffce-4c1a-9728-bdc020e463b5";
const PARIS_URL: &str = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/que-faire-a-paris-/exports/json";
const OPENAGENDA_URL: &str = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/exports/json";

/// Source : nom, licence, adresse. L'ordre est celui de priorité au dédoublonnage et celui des codes `src`.
const SOURCES: [(&str, &str, &str); 3] = [
    ("Que faire à Paris (Ville de Paris)", "ODbL", "https://opendata.paris.fr/explore/dataset/que-faire-a-paris-/"),
    ("DATAtourisme (offices de tourisme)", "Licence Ouverte 2.0", "https://www.datatourisme.fr/"),
    ("OpenAgenda (agendas publics)", "Licence Ouverte 1.0", "https://openagenda.com/"),
];
const SRC_PARIS: u8 = 0;
const SRC_TOURISM: u8 = 1;
const SRC_AGENDA: u8 = 2;
/// Nom de fichier de chaque source dans `DATA_DIR/evenements/`.
const CACHE_NAMES: [&str; 3] = ["paris", "datatourisme", "openagenda"];
/// Rafraîchissement de chaque source : Paris et OpenAgenda changent dans la journée, DATAtourisme une fois par jour.
const REFRESH: [Duration; 3] = [Duration::from_secs(3 * 3600), Duration::from_secs(20 * 3600), Duration::from_secs(6 * 3600)];
const RETRY_AFTER: Duration = Duration::from_secs(45 * 60);
const TICK: Duration = Duration::from_secs(15 * 60);

/// Catégories d'affichage (même ordre côté site, `web/src/modules/evenements.ts`).
pub const CATEGORIES: [&str; 8] =
    ["Musique", "Spectacle", "Exposition", "Fête et festival", "Marché et brocante", "Sport", "Patrimoine et visite", "Rencontre et autre"];

/// Un événement, réduit à ce que la carte affiche et à ce que la fiche dit.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Event {
    pub id: u64,
    pub lon: f64,
    pub lat: f64,
    pub cat: u8,
    pub src: u8,
    pub title: String,
    pub commune: String,
    pub place: String,
    pub address: String,
    /// Moments où il a lieu : (début, fin) en secondes depuis 1970, dans la fenêtre, triés, sans chevauchement.
    pub spans: Vec<(i64, i64)>,
    pub long: bool,
    /// 0 inconnu, 1 gratuit, 2 payant, 3 gratuit sous condition.
    pub price: u8,
    pub price_text: String,
    pub description: String,
    pub url: String,
}

// --- Ce que sert l'API ------------------------------------------------------------------------------------------------

/// Liste prête à servir (JSON compressé en gzip) et détails, triés par identifiant.
struct Published {
    list: Bytes,
    events: Vec<Event>,
}

static PUBLISHED: RwLock<Option<Arc<Published>>> = RwLock::new(None);

fn published() -> Option<Arc<Published>> {
    PUBLISHED.read().expect("verrou des événements").clone()
}

/// `GET /api/evenements`.
pub fn response() -> Response {
    match published() {
        Some(p) => ([(header::CONTENT_TYPE, "application/json"), (header::CONTENT_ENCODING, "gzip")], p.list.clone()).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "événements : première collecte en cours").into_response(),
    }
}

#[derive(Deserialize)]
pub struct DetailQuery {
    id: u64,
}

/// `GET /api/evenements/fiche?id=…`.
pub async fn detail(Query(query): Query<DetailQuery>) -> Response {
    let Some(p) = published() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "événements : première collecte en cours").into_response();
    };
    match p.events.binary_search_by_key(&query.id, |e| e.id) {
        Ok(i) => {
            let e = &p.events[i];
            let (name, licence, url) = SOURCES[usize::from(e.src)];
            axum::Json(json!({
                "place": e.place, "address": e.address, "price": e.price, "priceText": e.price_text,
                "description": e.description, "url": e.url, "source": name, "licence": licence, "sourceUrl": url,
            }))
            .into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "événement inconnu (la liste a peut-être changé)").into_response(),
    }
}

/// Un événement proche, pour les zones surveillées (`synthese/veille.rs`).
pub struct Soon {
    pub id: u64,
    pub title: String,
    pub detail: String,
    pub lon: f64,
    pub lat: f64,
    pub start: i64,
}

/// Les événements qui commencent dans les `hours` heures, ou ont commencé il y a moins d'une heure : ni les longues
/// durées ni ceux de toute la journée. `None` tant que la première collecte n'est pas faite.
pub fn starting_soon(now: i64, hours: i64) -> Option<Vec<Soon>> {
    let p = published()?;
    let mut out = Vec::new();
    for e in &p.events {
        if e.long {
            continue;
        }
        let Some(&(start, end)) = e.spans.iter().find(|&&(s, en)| en > now && s < now + hours * 3600 && en - s < 20 * 3600 && s > now - 3600) else { continue };
        let hm = paris_hm(start);
        out.push(Soon {
            id: e.id,
            title: e.title.clone(),
            detail: format!("{} · {}{}", CATEGORIES[usize::from(e.cat)], if e.commune.is_empty() { String::new() } else { format!("{} · ", e.commune) }, if end > start { format!("à {hm}") } else { hm }),
            lon: e.lon,
            lat: e.lat,
            start,
        });
    }
    Some(out)
}

fn paris_hm(seconds: i64) -> String {
    let zone = paris();
    Timestamp::from_second(seconds)
        .map(|t| {
            let z = t.to_zoned(zone);
            format!("{:02}:{:02}", z.hour(), z.minute())
        })
        .unwrap_or_default()
}

// --- Fenêtre, instants, textes ----------------------------------------------------------------------------------------

fn paris() -> TimeZone {
    TimeZone::get("Europe/Paris").unwrap_or(TimeZone::UTC)
}

#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub from: i64,
    pub to: i64,
}

impl Window {
    pub fn at(now: i64) -> Self {
        Self { from: now - BACK_S, to: now + AHEAD_S }
    }
}

/// Début du jour (heure de Paris) et début du lendemain, en secondes.
fn day_bounds(date: Date) -> Option<(i64, i64)> {
    let tz = paris();
    let start = date.to_zoned(tz.clone()).ok()?.timestamp().as_second();
    let end = date.tomorrow().ok()?.to_zoned(tz).ok()?.timestamp().as_second();
    Some((start, end))
}

/// « 2026-11-18 » (ou le début d'un horodatage) → jour.
fn parse_date(text: &str) -> Option<Date> {
    text.trim().get(..10)?.parse().ok()
}

/// Jour et heure (« 20:00:00 », « 20:00 ») de Paris → secondes.
fn at_time(date: Date, time: &str) -> Option<i64> {
    let mut parts = time.trim().split(':');
    let h: i8 = parts.next()?.parse().ok()?;
    let m: i8 = parts.next().and_then(|m| m.parse().ok()).unwrap_or(0);
    let s: i8 = parts.next().and_then(|s| s.get(..2).unwrap_or(s).parse().ok()).unwrap_or(0);
    Some(date.at(h, m, s, 0).to_zoned(paris()).ok()?.timestamp().as_second())
}

fn parse_instant(text: &str) -> Option<i64> {
    text.trim().parse::<Timestamp>().ok().map(Timestamp::as_second)
}

/// Garde ce qui tombe dans la fenêtre (rogné), trie et fusionne ce qui se touche. Renvoie les moments et « longue durée ».
pub fn finish(spans: Vec<(i64, i64)>, window: Window) -> Option<(Vec<(i64, i64)>, bool)> {
    let long = spans.iter().any(|&(s, e)| e - s > LONG_S);
    let mut kept: Vec<(i64, i64)> = spans
        .into_iter()
        .filter(|&(s, e)| e > s && e > window.from && s < window.to)
        .map(|(s, e)| (s.max(window.from), e.min(window.to)))
        .collect();
    kept.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (s, e) in kept {
        match merged.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    merged.truncate(MAX_SPANS);
    (!merged.is_empty()).then_some((merged, long))
}

/// Minuscules, sans accents, lettres et chiffres séparés par une espace.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        let mapped = match c {
            'à' | 'â' | 'ä' | 'á' | 'ã' => "a",
            'é' | 'è' | 'ê' | 'ë' => "e",
            'î' | 'ï' | 'í' => "i",
            'ô' | 'ö' | 'ó' | 'õ' => "o",
            'ù' | 'û' | 'ü' | 'ú' => "u",
            'ç' => "c",
            'ñ' => "n",
            'œ' => "oe",
            'æ' => "ae",
            c if c.is_alphanumeric() => {
                out.push(c);
                continue;
            }
            _ => " ",
        };
        out.push_str(mapped);
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Retire les balises HTML, décode quelques entités, réduit les espaces.
pub fn strip_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if in_tag => {}
            c => out.push(c),
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&rsquo;", "’")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn truncate(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    let cut: String = text.chars().take(max).collect();
    let cut = cut.rsplit_once(' ').filter(|(head, _)| head.chars().count() > max / 2).map_or(cut.as_str(), |(head, _)| head);
    format!("{}…", cut.trim_end_matches([' ', ',', ';', ':', '.', '-']))
}

/// Contenu adulte : écarté (la carte ne montre que des événements publics tout public).
pub fn adult(folded: &str) -> bool {
    const WORDS: [&str; 18] = [
        "erotique", "erotisme", "libertin", "libertine", "porno", "pornographique", "striptease", "strip tease", "sexshop", "sex shop", "bdsm",
        "fetichiste", "echangiste", "swinger", "gang bang", "soiree coquine", "xxx", "sexe",
    ];
    let padded = format!(" {folded} ");
    WORDS.iter().any(|w| padded.contains(&format!(" {w} ")) || (w.len() > 6 && padded.contains(&format!(" {w}"))))
}

/// Catégorie d'après un texte (titre, étiquettes) déjà passé par `fold` : le premier groupe de mots qui correspond l'emporte.
pub fn classify_text(folded: &str) -> u8 {
    const GROUPS: [(u8, &[&str]); 7] = [
        (4, &["marche", "brocante", "vide grenier", "vide dressing", "braderie", "foire", "bourse aux", "puces"]),
        (5, &["sport", "match", "tournoi", "trail", "marathon", "foot", "rugby", "basket", "handball", "tennis", "natation", "randonn", "cyclo", "velo", "judo", "karate", "boxe", "escalade", "course", "competition"]),
        (0, &["concert", "musique", "musical", "jazz", "rock", "opera", "orchestre", "choeur", "chorale", "recital", "electro", "rap", "symphon", "classique", "fanfare", "chanson", "blues", "dj"]),
        (1, &["spectacle", "theatre", "danse", "cirque", "humour", "comedie", "marionnette", "magie", "conte", "cinema", "film", "projection", "improvisation", "clown", "stand up", "cabaret", "ballet", "lecture"]),
        (2, &["expo", "exposition", "vernissage", "galerie", "photograph", "peinture", "sculpture", "art contemporain", "street art"]),
        (6, &["visite", "patrimoine", "balade", "promenade", "circuit", "decouverte", "histoire", "archeolog", "chateau", "abbaye", "eglise", "monument", "guidee"]),
        (3, &["fete", "festival", "carnaval", "defile", "parade", "feu d artifice", "noel", "reveillon", "bal", "kermesse", "ducasse", "celebration", "commemoration", "animation", "illumination"]),
    ];
    let padded = format!(" {folded}");
    for (cat, stems) in GROUPS {
        if stems.iter().any(|stem| padded.contains(&format!(" {stem}"))) {
            return cat;
        }
    }
    7
}

/// FNV-1a sur 52 bits (un nombre que JSON et JavaScript représentent exactement).
pub fn hash_id(source: u8, key: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ u64::from(source);
    for b in key.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h & ((1 << 52) - 1)
}

fn plausible(lon: f64, lat: f64) -> bool {
    lon.is_finite() && lat.is_finite() && (lat != 0.0 || lon != 0.0) && (-62.0..=60.0).contains(&lon) && (-30.0..=52.0).contains(&lat)
}

// --- Lecture en continu d'un JSON ---------------------------------------------------------------------------------------

/// Appelle `f` pour chaque élément d'un tableau JSON placé à la racine, ou dans la clé `@graph` d'un objet (JSON-LD), sans
/// jamais garder plus d'un élément en mémoire.
struct Each<'a, T, F: FnMut(T)>(&'a mut F, PhantomData<T>);

impl<'de, T: Deserialize<'de>, F: FnMut(T)> DeserializeSeed<'de> for Each<'_, T, F> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de, T: Deserialize<'de>, F: FnMut(T)> Visitor<'de> for Each<'_, T, F> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("un tableau JSON ou un objet JSON-LD avec @graph")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(item) = seq.next_element::<T>()? {
            (self.0)(item);
        }
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(key) = map.next_key::<String>()? {
            if key == "@graph" {
                map.next_value_seed(Each::<T, F>(&mut *self.0, PhantomData))?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(())
    }
}

pub fn for_each_json<T: DeserializeOwned, R: Read>(reader: R, mut f: impl FnMut(T)) -> Result<()> {
    let mut de = serde_json::Deserializer::from_reader(reader);
    Each::<T, _>(&mut f, PhantomData).deserialize(&mut de).context("JSON illisible")?;
    Ok(())
}

// --- « Que faire à Paris » -----------------------------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct LatLon {
    lat: Option<f64>,
    lon: Option<f64>,
}

#[derive(Deserialize, Default)]
struct ParisRecord {
    #[serde(default)]
    id: String,
    title: Option<String>,
    lead_text: Option<String>,
    url: Option<String>,
    date_start: Option<String>,
    date_end: Option<String>,
    occurrences: Option<String>,
    address_name: Option<String>,
    address_street: Option<String>,
    address_zipcode: Option<String>,
    address_city: Option<String>,
    lat_lon: Option<LatLon>,
    price_type: Option<String>,
    price_detail: Option<String>,
    qfap_tags: Option<String>,
}

fn paris_event(r: ParisRecord, window: Window) -> Option<Event> {
    let title = strip_html(r.title.as_deref()?);
    let ll = r.lat_lon?;
    let (lon, lat) = (ll.lon?, ll.lat?);
    if title.is_empty() || !plausible(lon, lat) {
        return None;
    }
    let mut spans: Vec<(i64, i64)> = Vec::new();
    if let Some(occ) = r.occurrences.as_deref() {
        for part in occ.split(';') {
            if let Some((a, b)) = part.split_once('_')
                && let (Some(s), Some(e)) = (parse_instant(a), parse_instant(b))
            {
                spans.push((s, e));
            }
        }
    }
    if spans.is_empty()
        && let (Some(s), Some(e)) = (r.date_start.as_deref().and_then(parse_instant), r.date_end.as_deref().and_then(parse_instant))
    {
        spans.push((s, e));
    }
    let (spans, long) = finish(spans, window)?;
    let description = truncate(&strip_html(r.lead_text.as_deref().unwrap_or("")), 280);
    let tags = r.qfap_tags.unwrap_or_default();
    let folded = fold(&format!("{title} {tags} {description}"));
    if adult(&folded) {
        return None;
    }
    let price = match r.price_type.as_deref() {
        Some("gratuit") => 1,
        Some("payant") => 2,
        Some("gratuit sous condition") => 3,
        _ => 0,
    };
    let street = r.address_street.unwrap_or_default();
    let city = r.address_city.unwrap_or_default();
    let zip = r.address_zipcode.unwrap_or_default();
    Some(Event {
        id: hash_id(SRC_PARIS, &r.id),
        lon,
        lat,
        cat: classify_text(&fold(&format!("{tags} {title}"))),
        src: SRC_PARIS,
        title: truncate(&title, 110),
        commune: city.clone(),
        place: truncate(r.address_name.as_deref().unwrap_or(""), 80),
        address: [street, format!("{zip} {city}").trim().to_string()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
        spans,
        long,
        price,
        price_text: truncate(&strip_html(r.price_detail.as_deref().unwrap_or("")), 140),
        description,
        url: r.url.unwrap_or_default(),
    })
}

pub fn parse_paris<R: Read>(reader: R, window: Window) -> Result<Vec<Event>> {
    let mut out = Vec::new();
    for_each_json::<ParisRecord, _>(reader, |r| {
        if let Some(e) = paris_event(r, window) {
            out.push(e);
        }
    })?;
    Ok(out)
}

// --- OpenAgenda (jeu Opendatasoft) ---------------------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct AgendaRecord {
    #[serde(default)]
    uid: String,
    title_fr: Option<String>,
    description_fr: Option<String>,
    keywords_fr: Option<Value>,
    conditions_fr: Option<String>,
    canonicalurl: Option<String>,
    firstdate_begin: Option<String>,
    lastdate_end: Option<String>,
    timings: Option<String>,
    location_name: Option<String>,
    location_address: Option<String>,
    location_city: Option<String>,
    location_coordinates: Option<LatLon>,
    status: Option<String>,
    attendancemode: Option<String>,
}

#[derive(Deserialize)]
struct Timing {
    begin: String,
    end: String,
}

/// Le `id` d'un champ Opendatasoft qui contient un objet JSON écrit en texte (`{"id": 1, "label": {...}}`).
fn embedded_id(text: Option<&str>) -> Option<i64> {
    serde_json::from_str::<Value>(text?).ok()?.get("id")?.as_i64()
}

fn agenda_event(r: AgendaRecord, window: Window) -> Option<Event> {
    // Annulé (6), reporté (4) ou en ligne seulement (2) : pas un rendez-vous sur place.
    if matches!(embedded_id(r.status.as_deref()), Some(4 | 6)) || embedded_id(r.attendancemode.as_deref()) == Some(2) {
        return None;
    }
    let url = r.canonicalurl.unwrap_or_default();
    // Les agendas de recrutement de France Travail ne sont pas des événements à voir sur une carte.
    if url.contains("/francetravail/") || url.contains("/pole-emploi") {
        return None;
    }
    let title = strip_html(r.title_fr.as_deref()?);
    let ll = r.location_coordinates?;
    let (lon, lat) = (ll.lon?, ll.lat?);
    if title.is_empty() || !plausible(lon, lat) {
        return None;
    }
    let keywords: Vec<String> = match r.keywords_fr {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        Some(Value::String(s)) => s.split(',').map(str::to_string).collect(),
        _ => Vec::new(),
    };
    let folded_keywords = fold(&keywords.join(" "));
    if ["recrutement", "emploi", "insertion", "permanence", "reunion d information"].iter().any(|w| folded_keywords.contains(w)) {
        return None;
    }
    let mut spans: Vec<(i64, i64)> = Vec::new();
    if let Some(timings) = r.timings.as_deref().and_then(|t| serde_json::from_str::<Vec<Timing>>(t).ok()) {
        spans.extend(timings.iter().filter_map(|t| Some((parse_instant(&t.begin)?, parse_instant(&t.end)?))));
    }
    if spans.is_empty()
        && let (Some(s), Some(e)) = (r.firstdate_begin.as_deref().and_then(parse_instant), r.lastdate_end.as_deref().and_then(parse_instant))
    {
        spans.push((s, e));
    }
    let (spans, long) = finish(spans, window)?;
    let description = truncate(&strip_html(r.description_fr.as_deref().unwrap_or("")), 280);
    let folded = fold(&format!("{title} {} {description}", keywords.join(" ")));
    if adult(&folded) {
        return None;
    }
    let conditions = strip_html(r.conditions_fr.as_deref().unwrap_or(""));
    let folded_conditions = fold(&conditions);
    let price = if folded_conditions.contains("gratuit") || folded_conditions.contains("entree libre") { 1 } else { 0 };
    let city = r.location_city.unwrap_or_default();
    Some(Event {
        id: hash_id(SRC_AGENDA, &r.uid),
        lon,
        lat,
        cat: classify_text(&fold(&format!("{} {title}", keywords.join(" ")))),
        src: SRC_AGENDA,
        title: truncate(&title, 110),
        commune: city,
        place: truncate(r.location_name.as_deref().unwrap_or(""), 80),
        address: truncate(r.location_address.as_deref().unwrap_or(""), 120),
        spans,
        long,
        price,
        price_text: truncate(&conditions, 140),
        description,
        url,
    })
}

pub fn parse_openagenda<R: Read>(reader: R, window: Window) -> Result<Vec<Event>> {
    let mut out = Vec::new();
    for_each_json::<AgendaRecord, _>(reader, |r| {
        if let Some(e) = agenda_event(r, window) {
            out.push(e);
        }
    })?;
    Ok(out)
}

// --- DATAtourisme : export CSV ---------------------------------------------------------------------------------------------

/// Catégorie d'après les types de l'ontologie DATAtourisme (`CulturalEvent`, `Concert`…), puis d'après le titre.
fn category_of_types(types: &[&str], title_folded: &str) -> u8 {
    let has = |names: &[&str]| types.iter().any(|t| names.contains(t));
    if has(&["Market", "SaleEvent", "GarageSale", "BricABrac", "FairOrShow"]) {
        4
    } else if has(&["Concert", "MusicEvent", "Opera"]) {
        0
    } else if has(&["ShowEvent", "TheaterEvent", "ScreeningEvent", "Cirque", "DanceEvent", "Reading"]) {
        1
    } else if has(&["Exhibition", "VisualArtsEvent", "ArtistSigning"]) {
        2
    } else if has(&["SportsEvent", "SportsCompetition", "Rambling", "Rally"]) {
        5
    } else if has(&["Visit", "OpenDay", "TechnicalHeritage", "NaturalHeritage", "CulturalSite"]) {
        6
    } else if has(&["Festival", "TraditionalCelebration", "Carnival", "Parade", "LocalAnimation", "Commemoration", "Harvest", "Tasting"]) {
        3
    } else {
        // `CulturalEvent` et `SocialEvent` ne disent pas grand-chose : le titre décide, sinon « fête » pour un événement social.
        match classify_text(title_folded) {
            7 if has(&["SocialEvent"]) => 3,
            c => c,
        }
    }
}

fn type_names(list: &str) -> Vec<&str> {
    list.split('|').map(|t| t.rsplit(['#', '/']).next().unwrap_or(t)).collect()
}

/// Première adresse web d'une liste de contacts (`#https://…<>https://…`).
fn first_link(contacts: &str) -> Option<&str> {
    contacts.split(['#', '|']).flat_map(|p| p.split("<>")).map(str::trim).find(|p| p.starts_with("http"))
}

/// Les périodes `2026-11-01<->2026-12-31|2027-01-01<->2027-01-05` (jours entiers, en heure de Paris).
fn csv_spans(periods: &str) -> Vec<(i64, i64)> {
    periods
        .split('|')
        .filter_map(|p| {
            let (a, b) = p.split_once("<->")?;
            let (start, _) = day_bounds(parse_date(a)?)?;
            let (_, end) = day_bounds(parse_date(b)?)?;
            Some((start, end))
        })
        .collect()
}

pub fn parse_datatourisme_csv<R: Read>(reader: R, window: Window) -> Result<Vec<Event>> {
    let mut csv = csv::ReaderBuilder::new().flexible(true).from_reader(reader);
    let headers = csv.headers()?.clone();
    let column = |name: &str| headers.iter().position(|h| h == name).with_context(|| format!("colonne {name} absente"));
    let (c_title, c_cats, c_lat, c_lon, c_addr, c_city, c_periods, c_contacts, c_desc, c_uri) = (
        column("Nom_du_POI")?,
        column("Categories_de_POI")?,
        column("Latitude")?,
        column("Longitude")?,
        column("Adresse_postale")?,
        column("Code_postal_et_commune")?,
        column("Periodes_regroupees")?,
        column("Contacts_du_POI")?,
        column("Description")?,
        column("URI_ID_du_POI")?,
    );
    let mut out = Vec::new();
    let mut record = csv::StringRecord::new();
    while csv.read_record(&mut record)? {
        let get = |i: usize| record.get(i).unwrap_or("").trim();
        let types = type_names(get(c_cats));
        if !types.iter().any(|t| *t == "EntertainmentAndEvent" || *t == "Event") {
            continue;
        }
        let (Ok(lat), Ok(lon)) = (get(c_lat).parse::<f64>(), get(c_lon).parse::<f64>()) else { continue };
        let title = strip_html(get(c_title));
        if title.is_empty() || !plausible(lon, lat) {
            continue;
        }
        let Some((spans, long)) = finish(csv_spans(get(c_periods)), window) else { continue };
        let description = truncate(&strip_html(get(c_desc)), 280);
        let folded_title = fold(&title);
        if adult(&fold(&format!("{title} {description}"))) {
            continue;
        }
        let commune = get(c_city).split_once('#').map_or("", |(_, c)| c).to_string();
        let uri = get(c_uri);
        out.push(Event {
            id: hash_id(SRC_TOURISM, uri),
            lon,
            lat,
            cat: category_of_types(&types, &folded_title),
            src: SRC_TOURISM,
            title: truncate(&title, 110),
            commune,
            place: String::new(),
            address: truncate(get(c_addr), 120),
            spans,
            long,
            price: 0,
            price_text: String::new(),
            description,
            url: first_link(get(c_contacts)).unwrap_or(uri).to_string(),
        });
    }
    Ok(out)
}

// --- DATAtourisme : flux JSON-LD de l'utilisateur ---------------------------------------------------------------------------
//
// Le flux (plateforme « diffuseur » de DATAtourisme) est une archive ZIP : un fichier JSON-LD par point d'intérêt (dans
// `objects/`, plus un `index.json` qui les liste) ; on accepte aussi un JSON-LD unique (tableau ou `@graph`). Selon la
// compaction du contexte, les clés portent un préfixe (`schema:startDate`, `rdfs:label`) ou non (`startDate`, `label`) et les
// textes sont des chaînes, des `{"@value": …}` ou des tables de langues (`{"fr": ["…"]}`) : on lit donc **par nom local**,
// sans compter sur le préfixe ni sur la forme du texte.

fn local(key: &str) -> &str {
    key.rsplit([':', '/', '#']).next().unwrap_or(key)
}

/// L'enfant direct d'un objet dont le nom local est `name` (le premier élément si c'est un tableau d'objets).
fn child<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.iter().find(|(k, _)| local(k) == name).map(|(_, v)| v),
        Value::Array(items) => items.iter().find_map(|v| child(v, name)),
        _ => None,
    }
}

/// Le premier descendant (profondeur limitée) dont le nom local est `name`.
fn find<'a>(value: &'a Value, name: &str, depth: u8) -> Option<&'a Value> {
    if depth == 0 {
        return None;
    }
    match value {
        Value::Object(map) => {
            if let Some((_, v)) = map.iter().find(|(k, _)| local(k) == name) {
                return Some(v);
            }
            map.values().find_map(|v| find(v, name, depth - 1))
        }
        Value::Array(items) => items.iter().find_map(|v| find(v, name, depth - 1)),
        _ => None,
    }
}

/// Un texte : chaîne, `{"@value"}`, table de langues (le français d'abord), ou premier élément d'un tableau.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        Value::Array(items) => items.iter().find_map(text_of),
        Value::Object(map) => map.get("@value").and_then(text_of).or_else(|| map.get("fr").and_then(text_of)).or_else(|| map.get("en").and_then(text_of)),
        _ => None,
    }
}

fn texts_of(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| texts_of(v, out)),
        Value::Object(map) => {
            if let Some(v) = map.get("@value").or_else(|| map.get("@id")) {
                texts_of(v, out);
            }
        }
        _ => {}
    }
}

fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace(',', ".").parse().ok(),
        Value::Array(items) => items.iter().find_map(number_of),
        Value::Object(map) => map.get("@value").and_then(number_of),
        _ => None,
    }
}

/// Les moments d'un événement (`takesPlaceAt` : dates de début et de fin, horaires facultatifs). Sans horaire : jours entiers.
/// Un événement de plusieurs jours avec horaires a lieu chaque jour à ces heures.
fn flux_spans(poi: &Value) -> Vec<(i64, i64)> {
    let Some(schedules) = child(poi, "takesPlaceAt") else { return Vec::new() };
    let items: Vec<&Value> = match schedules {
        Value::Array(items) => items.iter().collect(),
        one => vec![one],
    };
    let mut spans = Vec::new();
    for item in items {
        let get = |name: &str| child(item, name).and_then(text_of);
        let Some(start_day) = get("startDate").as_deref().and_then(parse_date) else { continue };
        let end_day = get("endDate").as_deref().and_then(parse_date).unwrap_or(start_day);
        match (get("startTime"), get("endTime")) {
            (Some(start_time), end_time) => {
                let days = (end_day.since(start_day).ok().map_or(0, |d| d.get_days())).clamp(0, 62);
                for offset in 0..=i64::from(days) {
                    let Ok(day) = start_day.checked_add(jiff::Span::new().days(offset)) else { continue };
                    let Some(s) = at_time(day, &start_time) else { continue };
                    let e = match end_time.as_deref().and_then(|t| at_time(day, t)) {
                        Some(e) if e > s => e,
                        Some(e) => e + 86400,
                        None => s + 2 * 3600,
                    };
                    spans.push((s, e));
                }
            }
            (None, _) => {
                if let (Some((s, _)), Some((_, e))) = (day_bounds(start_day), day_bounds(end_day)) {
                    spans.push((s, e));
                }
            }
        }
    }
    spans
}

/// Un objet du flux → événement (s'il en est un, à venir, avec une position).
pub fn flux_event(poi: &Value, window: Window) -> Option<Event> {
    let mut types = Vec::new();
    texts_of(poi.get("@type")?, &mut types);
    let type_list: Vec<&str> = types.iter().map(|t| local(t)).collect();
    if !type_list.iter().any(|t| *t == "Event" || *t == "EntertainmentAndEvent" || t.ends_with("Event")) {
        return None;
    }
    let title = strip_html(&child(poi, "label").or_else(|| child(poi, "name")).and_then(text_of)?);
    let (spans, long) = finish(flux_spans(poi), window)?;
    let place = child(poi, "isLocatedAt")?;
    let geo = find(place, "geo", 4)?;
    let (lat, lon) = (number_of(child(geo, "latitude")?)?, number_of(child(geo, "longitude")?)?);
    if title.is_empty() || !plausible(lon, lat) {
        return None;
    }
    let description = child(poi, "hasDescription")
        .and_then(|d| find(d, "description", 3))
        .or_else(|| child(poi, "comment"))
        .and_then(text_of)
        .map(|d| truncate(&strip_html(&d), 280))
        .unwrap_or_default();
    if adult(&fold(&format!("{title} {description}"))) {
        return None;
    }
    let commune = find(place, "addressLocality", 4).and_then(text_of).unwrap_or_default();
    let street = find(place, "streetAddress", 4).and_then(text_of).unwrap_or_default();
    let zip = find(place, "postalCode", 4).and_then(text_of).unwrap_or_default();
    let place_name = child(place, "label").or_else(|| child(place, "name")).and_then(text_of).unwrap_or_default();
    // Tarif : un maximum de 0 est « gratuit », sinon payant (« de 5 à 12 € »).
    let (mut price, mut price_text) = (0, String::new());
    if let Some(offers) = child(poi, "offers") {
        let min = find(offers, "minPrice", 4).and_then(number_of);
        let max = find(offers, "maxPrice", 4).and_then(number_of).or(min);
        match (min, max) {
            (_, Some(max)) if max <= 0.0 => price = 1,
            (Some(min), Some(max)) => {
                price = 2;
                let fmt = |x: f64| if x.fract() == 0.0 { format!("{x:.0}") } else { format!("{x:.2}").replace('.', ",") };
                price_text = if (max - min).abs() < 0.005 { format!("{} €", fmt(min)) } else { format!("de {} à {} €", fmt(min), fmt(max)) };
            }
            _ => {}
        }
    }
    let id = child(poi, "@id").and_then(text_of).or_else(|| poi.get("@id").and_then(text_of))?;
    let url = child(poi, "hasContact")
        .and_then(|c| find(c, "homepage", 3))
        .and_then(text_of)
        .filter(|u| u.starts_with("http"))
        .unwrap_or_else(|| id.clone());
    Some(Event {
        id: hash_id(SRC_TOURISM, &id),
        lon,
        lat,
        cat: category_of_types(&type_list, &fold(&title)),
        src: SRC_TOURISM,
        title: truncate(&title, 110),
        commune,
        place: truncate(&place_name, 80),
        address: [street, format!("{zip} {}", find(place, "addressLocality", 4).and_then(text_of).unwrap_or_default()).trim().to_string()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", "),
        spans,
        long,
        price,
        price_text,
        description,
        url,
    })
}

/// Lit le flux téléchargé : une archive ZIP (une entrée JSON-LD par objet) ou un JSON-LD unique.
pub fn parse_datatourisme_flux(path: &Path, window: Window) -> Result<Vec<Event>> {
    let mut file = File::open(path)?;
    let mut magic = [0u8; 2];
    file.read_exact(&mut magic).context("flux vide")?;
    drop(file);
    let mut out = Vec::new();
    if &magic == b"PK" {
        let mut archive = zip::ZipArchive::new(BufReader::new(File::open(path)?)).context("archive ZIP illisible")?;
        for i in 0..archive.len() {
            let entry = archive.by_index(i)?;
            let name = entry.name().to_lowercase();
            if !name.ends_with(".json") && !name.ends_with(".jsonld") || name.ends_with("index.json") || entry.size() > MAX_ENTRY_BYTES {
                continue;
            }
            // Un objet par fichier ; un fichier illisible ne coûte que cet objet.
            let Ok(value) = serde_json::from_reader::<_, Value>(entry.take(MAX_ENTRY_BYTES)) else { continue };
            match &value {
                Value::Array(items) => out.extend(items.iter().filter_map(|v| flux_event(v, window))),
                v => out.extend(flux_event(v, window)),
            }
        }
    } else {
        for_each_json::<Value, _>(BufReader::new(File::open(path)?), |poi| out.extend(flux_event(&poi, window)))?;
    }
    Ok(out)
}

// --- Fusion et dédoublonnage ------------------------------------------------------------------------------------------------

/// Distance approchée en mètres.
fn meters(a: &Event, b: &Event) -> f64 {
    let dy = (a.lat - b.lat) * 111_000.0;
    let dx = (a.lon - b.lon) * 111_000.0 * ((a.lat + b.lat) / 2.0).to_radians().cos();
    dx.hypot(dy)
}

/// Numéros des jours (heure de Paris approchée) où l'événement commence ou est en cours.
fn days(e: &Event) -> Vec<i64> {
    let mut out = Vec::new();
    for &(s, en) in &e.spans {
        let (first, last) = ((s + 3600) / 86400, (en - 1 + 3600) / 86400);
        out.extend(first..=last.min(first + 40));
    }
    out
}

/// Même titre normalisé, un jour en commun, moins de 300 m : le premier (source prioritaire) est gardé.
pub fn merge(sources: Vec<Vec<Event>>) -> Vec<Event> {
    let mut kept: Vec<Event> = Vec::new();
    let mut kept_days: Vec<Vec<i64>> = Vec::new();
    let mut by_title: HashMap<String, Vec<usize>> = HashMap::new();
    let mut ids: HashSet<u64> = HashSet::new();
    for event in sources.into_iter().flatten() {
        if !ids.insert(event.id) {
            continue;
        }
        let key = fold(&event.title).replace(' ', "");
        let event_days = days(&event);
        if key.chars().count() >= 4
            && by_title.get(&key).is_some_and(|candidates| {
                candidates.iter().any(|&i| meters(&kept[i], &event) < 300.0 && kept_days[i].iter().any(|d| event_days.contains(d)))
            })
        {
            continue;
        }
        by_title.entry(key).or_default().push(kept.len());
        kept_days.push(event_days);
        kept.push(event);
    }
    kept.sort_unstable_by(|a, b| a.id.cmp(&b.id).then(Ordering::Equal));
    kept
}

/// La liste servie : colonnes, JSON compressé en gzip.
pub fn encode(events: &[Event], updated_at: i64) -> Result<Vec<u8>> {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::new(6));
    let sources: Vec<Value> = SOURCES.iter().map(|(name, licence, url)| json!({ "name": name, "licence": licence, "url": url })).collect();
    write!(gzip, "{{\"updatedAt\":{updated_at},\"sources\":{},\"events\":[", serde_json::to_string(&sources)?)?;
    for (i, e) in events.iter().enumerate() {
        if i > 0 {
            gzip.write_all(b",")?;
        }
        let flags = u8::from(e.long) | if e.price == 1 || e.price == 3 { 2 } else { 0 } | if e.price == 2 { 4 } else { 0 };
        let spans: Vec<i64> = e.spans.iter().flat_map(|&(s, en)| [s / 60, (en + 59) / 60]).collect();
        let row = json!([e.id, (e.lon * 1e5).round() / 1e5, (e.lat * 1e5).round() / 1e5, e.cat, e.src, flags, e.title, e.commune, spans]);
        serde_json::to_writer(&mut gzip, &row)?;
    }
    gzip.write_all(b"]}")?;
    Ok(gzip.finish()?)
}

fn publish(per_source: Vec<Vec<Event>>) -> Result<()> {
    let now = Timestamp::now().as_second();
    let window = Window::at(now);
    // Les moments gardés au dernier relevé peuvent être passés depuis : on rogne de nouveau.
    let trimmed: Vec<Vec<Event>> = per_source
        .into_iter()
        .map(|events| {
            events
                .into_iter()
                .filter_map(|mut e| {
                    let (spans, long) = finish(std::mem::take(&mut e.spans), window)?;
                    e.spans = spans;
                    e.long |= long;
                    Some(e)
                })
                .collect()
        })
        .collect();
    let events = merge(trimmed);
    if events.is_empty() {
        bail!("aucun événement");
    }
    let list = Bytes::from(encode(&events, now)?);
    info!(evenements = events.len(), octets = list.len(), "événements : liste publiée");
    *PUBLISHED.write().expect("verrou des événements") = Some(Arc::new(Published { list, events }));
    Ok(())
}

// --- Collecte --------------------------------------------------------------------------------------------------------------

fn cache_path(dir: &Path, source: usize) -> PathBuf {
    dir.join(format!("{}.json.gz", CACHE_NAMES[source]))
}

async fn cache_age(path: &Path) -> Option<Duration> {
    tokio::fs::metadata(path).await.ok()?.modified().ok()?.elapsed().ok()
}

fn read_cache(path: &Path) -> Result<Vec<Event>> {
    Ok(serde_json::from_reader(GzDecoder::new(BufReader::new(File::open(path)?)))?)
}

fn write_cache(path: &Path, events: &[Event]) -> Result<()> {
    let tmp = path.with_extension("gz.part");
    let mut gzip = GzEncoder::new(File::create(&tmp)?, Compression::new(6));
    serde_json::to_writer(&mut gzip, events)?;
    gzip.finish()?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// Télécharge sur le disque (jamais en mémoire). Les erreurs ne citent pas l'adresse : celle du flux DATAtourisme est secrète.
async fn download(http: &reqwest::Client, url: reqwest::Url, path: &Path) -> Result<()> {
    let mut response = http.get(url).timeout(Duration::from_secs(1200)).send().await.map_err(|e| e.without_url())?;
    if !response.status().is_success() {
        bail!("le serveur a répondu {}", response.status());
    }
    let mut file = tokio::fs::File::create(path).await?;
    let mut total = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url())? {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            bail!("fichier trop gros (plus de {} Mo)", MAX_DOWNLOAD_BYTES / 1_048_576);
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

fn ods_url(base: &str, select: &str, filter: &str) -> Result<reqwest::Url> {
    Ok(reqwest::Url::parse_with_params(base, [("select", select), ("where", filter), ("timezone", "UTC")])?)
}

/// Une source : télécharge, lit en continu, efface le fichier. Les événements sont déjà réduits à la fenêtre.
async fn fetch(http: &reqwest::Client, dir: &Path, source: usize) -> Result<Vec<Event>> {
    let part = dir.join(format!("{}.download.part", CACHE_NAMES[source]));
    let window = Window::at(Timestamp::now().as_second());
    let flux = std::env::var("DATATOURISME_FLUX_URL").ok().filter(|v| !v.trim().is_empty());
    let url = match source {
        0 => ods_url(
            PARIS_URL,
            "id,title,lead_text,url,date_start,date_end,occurrences,address_name,address_street,address_zipcode,address_city,lat_lon,price_type,price_detail,qfap_tags",
            "date_end >= now(days=-2) and date_start <= now(days=+31)",
        )?,
        2 => ods_url(
            OPENAGENDA_URL,
            "uid,title_fr,description_fr,keywords_fr,conditions_fr,canonicalurl,firstdate_begin,lastdate_end,timings,location_name,location_address,location_city,location_coordinates,status,attendancemode",
            "lastdate_end >= now(days=-2) and firstdate_begin <= now(days=+31)",
        )?,
        _ => match &flux {
            Some(flux) => reqwest::Url::parse(flux.trim()).map_err(|_| anyhow::anyhow!("DATATOURISME_FLUX_URL n'est pas une adresse valide"))?,
            None => reqwest::Url::parse(DATATOURISME_CSV_URL)?,
        },
    };
    download(http, url, &part).await?;
    let path = part.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<Event>> {
        match source {
            0 => parse_paris(BufReader::new(File::open(&path)?), window),
            2 => parse_openagenda(BufReader::new(File::open(&path)?), window),
            _ if flux.is_some() => parse_datatourisme_flux(&path, window),
            _ => parse_datatourisme_csv(BufReader::new(File::open(&path)?), window),
        }
    })
    .await?;
    let _ = tokio::fs::remove_file(&part).await;
    result
}

/// Les sources voulues : `EVENEMENTS_SOURCES` (par défaut `paris,datatourisme,openagenda`).
fn wanted_sources() -> [bool; 3] {
    let value = std::env::var("EVENEMENTS_SOURCES").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "paris,datatourisme,openagenda".into());
    let list: Vec<String> = value.split(',').map(|s| s.trim().to_lowercase()).collect();
    CACHE_NAMES.map(|name| list.iter().any(|s| s == name))
}

fn load_all(dir: &Path, wanted: [bool; 3]) -> Vec<Vec<Event>> {
    (0..3).map(|i| if wanted[i] { read_cache(&cache_path(dir, i)).unwrap_or_default() } else { Vec::new() }).collect()
}

/// Fait vivre la couche : relit les caches, puis rafraîchit chaque source quand elle est périmée, et republie la liste.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf) {
    let dir = data_dir.join("evenements");
    if let Err(error) = tokio::fs::create_dir_all(&dir).await {
        warn!("événements : dossier impossible : {error}");
        return;
    }
    let wanted = wanted_sources();
    let flux = std::env::var("DATATOURISME_FLUX_URL").is_ok_and(|v| !v.trim().is_empty());
    info!(paris = wanted[0], datatourisme = wanted[1], flux_datatourisme = flux, openagenda = wanted[2], "événements : sources");
    let cached = tokio::task::spawn_blocking({
        let dir = dir.clone();
        move || load_all(&dir, wanted)
    })
    .await
    .unwrap_or_default();
    if let Err(error) = publish(cached) {
        info!("événements : pas de cache exploitable ({error})");
    }
    let mut last_publish = std::time::Instant::now();
    let mut backoff: [Option<std::time::Instant>; 3] = [None; 3];
    loop {
        let mut changed = false;
        for source in 0..3 {
            if !wanted[source] || backoff[source].is_some_and(|until| until > std::time::Instant::now()) {
                continue;
            }
            let path = cache_path(&dir, source);
            if cache_age(&path).await.is_some_and(|age| age < REFRESH[source]) {
                continue;
            }
            match fetch(&http, &dir, source).await {
                Ok(events) if !events.is_empty() => {
                    info!(source = CACHE_NAMES[source], evenements = events.len(), "événements : source relevée");
                    let to_write = path.clone();
                    match tokio::task::spawn_blocking(move || write_cache(&to_write, &events)).await {
                        Ok(Ok(())) => changed = true,
                        other => warn!(source = CACHE_NAMES[source], "événements : cache non écrit : {other:?}"),
                    }
                }
                Ok(_) => {
                    warn!(source = CACHE_NAMES[source], "événements : la source ne contient aucun événement à venir");
                    backoff[source] = Some(std::time::Instant::now() + RETRY_AFTER);
                }
                Err(error) => {
                    warn!(source = CACHE_NAMES[source], "événements : source indisponible : {error:#}");
                    backoff[source] = Some(std::time::Instant::now() + RETRY_AFTER);
                }
            }
        }
        // Republier aussi sans changement, une fois par heure : les événements passés sortent de la fenêtre.
        if changed || last_publish.elapsed() > Duration::from_secs(3600) {
            let loaded = tokio::task::spawn_blocking({
                let dir = dir.clone();
                move || load_all(&dir, wanted)
            })
            .await
            .unwrap_or_default();
            let published = tokio::task::spawn_blocking(move || publish(loaded)).await;
            match published {
                Ok(Ok(())) => last_publish = std::time::Instant::now(),
                other => warn!("événements : publication impossible : {other:?}"),
            }
        }
        tokio::time::sleep(TICK).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// « Maintenant » des tests : mercredi 18 novembre 2026, 12:00 à Paris (11:00 UTC).
    const NOW: i64 = 1_795_000_000;

    fn window() -> Window {
        Window::at(NOW)
    }

    fn day(date: &str) -> (i64, i64) {
        day_bounds(date.parse().unwrap()).unwrap()
    }

    #[test]
    fn instant_de_reference_est_bien_le_18_novembre() {
        let (start, end) = day("2026-11-18");
        assert!(start < NOW && NOW < end, "{start} {NOW} {end}");
    }

    #[test]
    fn texte_normalise_sans_accents() {
        assert_eq!(fold("  Fête de l’Été — Œuvres & Co "), "fete de l ete oeuvres co");
        assert_eq!(strip_html("<p>Un&nbsp;concert &amp; <b>plus</b></p><iframe src=\"x\"></iframe>"), "Un concert & plus");
        assert_eq!(truncate("un deux trois quatre cinq six", 14), "un deux trois…");
    }

    #[test]
    fn categories_par_mots() {
        assert_eq!(classify_text(&fold("Marché de Noël")), 4);
        assert_eq!(classify_text(&fold("Concert de jazz")), 0);
        assert_eq!(classify_text(&fold("Théâtre : Cyrano")), 1);
        assert_eq!(classify_text(&fold("Vernissage de l'exposition")), 2);
        assert_eq!(classify_text(&fold("Match de rugby")), 5);
        assert_eq!(classify_text(&fold("Visite guidée du château")), 6);
        assert_eq!(classify_text(&fold("Fête du village")), 3);
        assert_eq!(classify_text(&fold("Assemblée générale")), 7);
    }

    #[test]
    fn contenu_adulte_ecarte() {
        assert!(adult(&fold("Soirée libertine au château")));
        assert!(adult(&fold("Salon de l'érotisme")));
        assert!(!adult(&fold("Marché de Noël de Sexey")));
        assert!(!adult(&fold("Exposition de photographie")));
    }

    #[test]
    fn fenetre_rogne_fusionne_et_marque_les_longues() {
        let (a, b) = day("2026-11-18");
        let (_, c) = day("2026-11-19");
        let spans = vec![(b, c), (a, b), (1, 2)];
        let (kept, long) = finish(spans, window()).unwrap();
        assert_eq!(kept, vec![(a, c)], "les deux jours se touchent, le passé lointain est écarté");
        assert!(!long);
        let (long_kept, long) = finish(vec![(NOW - 900 * 86400, NOW + 900 * 86400)], window()).unwrap();
        assert!(long);
        assert_eq!(long_kept, vec![(window().from, window().to)]);
        assert!(finish(vec![(NOW + 40 * 86400, NOW + 41 * 86400)], window()).is_none());
    }

    const PARIS: &str = r#"[
      {"id":"1","title":"Big Mother","lead_text":"<p>Une pièce</p>","url":"https://www.paris.fr/evenements/big-mother-1",
       "date_start":"2026-11-10T19:00:00+00:00","date_end":"2026-12-13T20:40:00+00:00",
       "occurrences":"2026-11-18T19:00:00+01:00_2026-11-18T20:40:00+01:00;2026-11-19T19:00:00+01:00_2026-11-19T20:40:00+01:00;2026-03-01T19:00:00+01:00_2026-03-01T20:40:00+01:00",
       "address_name":"Théâtre du Marais","address_street":"37 rue Volta","address_zipcode":"75003","address_city":"Paris",
       "lat_lon":{"lon":2.355,"lat":48.866},"price_type":"payant","price_detail":"<p>De 10 à 25 €</p>","qfap_tags":"Théâtre;Danse"},
      {"id":"2","title":"Le musée Banksy","lead_text":"Expo permanente","date_start":"2019-06-01T00:00:00+00:00","date_end":"2027-12-31T23:59:59+00:00",
       "occurrences":null,"lat_lon":{"lon":2.3416,"lat":48.8746},"price_type":"payant","qfap_tags":"Expo","address_city":"Paris"},
      {"id":"3","title":"Sans position","date_start":"2026-11-18T10:00:00+00:00","date_end":"2026-11-18T12:00:00+00:00","lat_lon":{"lon":null,"lat":null}},
      {"id":"4","title":"Soirée libertine","date_start":"2026-11-18T20:00:00+00:00","date_end":"2026-11-18T23:00:00+00:00","lat_lon":{"lon":2.3,"lat":48.8}}
    ]"#;

    #[test]
    fn que_faire_a_paris() {
        let events = parse_paris(PARIS.as_bytes(), window()).unwrap();
        assert_eq!(events.len(), 2, "sans position et libertine écartés");
        let big = &events[0];
        assert_eq!((big.title.as_str(), big.cat, big.price, big.src), ("Big Mother", 1, 2, SRC_PARIS));
        assert_eq!(big.spans.len(), 2, "le passé lointain est écarté");
        assert_eq!(big.spans[0].0, parse_instant("2026-11-18T19:00:00+01:00").unwrap());
        assert_eq!(big.price_text, "De 10 à 25 €");
        assert_eq!(big.address, "37 rue Volta, 75003 Paris");
        assert_eq!(big.description, "Une pièce");
        let banksy = &events[1];
        assert!(banksy.long, "exposition permanente");
        assert_eq!(banksy.cat, 2);
    }

    #[test]
    fn openagenda() {
        let json = r#"[
          {"uid":"10","title_fr":"Concert de Noël","description_fr":"Chorale","keywords_fr":["Concert","Gratuit"],"conditions_fr":"Entrée libre",
           "canonicalurl":"https://openagenda.com/ville/events/concert","firstdate_begin":"2026-11-20T19:00:00+00:00","lastdate_end":"2026-11-20T20:00:00+00:00",
           "timings":"[{\"begin\":\"2026-11-20T20:00:00+01:00\",\"end\":\"2026-11-20T21:00:00+01:00\",\"id\":\"A\"}]",
           "location_name":"Église","location_address":"1 place","location_city":"Nantes","location_coordinates":{"lon":-1.55,"lat":47.21},
           "status":"{\"id\": 1}","attendancemode":"{\"id\": 1}"},
          {"uid":"11","title_fr":"Kiosque emploi","keywords_fr":["Recrutement"],"canonicalurl":"https://openagenda.com/francetravail/events/x",
           "firstdate_begin":"2026-11-20T09:00:00+00:00","lastdate_end":"2026-11-20T10:00:00+00:00","location_coordinates":{"lon":-1.5,"lat":47.2}},
          {"uid":"12","title_fr":"Annulé","firstdate_begin":"2026-11-20T09:00:00+00:00","lastdate_end":"2026-11-20T10:00:00+00:00",
           "location_coordinates":{"lon":-1.5,"lat":47.2},"status":"{\"id\": 6}"},
          {"uid":"13","title_fr":"Conférence en ligne","firstdate_begin":"2026-11-20T09:00:00+00:00","lastdate_end":"2026-11-20T10:00:00+00:00",
           "location_coordinates":{"lon":-1.5,"lat":47.2},"attendancemode":"{\"id\": 2}"}
        ]"#;
        let events = parse_openagenda(json.as_bytes(), window()).unwrap();
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!((e.cat, e.price, e.commune.as_str(), e.place.as_str()), (0, 1, "Nantes", "Église"));
        assert_eq!(e.spans, vec![(parse_instant("2026-11-20T20:00:00+01:00").unwrap(), parse_instant("2026-11-20T21:00:00+01:00").unwrap())]);
    }

    const CSV: &str = "Nom_du_POI,Categories_de_POI,Latitude,Longitude,Adresse_postale,Code_postal_et_commune,Periodes_regroupees,Covid19_mesures_specifiques,Createur_de_la_donnee,SIT_diffuseur,Date_de_mise_a_jour,Contacts_du_POI,Classements_du_POI,Description,URI_ID_du_POI\n\
Marché de Noël de Spechbach,https://www.datatourisme.fr/ontology/core#EntertainmentAndEvent|https://www.datatourisme.fr/ontology/core#SaleEvent|https://www.datatourisme.fr/ontology/core#Market|http://schema.org/Event,47.668,7.226,Place de l'École,68720#Spechbach,2026-11-22<->2026-11-22,,OT,SIT,2026-10-29,\"association#|#https://spechbach.example/noel\",,\"17ème marché de Noël, restauration sur place\",https://data.datatourisme.fr/5/1bd0\n\
Cinéma de Jonzac,https://www.datatourisme.fr/ontology/core#Cinema|https://www.datatourisme.fr/ontology/core#PointOfInterest,45.4,-0.4,rue,17500#Jonzac,2026-11-22<->2026-11-22,,,,,,,,https://data.datatourisme.fr/13/cine\n\
Concert de la chorale,https://www.datatourisme.fr/ontology/core#EntertainmentAndEvent|https://www.datatourisme.fr/ontology/core#Concert|http://schema.org/MusicEvent,45.35,-0.34,14 rue,17130#Vibrac,2026-01-01<->2026-02-01|2026-11-28<->2026-11-29,,,,,#https://vibrac.example/,,Chants,https://data.datatourisme.fr/13/choeur\n\
Visites du vignoble,https://www.datatourisme.fr/ontology/core#EntertainmentAndEvent|https://www.datatourisme.fr/ontology/core#Visit|http://schema.org/Event,45.35,-0.34,14 rue,17130#Vibrac,2026-01-01<->2027-12-31,,,,,,,,https://data.datatourisme.fr/13/vigne\n";

    #[test]
    fn datatourisme_csv() {
        let events = parse_datatourisme_csv(CSV.as_bytes(), window()).unwrap();
        assert_eq!(events.len(), 3, "le cinéma n'est pas un événement");
        let market = &events[0];
        assert_eq!((market.cat, market.commune.as_str(), market.url.as_str()), (4, "Spechbach", "https://spechbach.example/noel"));
        assert_eq!(market.spans, vec![day("2026-11-22")]);
        assert_eq!(market.description, "17ème marché de Noël, restauration sur place");
        let choir = &events[1];
        assert_eq!(choir.cat, 0);
        assert_eq!(choir.spans, vec![(day("2026-11-28").0, day("2026-11-29").1)], "la période de janvier est passée");
        assert!(events[2].long, "visites à l'année");
        assert_eq!(events[2].cat, 6);
    }

    /// Un objet du flux JSON-LD de DATAtourisme, tel que le décrit la documentation (préfixes `schema:` et `rdfs:` du contexte).
    const FLUX_OBJECT: &str = r#"{
      "@context": {"schema": "http://schema.org/", "rdfs": "http://www.w3.org/2000/01/rdf-schema#"},
      "@id": "https://data.datatourisme.fr/13/aaaa-bbbb",
      "@type": ["schema:Event", "EntertainmentAndEvent", "PointOfInterest", "Concert", "schema:MusicEvent"],
      "rdfs:label": {"fr": ["Concert du Nouvel An"], "en": ["New Year concert"]},
      "hasDescription": [{"@type": "Description", "dc:description": {"fr": ["<p>Orchestre et chœur.</p>"]}}],
      "isLocatedAt": [{"@type": ["schema:Place", "Place"], "schema:address": [{"schema:addressLocality": "Lyon", "schema:postalCode": "69002", "schema:streetAddress": ["14 place Bellecour"]}],
                        "schema:geo": {"schema:latitude": "45.757", "schema:longitude": "4.832"}, "rdfs:label": {"fr": ["Auditorium"]}}],
      "takesPlaceAt": [{"startDate": "2026-11-20", "endDate": "2026-11-21", "startTime": "20:30:00", "endTime": "22:30:00"}],
      "offers": [{"schema:priceSpecification": [{"schema:minPrice": "12", "schema:maxPrice": "25", "schema:priceCurrency": "EUR"}]}],
      "hasContact": [{"schema:telephone": ["+33400000000"], "foaf:homepage": ["https://auditorium.example/"]}]
    }"#;

    #[test]
    fn datatourisme_flux_un_objet() {
        let poi: Value = serde_json::from_str(FLUX_OBJECT).unwrap();
        let e = flux_event(&poi, window()).unwrap();
        assert_eq!((e.title.as_str(), e.cat, e.commune.as_str(), e.place.as_str()), ("Concert du Nouvel An", 0, "Lyon", "Auditorium"));
        assert_eq!(e.address, "14 place Bellecour, 69002 Lyon");
        assert_eq!((e.price, e.price_text.as_str()), (2, "de 12 à 25 €"));
        assert_eq!(e.url, "https://auditorium.example/");
        assert_eq!(e.description, "Orchestre et chœur.");
        assert!((e.lat - 45.757).abs() < 1e-9 && (e.lon - 4.832).abs() < 1e-9);
        // Deux jours avec horaires : une séance chaque soir.
        assert_eq!(e.spans.len(), 2);
        assert_eq!(e.spans[0], (at_time("2026-11-20".parse().unwrap(), "20:30").unwrap(), at_time("2026-11-20".parse().unwrap(), "22:30").unwrap()));
        assert_eq!(e.spans[1].0, at_time("2026-11-21".parse().unwrap(), "20:30:00").unwrap());
    }

    #[test]
    fn datatourisme_flux_sans_prefixes_et_sans_horaires() {
        let poi: Value = serde_json::from_str(
            r#"{"@id":"https://data.datatourisme.fr/1/x","@type":["Market","EntertainmentAndEvent"],"label":{"fr":["Marché du samedi"]},
                "isLocatedAt":{"address":{"addressLocality":"Albi"},"geo":{"latitude":43.93,"longitude":2.14}},
                "takesPlaceAt":{"startDate":"2026-11-21","endDate":"2026-11-21"},
                "offers":{"priceSpecification":{"maxPrice":0}}}"#,
        )
        .unwrap();
        let e = flux_event(&poi, window()).unwrap();
        assert_eq!((e.cat, e.price, e.commune.as_str()), (4, 1, "Albi"));
        assert_eq!(e.spans, vec![day("2026-11-21")]);
        assert_eq!(e.url, "https://data.datatourisme.fr/1/x");
        // Pas un événement : un restaurant.
        let restaurant: Value = serde_json::from_str(r#"{"@id":"r","@type":["Restaurant","PointOfInterest"],"label":"Chez Paul"}"#).unwrap();
        assert!(flux_event(&restaurant, window()).is_none());
    }

    #[test]
    fn datatourisme_flux_zip_et_json_ld_unique() {
        let dir = std::env::temp_dir().join(format!("vigie-evenements-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // L'archive du diffuseur : index.json, puis un fichier par objet.
        let zip_path = dir.join("flux.zip");
        {
            let mut writer = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("index.json", options).unwrap();
            writer.write_all(br#"[{"@id":"https://data.datatourisme.fr/13/aaaa-bbbb","file":"objects/1/aaaa.json"}]"#).unwrap();
            writer.start_file("objects/1/aaaa.json", options).unwrap();
            writer.write_all(FLUX_OBJECT.as_bytes()).unwrap();
            writer.start_file("objects/1/cassé.json", options).unwrap();
            writer.write_all(b"{ pas du json").unwrap();
            writer.finish().unwrap();
        }
        let events = parse_datatourisme_flux(&zip_path, window()).unwrap();
        assert_eq!(events.len(), 1);
        // Un JSON-LD unique : tableau, ou `@graph`.
        let single = dir.join("flux.jsonld");
        std::fs::write(&single, format!(r#"{{"@context":{{}},"@graph":[{FLUX_OBJECT},{{"@id":"z","@type":["Hotel"]}}]}}"#)).unwrap();
        assert_eq!(parse_datatourisme_flux(&single, window()).unwrap().len(), 1);
        std::fs::write(&single, format!("[{FLUX_OBJECT}]")).unwrap();
        assert_eq!(parse_datatourisme_flux(&single, window()).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn event(src: u8, id: &str, title: &str, lon: f64, lat: f64, date: &str) -> Event {
        Event {
            id: hash_id(src, id),
            lon,
            lat,
            cat: 0,
            src,
            title: title.into(),
            commune: String::new(),
            place: String::new(),
            address: String::new(),
            spans: vec![day(date)],
            long: false,
            price: 0,
            price_text: String::new(),
            description: String::new(),
            url: String::new(),
        }
    }

    #[test]
    fn dedoublonnage_titre_jour_distance() {
        let paris = vec![event(0, "a", "Concert de Noël – Église Saint-Eustache", 2.345, 48.863, "2026-11-20")];
        let tourisme = vec![
            // Même titre normalisé, même jour, 100 m : doublon.
            event(1, "b", "CONCERT DE NOEL - Eglise Saint Eustache", 2.3461, 48.8635, "2026-11-20"),
            // Même titre, même jour, mais à 5 km : un autre événement.
            event(1, "c", "Concert de Noël – Église Saint-Eustache", 2.40, 48.90, "2026-11-20"),
            // Même titre, même lieu, un autre jour : un autre événement.
            event(1, "d", "Concert de Noël – Église Saint-Eustache", 2.345, 48.863, "2026-11-21"),
        ];
        let agenda = vec![event(2, "e", "Concert de Noël – Église Saint-Eustache", 2.3452, 48.8631, "2026-11-20")];
        let merged = merge(vec![paris, tourisme, agenda]);
        assert_eq!(merged.len(), 3);
        assert!(merged.iter().any(|e| e.src == 0), "la source prioritaire est gardée");
        assert!(!merged.iter().any(|e| e.src == 2), "le doublon de la troisième source est écarté");
        assert!(merged.windows(2).all(|w| w[0].id < w[1].id), "triés par identifiant, pour la recherche de la fiche");
    }

    #[test]
    fn liste_servie_en_colonnes() {
        let mut e = event(0, "a", "Concert", 2.3456789, 48.8, "2026-11-20");
        e.price = 1;
        e.commune = "Paris".into();
        let gz = encode(&[e.clone()], 1_795_000_000).unwrap();
        let mut json = String::new();
        GzDecoder::new(&gz[..]).read_to_string(&mut json).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["updatedAt"], 1_795_000_000);
        assert_eq!(value["sources"].as_array().unwrap().len(), 3);
        let row = &value["events"][0];
        assert_eq!(row[0], e.id);
        assert_eq!(row[1], 2.34568);
        assert_eq!((row[3].as_u64(), row[4].as_u64(), row[5].as_u64()), (Some(0), Some(0), Some(2)), "catégorie, source, gratuit");
        assert_eq!((row[6].as_str(), row[7].as_str()), (Some("Concert"), Some("Paris")));
        assert_eq!(row[8][0], e.spans[0].0 / 60);
    }

    #[test]
    fn identifiants_tiennent_dans_un_nombre_javascript() {
        assert!(hash_id(1, "https://data.datatourisme.fr/13/aaaa") < (1 << 53));
        assert_ne!(hash_id(0, "1"), hash_id(2, "1"));
    }

    /// Serveur de démonstration : relève réellement les sources (réseau) et sert `/api/evenements` et `/api/evenements/fiche`,
    /// sans le reste de Vigie. À lancer à la main : `EVENEMENTS_DEMO_PORT=18187 EVENEMENTS_DEMO_DIR=/tmp/ev cargo test
    /// serveur_de_demonstration -- --ignored --nocapture`. Il tourne jusqu'à ce qu'on l'arrête.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "réseau : relève les vraies sources et ne s'arrête jamais"]
    async fn serveur_de_demonstration() {
        let port: u16 = std::env::var("EVENEMENTS_DEMO_PORT").ok().and_then(|p| p.parse().ok()).expect("EVENEMENTS_DEMO_PORT");
        let dir = PathBuf::from(std::env::var("EVENEMENTS_DEMO_DIR").expect("EVENEMENTS_DEMO_DIR"));
        let http = reqwest::Client::builder().user_agent("vigie-demonstration").build().unwrap();
        tokio::spawn(poll_forever(http, dir));
        let app = axum::Router::new()
            .route("/api/evenements", axum::routing::get(|| async { response() }))
            .route("/api/evenements/fiche", axum::routing::get(detail));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    }
}
