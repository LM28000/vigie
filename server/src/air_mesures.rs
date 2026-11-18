//! Qualité de l'air, mesures : les concentrations horaires relevées aux stations officielles de
//! surveillance (NO2, ozone, PM10, PM2.5, SO2), en complément de l'indice ATMO de `air.rs`.
//!
//! Source : LCSQA (Ineris) / Geod'air, jeu « Données temps réel de mesure des concentrations de
//! polluants atmosphériques réglementés » sur data.gouv.fr, flux « E2 » : les moyennes horaires
//! brutes des analyseurs des associations agréées (AASQA), remontées au fil de l'eau. Données
//! ouvertes, sans clé ; mention « LCSQA / Geod'air, AASQA ».
//!
//! Le fichier du jour (`<année>/FR_E2_<AAAA-MM-JJ>.csv`, 8 à 11 Mo, UTF-8 avec BOM, séparateur
//! `;`, toutes les valeurs entre guillemets) est réécrit toutes les heures, à la demi-heure ; il
//! contient les heures déjà publiées, jusqu'à l'heure close une heure et demie plus tôt environ.
//! Les heures de la France métropolitaine y sont en temps universel (TU), celles des départements
//! d'outre-mer en heure locale (ils sont écartés ici). Le flux ne dit pas les coordonnées des
//! stations : elles viennent du « Dataset D » du même jeu (métadonnées), reprises dans
//! `data/air_stations.tsv` par `server/scripts/air_stations.py` (une mise à jour par an environ).
//!
//! Adresse : `files.data.gouv.fr` n'est qu'une redirection (302) vers le stockage objet d'Ineris
//! et sa `robots.txt` interdit tout aux robots ; le serveur s'adresse donc directement au stockage
//! objet, qui n'a pas de `robots.txt`. La collecte est discrète : une requête conditionnelle
//! (`If-None-Match` : 304 sans corps tant que le fichier n'a pas changé) toutes les 20 minutes, et
//! le fichier de la veille une seule fois (plusieurs fois seulement dans les premières heures du jour).
//!
//! Validité : seules les valeurs présentes dont le drapeau de validité du flux est positif (1 à 4 :
//! valide, y compris l'ozone, qui est « 4 » en pratique) sont gardées ; « -1 » (invalide ou absente,
//! code qualité « N ») est écarté. Les codes qualité « A » (vérifié) et « R » (brut, pas encore
//! vérifié) sont tous deux gardés : l'heure la plus récente est toujours « R ». Un petit négatif
//! (bruit de l'analyseur) est ramené à 0.
//!
//! Réponse : en colonnes. Les stations d'abord (nom, commune, position, type), puis, par polluant,
//! les indices des stations qui le mesurent et leurs 24 dernières heures (la dernière tranche se
//! termine à `end`, une valeur `null` est un trou). Seules les stations qui ont au moins une valeur
//! sur ces 24 heures sont servies.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use reqwest::StatusCode;
use serde::Serialize;
use tracing::{info, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://ineris.s3.rbx.io.cloud.ovh.net/lcsqa/concentrations-de-polluants-atmospheriques-reglementes/temps-reel";
/// Le fichier change une fois par heure (à la demi-heure) : une requête conditionnelle toutes les 20 minutes
/// le voit dans les vingt minutes qui suivent, sans rien télécharger entre-temps.
const REFRESH_EVERY: Duration = Duration::from_secs(20 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// Heures servies par station et polluant.
const WINDOW: usize = 24;
/// Taille maximale d'un fichier du jour (il fait aujourd'hui 8 à 11 Mo) : au-delà, on renonce.
const MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Jusqu'à cette heure TU, le fichier de la veille est encore relevé à chaque tour (sa dernière heure arrive après minuit).
const YESTERDAY_SETTLED_HOUR: i8 = 3;
/// Métropole et Corse, avec une marge (sud, ouest, nord, est) : la même que `air.rs`.
const AREA: (f64, f64, f64, f64) = (41.0, -5.5, 51.5, 10.0);
/// Coordonnées des stations (voir l'en-tête).
const STATIONS_TSV: &str = include_str!("data/air_stations.tsv");

/// Les polluants servis, dans l'ordre des indices : NO2, ozone, PM10, PM2.5, SO2.
const POLLUTANTS: [&str; 5] = ["NO2", "O3", "PM10", "PM2.5", "SO2"];

// --- Stations --------------------------------------------------------------------------------

struct Position {
    lon: f64,
    lat: f64,
    commune: String,
}

/// Coordonnées des stations de métropole, par code (« FR01011 »).
struct Positions(HashMap<String, Position>);

impl Positions {
    fn parse(tsv: &str) -> Self {
        let mut map = HashMap::new();
        for line in tsv.lines() {
            let mut fields = line.split('\t');
            let (Some(code), Some(lat), Some(lon), Some(commune)) = (fields.next(), fields.next(), fields.next(), fields.next()) else { continue };
            let (Ok(lat), Ok(lon)) = (lat.parse::<f64>(), lon.parse::<f64>()) else { continue };
            map.insert(code.to_string(), Position { lon, lat, commune: commune.to_string() });
        }
        Self(map)
    }
}

// --- Lecture du fichier ------------------------------------------------------------------------

/// Ce qu'on retient d'une station d'après les lignes du flux.
#[derive(Clone, Debug, PartialEq)]
struct Meta {
    name: String,
    org: String,
    /// 0 urbaine, 1 périurbaine, 2 rurale.
    implantation: u8,
    /// 0 fond, 1 trafic, 2 industrielle.
    influence: u8,
}

/// Un fichier du jour, réduit à ce qui sert : les valeurs valides des cinq polluants des stations
/// de métropole dont on connaît la position.
#[derive(Default)]
struct DayFile {
    /// (code de la station, indice du polluant) → (fin de l'heure en secondes UTC, valeur).
    readings: HashMap<(String, u8), Vec<(i64, f32)>>,
    meta: HashMap<String, Meta>,
}

fn implantation(text: &str) -> u8 {
    let lower = text.to_lowercase();
    if lower.starts_with("rural") {
        2
    } else if lower.starts_with("p") {
        1
    } else {
        0
    }
}

fn influence(text: &str) -> u8 {
    match text.to_lowercase().as_str() {
        "trafic" => 1,
        "industrielle" => 2,
        _ => 0,
    }
}

/// « 2026/11/18 17:00:00 » (TU) → secondes UTC.
fn parse_time(text: &str) -> Option<i64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i16>().ok();
    let date = Date::new(number(0..4)?, i8::try_from(number(5..7)?).ok()?, i8::try_from(number(8..10)?).ok()?).ok()?;
    let at = date.at(i8::try_from(number(11..13)?).ok()?, i8::try_from(number(14..16)?).ok()?, 0, 0);
    Some(at.to_zoned(TimeZone::UTC).ok()?.timestamp().as_second())
}

fn parse_file(body: &[u8], positions: &Positions) -> Result<DayFile> {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    let mut reader = csv::ReaderBuilder::new().delimiter(b';').flexible(true).from_reader(body);
    let headers = reader.headers().context("en-tête illisible")?.clone();
    let column = |name: &str| headers.iter().position(|h| h.trim() == name).with_context(|| format!("colonne « {name} » absente"));
    let (end, org, site, name, implant, pollutant, influ, value, validity) = (
        column("Date de fin")?,
        column("Organisme")?,
        column("code site")?,
        column("nom site")?,
        column("type d'implantation")?,
        column("Polluant")?,
        column("type d'influence")?,
        column("valeur")?,
        column("validité")?,
    );
    let mut file = DayFile::default();
    let mut record = csv::StringRecord::new();
    while reader.read_record(&mut record).context("ligne illisible")? {
        let field = |i: usize| record.get(i).unwrap_or("").trim();
        let Some(pol) = POLLUTANTS.iter().position(|p| *p == field(pollutant)) else { continue };
        let code = field(site);
        // Les stations d'outre-mer, ou nouvelles depuis la dernière mise à jour des coordonnées, n'ont pas de position.
        if !positions.0.contains_key(code) {
            continue;
        }
        // Valeur absente ou drapeau de validité négatif (« -1 ») : écarté.
        let Ok(v) = field(value).parse::<f32>() else { continue };
        if field(validity).parse::<i32>().unwrap_or(-1) <= 0 || !v.is_finite() || v > 5000.0 {
            continue;
        }
        let Some(end) = parse_time(field(end)) else { continue };
        file.meta.entry(code.to_string()).or_insert_with(|| Meta {
            name: field(name).to_string(),
            org: field(org).to_string(),
            implantation: implantation(field(implant)),
            influence: influence(field(influ)),
        });
        file.readings.entry((code.to_string(), pol as u8)).or_default().push((end, v.max(0.0)));
    }
    Ok(file)
}

// --- Mise en forme -----------------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Default)]
struct StationsOut {
    code: Vec<String>,
    name: Vec<String>,
    commune: Vec<String>,
    lon: Vec<f64>,
    lat: Vec<f64>,
    /// Indice de l'association dans `orgs`.
    org: Vec<u16>,
    /// Implantation : 0 urbaine, 1 périurbaine, 2 rurale.
    imp: Vec<u8>,
    /// Influence : 0 fond, 1 trafic, 2 industrielle.
    infl: Vec<u8>,
}

#[derive(Serialize, Debug, PartialEq, Default)]
struct PollutantOut {
    /// Indices dans `stations` des stations qui mesurent ce polluant.
    i: Vec<u32>,
    /// Pour chacune, les `WINDOW` dernières heures, de la plus ancienne à celle qui se termine à `end` (µg/m³ ; `null` : trou).
    v: Vec<Vec<Option<f32>>>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Out {
    /// Instant de la collecte (secondes UTC).
    updated_at: i64,
    /// Fin de la dernière heure publiée (secondes UTC) : la dernière valeur de chaque série se termine là.
    end: i64,
    orgs: Vec<String>,
    stations: StationsOut,
    pollutants: BTreeMap<&'static str, PollutantOut>,
}

/// Le dixième de µg/m³ suffit (la précision des analyseurs) et garde le JSON court.
fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

fn build(files: &[&DayFile], positions: &Positions, now: i64) -> Result<Out> {
    let (south, west, north, east) = AREA;
    // Valeur par (station, polluant) et heure ; le fichier le plus récent (le dernier) l'emporte.
    let mut series: BTreeMap<(&str, u8), BTreeMap<i64, f32>> = BTreeMap::new();
    let mut metas: HashMap<&str, &Meta> = HashMap::new();
    for file in files {
        for (code, meta) in &file.meta {
            metas.insert(code, meta);
        }
        for ((code, pol), readings) in &file.readings {
            series.entry((code, *pol)).or_default().extend(readings.iter().copied());
        }
    }
    let Some(end) = series.values().filter_map(|s| s.keys().next_back().copied()).max() else { bail!("aucune mesure valide dans le flux") };
    let first = end - (WINDOW as i64 - 1) * 3600;

    let mut out = Out { updated_at: now, end, orgs: Vec::new(), stations: StationsOut::default(), pollutants: BTreeMap::new() };
    let mut index: HashMap<&str, u32> = HashMap::new();
    for ((code, pol), hours) in &series {
        let mut values = vec![None; WINDOW];
        for (t, v) in hours.range(first..=end) {
            values[((t - first) / 3600) as usize] = Some(round1(*v));
        }
        if values.iter().all(Option::is_none) {
            continue;
        }
        let (Some(position), Some(meta)) = (positions.0.get(*code), metas.get(code)) else { continue };
        if !(south..=north).contains(&position.lat) || !(west..=east).contains(&position.lon) {
            continue;
        }
        let station = *index.entry(code).or_insert_with(|| {
            let org = match out.orgs.iter().position(|o| *o == meta.org) {
                Some(i) => i,
                None => {
                    out.orgs.push(meta.org.clone());
                    out.orgs.len() - 1
                }
            };
            let s = &mut out.stations;
            s.code.push(code.to_string());
            s.name.push(meta.name.clone());
            s.commune.push(position.commune.clone());
            s.lon.push(position.lon);
            s.lat.push(position.lat);
            s.org.push(org as u16);
            s.imp.push(meta.implantation);
            s.infl.push(meta.influence);
            s.code.len() as u32 - 1
        });
        let pollutant = out.pollutants.entry(POLLUTANTS[*pol as usize]).or_default();
        pollutant.i.push(station);
        pollutant.v.push(values);
    }
    if out.stations.code.is_empty() {
        bail!("aucune station de métropole avec une mesure valide");
    }
    Ok(out)
}

// --- Collecte ----------------------------------------------------------------------------------

struct Cached {
    etag: Option<String>,
    file: DayFile,
}

struct Collector {
    http: reqwest::Client,
    positions: Positions,
    /// Les fichiers déjà lus, par jour (aujourd'hui et hier au plus).
    days: HashMap<Date, Cached>,
}

fn file_url(day: Date) -> String {
    format!("{BASE_URL}/{}/FR_E2_{day}.csv", day.year())
}

impl Collector {
    /// Relève le fichier d'un jour s'il a changé (requête conditionnelle). Un 404 est un fichier pas encore créé (juste après minuit).
    async fn refresh(&mut self, day: Date) -> Result<()> {
        let mut request = self.http.get(file_url(day)).timeout(Duration::from_secs(180));
        if let Some(etag) = self.days.get(&day).and_then(|c| c.etag.as_deref()) {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        let response = request.send().await?;
        match response.status() {
            StatusCode::NOT_MODIFIED => Ok(()),
            StatusCode::NOT_FOUND => {
                self.days.entry(day).or_insert_with(|| Cached { etag: None, file: DayFile::default() });
                Ok(())
            }
            status if status.is_success() => {
                if response.content_length().is_some_and(|n| n > MAX_BYTES) {
                    bail!("fichier du {day} trop gros ({} octets)", response.content_length().unwrap_or(0));
                }
                let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
                let body = response.bytes().await?;
                let file = parse_file(&body, &self.positions).with_context(|| format!("fichier du {day} illisible"))?;
                // Le corps (une dizaine de Mo) est libéré ici ; il ne reste que les valeurs utiles.
                self.days.insert(day, Cached { etag, file });
                Ok(())
            }
            status => bail!("HTTP {status} pour le fichier du {day}"),
        }
    }

    async fn collect(&mut self) -> Result<(Vec<u8>, usize)> {
        let now = Timestamp::now();
        let zoned = now.to_zoned(TimeZone::UTC);
        let today = zoned.date();
        let yesterday = today.yesterday()?;
        self.days.retain(|day, _| *day >= yesterday);
        // La veille ne change plus une fois sa dernière heure arrivée : une seule lecture, sauf tôt le matin.
        if !self.days.contains_key(&yesterday) || zoned.hour() < YESTERDAY_SETTLED_HOUR {
            if let Err(error) = self.refresh(yesterday).await {
                warn!("qualité de l'air, mesures : fichier de la veille indisponible : {error:#}");
            }
        }
        self.refresh(today).await?;
        let files: Vec<&DayFile> = [yesterday, today].iter().filter_map(|d| self.days.get(d)).map(|c| &c.file).collect();
        let out = build(&files, &self.positions, now.as_second())?;
        let stations = out.stations.code.len();
        Ok((serde_json::to_vec(&out)?, stations))
    }
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let mut collector = Collector { http, positions: Positions::parse(STATIONS_TSV), days: HashMap::new() };
    loop {
        let wait = match collector.collect().await {
            Ok((body, stations)) => {
                info!(stations, octets = body.len(), "qualité de l'air : mesures des stations mises à jour");
                state.set_air_mesures(body);
                REFRESH_EVERY
            }
            Err(error) => {
                warn!("qualité de l'air : mesures indisponibles : {error:#}");
                RETRY_AFTER
            }
        };
        tokio::time::sleep(wait).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cinq stations d'après le fichier réel du 18 novembre 2026 (heures de 13 h à 16 h TU) : Metz-Centre
    /// (tous les polluants), Marseille 5 avenues, Atton (aucune valeur : « N », « -1 »), une station de La Réunion
    /// (outre-mer) et une station de métropole absente des coordonnées.
    const FICHIER: &str = include_str!("testdata/air_mesures_extrait.csv");
    const COORDONNEES: &str = "FR01011\t49.11944\t6.18083\tMetz\tMetz-Centre\nFR01016\t48.88639\t6.09361\tAtton\tAtton\nFR03043\t43.30529\t5.39472\tMarseille 4E Arrondissement\tMARSEILLE 5 AVENUES\n";

    fn t(text: &str) -> i64 {
        parse_time(text).unwrap()
    }

    fn lu() -> (DayFile, Positions) {
        let positions = Positions::parse(COORDONNEES);
        (parse_file(FICHIER.as_bytes(), &positions).unwrap(), positions)
    }

    fn pollutant<'a>(out: &'a Out, name: &str, code: &str) -> &'a [Option<f32>] {
        let station = out.stations.code.iter().position(|c| c == code).unwrap() as u32;
        let p = &out.pollutants[name];
        &p.v[p.i.iter().position(|i| *i == station).unwrap()]
    }

    #[test]
    fn lit_les_heures_en_temps_universel() {
        assert_eq!(t("2026/11/18 17:00:00"), "2026-11-18T17:00:00Z".parse::<Timestamp>().unwrap().as_second());
        assert_eq!(parse_time("n'importe quoi"), None);
    }

    #[test]
    fn garde_les_valeurs_valides_des_stations_de_metropole_connues() {
        let (file, _) = lu();
        // Métropole localisée seulement : ni La Réunion ni la station sans coordonnées.
        let mut codes: Vec<_> = file.meta.keys().cloned().collect();
        codes.sort();
        assert_eq!(codes, ["FR01011", "FR03043"]);
        // Atton n'a que des lignes « N » (valeur vide, validité -1) : rien n'est retenu pour elle.
        assert!(!file.readings.keys().any(|(code, _)| code == "FR01016"));
        // Les polluants hors liste (NO, NOX, CO, benzène) sont ignorés.
        assert!(file.readings.keys().all(|(_, pol)| *pol < 5));
        assert_eq!(file.meta["FR01011"], Meta { name: "Metz-Centre".into(), org: "ATMO GRAND EST".into(), implantation: 0, influence: 0 });
    }

    #[test]
    fn sert_les_24_dernieres_heures_en_colonnes() {
        let (file, positions) = lu();
        let out = build(&[&file], &positions, 123).unwrap();
        assert_eq!(out.updated_at, 123);
        assert_eq!(out.end, t("2026/11/18 16:00:00"));
        assert_eq!(out.stations.code, ["FR01011", "FR03043"]);
        assert_eq!(out.stations.commune[0], "Metz");
        assert_eq!((out.stations.lon[0], out.stations.lat[0]), (6.18083, 49.11944));
        assert_eq!(out.orgs.len(), 2);
        // Quatre heures relevées (13 h à 16 h) : les 20 premières tranches sont vides, la dernière est l'heure close à 16 h.
        let no2 = pollutant(&out, "NO2", "FR01011");
        assert_eq!(no2.len(), WINDOW);
        assert!(no2[..20].iter().all(Option::is_none));
        assert_eq!(&no2[20..], [Some(1.4), Some(2.4), Some(2.9), Some(3.3)]);
        // L'ozone est marqué « 4 » et « R » (brut) : valide quand même.
        assert_eq!(pollutant(&out, "O3", "FR01011")[23], Some(77.1));
    }

    #[test]
    fn complete_avec_la_veille_et_laisse_les_trous() {
        let (today, positions) = lu();
        // La veille : une valeur à 23 h, une autre à minuit (fin de la dernière heure du jour).
        let mut yesterday = DayFile::default();
        yesterday.meta = today.meta.clone();
        yesterday.readings.insert(("FR01011".into(), 0), vec![(t("2026/11/18 00:00:00"), 9.0), (t("2026/11/17 23:00:00"), 8.0)]);
        let out = build(&[&yesterday, &today], &positions, 0).unwrap();
        let no2 = pollutant(&out, "NO2", "FR01011");
        // Fin 16 h : la tranche 0 se termine le 17 à 17 h ; minuit du 18 est la tranche 7, 23 h du 17 la tranche 6.
        assert_eq!((no2[6], no2[7]), (Some(8.0), Some(9.0)));
        assert!(no2[8..20].iter().all(Option::is_none), "les heures non publiées restent des trous");
        assert_eq!(no2[23], Some(3.3));
    }

    #[test]
    fn ecarte_les_valeurs_invalides_et_ramene_le_bruit_negatif_a_zero() {
        let positions = Positions::parse(COORDONNEES);
        let en_tete = FICHIER.lines().next().unwrap();
        let ligne = |fin: &str, polluant: &str, valeur: &str, validite: &str| {
            format!("\"2026/11/18 00:00:00\";\"{fin}\";\"ATMO GRAND EST\";\"FR44ZAG02\";\"ZAG METZ\";\"FR01011\";\"Metz-Centre\";\"Urbaine\";\"{polluant}\";\"Trafic\";\"A\";\"Oui\";\"mesures fixes\";\"p\";\"moyenne horaire brute\";\"{valeur}\";\"0\";\"µg-m3\";;;;\"A\";\"{validite}\"")
        };
        let corps = [
            en_tete.to_string(),
            ligne("2026/11/18 01:00:00", "NO2", "-1.2", "1"),
            ligne("2026/11/18 02:00:00", "NO2", "12.34", "1"),
            ligne("2026/11/18 03:00:00", "NO2", "50", "-1"),
            ligne("2026/11/18 04:00:00", "NO2", "", "1"),
            ligne("2026/11/18 05:00:00", "NO2", "60", "0"),
            ligne("2026/11/18 06:00:00", "PM10", "oups", "1"),
        ]
        .join("\r\n");
        let file = parse_file(corps.as_bytes(), &positions).unwrap();
        let out = build(&[&file], &positions, 0).unwrap();
        assert_eq!(out.end, t("2026/11/18 02:00:00"));
        let no2 = pollutant(&out, "NO2", "FR01011");
        assert_eq!(&no2[22..], [Some(0.0), Some(12.3)]);
        assert!(!out.pollutants.contains_key("PM10"));
        // Trafic : dans la fiche, « station de trafic ».
        assert_eq!(out.stations.infl, [1]);
    }

    #[test]
    fn distingue_les_types_de_station() {
        assert_eq!((implantation("Urbaine"), implantation("Périurbaine"), implantation("Rurale régionale"), implantation("Rurale nationale")), (0, 1, 2, 2));
        assert_eq!((influence("Fond"), influence("Trafic"), influence("Industrielle")), (0, 1, 2));
    }

    #[test]
    fn refuse_un_flux_sans_mesure_ou_sans_colonne() {
        let positions = Positions::parse(COORDONNEES);
        assert!(build(&[&DayFile::default()], &positions, 0).is_err());
        assert!(parse_file(b"a;b\n1;2\n", &positions).is_err());
    }

    #[test]
    fn serialise_en_colonnes() {
        let (file, positions) = lu();
        let json = serde_json::to_value(build(&[&file], &positions, 7).unwrap()).unwrap();
        assert_eq!(json["updatedAt"], 7);
        assert_eq!(json["pollutants"]["NO2"]["i"].as_array().unwrap().len(), json["pollutants"]["NO2"]["v"].as_array().unwrap().len());
        // En texte, un f32 s'écrit au plus court (3.3) ; via `Value` il redeviendrait un f64 (3.2999999…).
        let text = serde_json::to_string(&build(&[&file], &positions, 7).unwrap()).unwrap();
        assert!(text.contains("[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,1.4,2.4,2.9,3.3]"));
        assert!(json["pollutants"]["NO2"]["v"][0][0].is_null());
    }

    #[test]
    fn la_table_des_stations_embarquee_est_lisible() {
        let positions = Positions::parse(STATIONS_TSV);
        assert!(positions.0.len() > 700);
        let metz = &positions.0["FR01011"];
        assert_eq!((metz.lat, metz.lon), (49.11944, 6.18083));
    }

    /// Relevé réel (réseau) : `AIR_MESURES_SORTIE=/chemin/sortie.json cargo test releve_reel -- --ignored --nocapture`.
    /// Sert à regarder la réponse et à mesurer la mémoire d'un tour de collecte (`/usr/bin/time -l`).
    #[tokio::test]
    #[ignore = "demande le réseau"]
    async fn releve_reel() {
        let http = reqwest::Client::builder().user_agent("carte-vivante/test").build().unwrap();
        let mut collector = Collector { http, positions: Positions::parse(STATIONS_TSV), days: HashMap::new() };
        let (body, stations) = collector.collect().await.unwrap();
        println!("{stations} stations, {} octets", body.len());
        if let Ok(path) = std::env::var("AIR_MESURES_SORTIE") {
            std::fs::write(path, body).unwrap();
        }
    }

    #[test]
    fn adresse_du_fichier_du_jour() {
        assert_eq!(
            file_url("2026-11-18".parse().unwrap()),
            "https://ineris.s3.rbx.io.cloud.ovh.net/lcsqa/concentrations-de-polluants-atmospheriques-reglementes/temps-reel/2026/FR_E2_2026-11-18.csv"
        );
    }
}
