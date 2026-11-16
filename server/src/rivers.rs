//! Rivières en direct : hauteur et débit des stations hydrométriques de métropole, avec la tendance sur 3 heures.
//!
//! # La source
//!
//! Hub'Eau, API « Hydrométrie » (OFB et BRGM, données du Service central Vigicrues et de la banque Hydro), sans clé :
//! - `referentiel/stations` : les stations en service (code, nom, cours d'eau, position) ;
//! - `observations_tr` : les observations en temps réel, hauteur `H` (millimètres) et débit `Q` (litres par seconde), une
//!   mesure toutes les 5 à 60 minutes selon la station, un mois d'historique au plus, brutes (non validées).
//!
//! Licence : Licence Ouverte (Etalab), avec citation de la source (conditions générales de Hub'Eau). Limites relevées : la
//! pagination de `observations_tr` se fait par curseur (suivre `next`), 20 000 résultats au plus par page, des adresses de
//! 2 083 caractères au plus ; la plateforme se synchronise avec la banque Hydro toutes les 5 minutes, et l'OFB et le BRGM
//! se réservent de bloquer une adresse trop gourmande. D'où la sobriété ci-dessous.
//!
//! # Ce que le serveur demande, et à quel rythme
//!
//! - **Une fois par jour** : le référentiel des stations (3 pages de 2 000, champs réduits au strict nécessaire) ;
//! - **toutes les 15 minutes** : les observations des 90 dernières minutes de toute la France, hauteurs puis débits, par
//!   lots de 20 000 (`date_debut_obs`, curseur, champs réduits, gzip) : environ 2 + 1 requêtes, quelques centaines de
//!   kilo-octets compressés. La première fois, la fenêtre est de 4 heures (4 + 5 requêtes) pour pouvoir calculer la
//!   tendance tout de suite ;
//! - **toutes les 30 minutes** : le bulletin Vigicrues (`InfoVigiCru.geojson`), pour repérer les stations situées sur un
//!   tronçon en vigilance jaune, orange ou rouge ;
//! - **à l'ouverture d'une fiche** : la courbe de 48 heures de la station (une requête, gardée 10 minutes).
//!
//! Aucune requête par station dans la boucle de relevé. Le serveur garde, par station, les hauteurs des 6 dernières heures
//! et le dernier débit : quelques centaines de milliers d'octets en tout. Les stations qui ne transmettent que des débits
//! ne sont pas montrées (la couche est une couche de hauteurs d'eau).
//!
//! # La tendance
//!
//! `d` est la variation de la hauteur sur 3 heures, en millimètres : dernière hauteur moins la hauteur trois heures plus
//! tôt (la mesure la plus proche, entre 1 h et 4 h avant la dernière, ramenée à 3 h si l'écart n'est pas exactement de
//! 3 h). Sans mesure assez ancienne, elle est absente. Le seuil entre « stable » et « monte » est choisi par le site.
//! Aucune comparaison à l'historique de la station : Hub'Eau ne donne pas de seuil de crue par station sans une requête
//! par station, et l'on n'invente pas de « normale ».

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::Path as UrlPath;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use flate2::read::GzDecoder;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

const BASE_URL: &str = "https://hubeau.eaufrance.fr/api/v2/hydrometrie";
const VIGICRUES_URL: &str = "https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson";
/// Rythme du relevé des observations.
const REFRESH_EVERY: Duration = Duration::from_secs(15 * 60);
/// Fenêtre des relevés courants (on relit un peu large : les mesures arrivent parfois avec du retard).
const WINDOW_S: i64 = 90 * 60;
/// Fenêtre du premier relevé : de quoi calculer la tendance tout de suite.
const FIRST_WINDOW_S: i64 = 4 * 3600;
/// Hauteurs gardées par station.
const KEEP_S: i64 = 6 * 3600;
const STATIONS_EVERY: Duration = Duration::from_secs(24 * 3600);
const VIGICRUES_EVERY: Duration = Duration::from_secs(30 * 60);
const PAGE_SIZE: usize = 20_000;
/// Garde-fou : jamais plus de pages que cela par relevé.
const MAX_PAGES: usize = 40;
/// Pause entre deux pages d'un même relevé.
const PAGE_PAUSE: Duration = Duration::from_millis(400);
/// Une station sans mesure depuis plus de cela n'est plus « récente » (le site la grise).
const STALE_AFTER_S: i64 = 3 * 3600;
/// Une station muette depuis une semaine disparaît.
const FORGET_AFTER_S: i64 = 7 * 86_400;
/// Distance au-delà de laquelle une station n'est plus rattachée à un tronçon Vigicrues.
const VIGICRUES_RADIUS_M: f64 = 1500.0;
/// Courbe de fiche : durée, durée de conservation, nombre d'entrées au plus.
const SERIES_HOURS: i64 = 48;
const SERIES_TTL: Duration = Duration::from_secs(10 * 60);
const SERIES_MAX_ENTRIES: usize = 200;
/// Au-delà de ce nombre de points, la courbe est amincie (une mesure sur deux, etc.).
const SERIES_MAX_POINTS: usize = 300;

/// Rectangle de la France métropolitaine, Corse comprise (ouest, sud, est, nord).
const FRANCE: (f64, f64, f64, f64) = (-5.6, 41.2, 10.0, 51.4);

static LIVE: RwLock<Option<Bytes>> = RwLock::new(None);
/// Codes des stations publiées : la route des courbes ne relaie que celles-là.
static KNOWN: RwLock<Option<HashSet<String>>> = RwLock::new(None);
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static SERIES: Mutex<Option<HashMap<String, (Bytes, Instant)>>> = Mutex::new(None);
/// Une seule demande de courbe à la fois vers Hub'Eau.
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// --- Ce que dit Hub'Eau (ce dont on se sert) ---

#[derive(Deserialize)]
struct StationsPage {
    data: Vec<StationDef>,
}

#[derive(Deserialize, Clone)]
struct StationDef {
    code_station: String,
    libelle_station: Option<String>,
    libelle_cours_eau: Option<String>,
    longitude_station: Option<f64>,
    latitude_station: Option<f64>,
}

#[derive(Deserialize)]
struct ObsPage<'a> {
    #[serde(borrow)]
    data: Vec<Obs<'a>>,
    next: Option<String>,
}

#[derive(Deserialize)]
struct Obs<'a> {
    /// Absent sur certaines observations rattachées à un site seulement : on les ignore.
    code_station: Option<&'a str>,
    date_obs: Option<&'a str>,
    resultat_obs: Option<f64>,
}

// --- Le bulletin Vigicrues ---

#[derive(Deserialize)]
struct VigicruesCollection {
    features: Vec<VigicruesFeature>,
}

#[derive(Deserialize)]
struct VigicruesFeature {
    properties: VigicruesProperties,
    geometry: VigicruesGeometry,
}

#[derive(Deserialize)]
struct VigicruesProperties {
    lbentcru: String,
    /// Le niveau est parfois un nombre, parfois un texte.
    #[serde(rename = "NivInfViCr")]
    level: serde_json::Value,
}

#[derive(Deserialize)]
struct VigicruesGeometry {
    coordinates: Vec<Vec<[f64; 2]>>,
}

/// Un tronçon en vigilance jaune, orange ou rouge.
struct Section {
    name: String,
    level: u8,
    lines: Vec<Vec<[f64; 2]>>,
}

// --- État du relevé ---

struct Station {
    def: StationDef,
    /// Hauteurs en millimètres : (secondes UTC, valeur), triées par instant.
    heights: Vec<(i64, i32)>,
    /// Dernier débit en litres par seconde : (secondes UTC, valeur).
    flow: Option<(i64, f32)>,
}

// --- Ce que reçoit le site ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StationOut<'a> {
    id: &'a str,
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    river: Option<&'a str>,
    lon: f64,
    lat: f64,
    /// Dernière hauteur (millimètres) et son heure (secondes UTC).
    h: i32,
    t: i64,
    /// Variation sur 3 heures (millimètres), absente si l'on manque de recul.
    #[serde(skip_serializing_if = "Option::is_none")]
    d: Option<i32>,
    /// Dernier débit (litres par seconde) et son heure.
    #[serde(skip_serializing_if = "Option::is_none")]
    q: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qt: Option<i64>,
    /// Niveau de vigilance Vigicrues (2 jaune, 3 orange, 4 rouge) du tronçon voisin, et son nom.
    #[serde(skip_serializing_if = "Option::is_none")]
    vig: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vig_name: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RiversOut<'a> {
    updated_at: i64,
    stations: Vec<StationOut<'a>>,
}

#[derive(Serialize)]
struct SeriesOut<'a> {
    id: &'a str,
    /// `[secondes UTC, millimètres]`, plus ancien d'abord.
    points: Vec<[i64; 2]>,
}

// --- Décodage ---

fn parse_time(text: &str) -> Option<i64> {
    text.parse::<Timestamp>().ok().map(|t| t.as_second())
}

fn level_of(value: &serde_json::Value) -> u8 {
    match value {
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(1) as u8,
        serde_json::Value::String(s) => s.trim().parse().unwrap_or(1),
        _ => 1,
    }
}

fn in_france(lon: f64, lat: f64) -> bool {
    lon >= FRANCE.0 && lat >= FRANCE.1 && lon <= FRANCE.2 && lat <= FRANCE.3
}

/// Variation sur 3 heures en millimètres, d'après des hauteurs triées. `None` si aucune mesure n'est entre 1 h et 4 h
/// avant la dernière ; sinon la mesure la plus proche de 3 h, la variation étant ramenée à 3 h (une station qui ne
/// transmet que depuis peu, ou par à-coups, n'a pas toujours 3 h de recul).
fn change_over_3h(heights: &[(i64, i32)]) -> Option<i32> {
    let &(last_t, last_h) = heights.last()?;
    let target = last_t - 3 * 3600;
    let &(t, h) = heights
        .iter()
        .filter(|(t, _)| (3600..=4 * 3600).contains(&(last_t - t)))
        .min_by_key(|(t, _)| (t - target).abs())?;
    let span = (last_t - t) as f64;
    Some((f64::from(last_h - h) * 3.0 * 3600.0 / span).round() as i32)
}

fn decode_stations(body: &[u8]) -> Result<Vec<StationDef>> {
    let page: StationsPage = serde_json::from_slice(body).context("référentiel illisible")?;
    Ok(page.data)
}

/// Les points d'une page d'observations : `(code, instant, valeur)`, et l'adresse de la page suivante.
type Point = (String, i64, f64);

fn decode_observations(body: &[u8]) -> Result<(Vec<Point>, Option<String>)> {
    let page: ObsPage = serde_json::from_slice(body).context("observations illisibles")?;
    let points = page
        .data
        .iter()
        .filter_map(|o| Some((o.code_station?.to_string(), parse_time(o.date_obs?)?, o.resultat_obs?)))
        .collect();
    Ok((points, page.next))
}

fn decode_vigicrues(body: &[u8]) -> Result<Vec<Section>> {
    let collection: VigicruesCollection = serde_json::from_slice(body).context("bulletin Vigicrues illisible")?;
    Ok(collection
        .features
        .into_iter()
        .filter_map(|f| {
            let level = level_of(&f.properties.level);
            (level >= 2).then_some(Section { name: f.properties.lbentcru, level, lines: f.geometry.coordinates })
        })
        .collect())
}

/// Distance en mètres d'un point à un segment (projection plane locale, assez juste à quelques kilomètres).
fn distance_to_segment(point: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let k = point[1].to_radians().cos();
    let to_xy = |p: [f64; 2]| [(p[0] - point[0]) * k * 111_320.0, (p[1] - point[1]) * 110_540.0];
    let (a, b) = (to_xy(a), to_xy(b));
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    let u = if len2 == 0.0 { 0.0 } else { (-(a[0] * dx + a[1] * dy) / len2).clamp(0.0, 1.0) };
    let (x, y) = (a[0] + u * dx, a[1] + u * dy);
    (x * x + y * y).sqrt()
}

/// Le tronçon en vigilance le plus proche de la station, s'il est à moins de `VIGICRUES_RADIUS_M`.
fn nearest_section(sections: &[Section], lon: f64, lat: f64) -> Option<&Section> {
    let mut best: Option<(&Section, f64)> = None;
    for section in sections {
        for line in &section.lines {
            for pair in line.windows(2) {
                let d = distance_to_segment([lon, lat], pair[0], pair[1]);
                if d <= VIGICRUES_RADIUS_M && best.is_none_or(|(_, b)| d < b) {
                    best = Some((section, d));
                }
            }
        }
    }
    best.map(|(s, _)| s)
}

// --- Réseau ---

async fn get_bytes(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let response = http.get(url).header(header::ACCEPT_ENCODING, "gzip").send().await?.error_for_status()?;
    let gzipped = response.headers().get(header::CONTENT_ENCODING).is_some_and(|v| v == "gzip");
    let body = response.bytes().await?;
    if gzipped {
        let mut out = Vec::with_capacity(body.len() * 8);
        GzDecoder::new(&body[..]).read_to_end(&mut out).context("réponse gzip illisible")?;
        Ok(out)
    } else {
        Ok(body.to_vec())
    }
}

async fn fetch_stations(http: &reqwest::Client) -> Result<Vec<StationDef>> {
    let fields = "code_station,libelle_station,libelle_cours_eau,latitude_station,longitude_station";
    let mut out = Vec::new();
    for page in 1..=4 {
        let url = format!("{BASE_URL}/referentiel/stations?en_service=1&size=2000&page={page}&fields={fields}");
        let batch = decode_stations(&get_bytes(http, &url).await?)?;
        let full = batch.len() >= 2000;
        out.extend(batch);
        if !full {
            break;
        }
        tokio::time::sleep(PAGE_PAUSE).await;
    }
    Ok(out)
}

/// Relève les observations de la grandeur `H` ou `Q` depuis `from`, page après page, et passe chaque page à `apply`.
async fn fetch_observations(http: &reqwest::Client, quantity: &str, from: i64, mut apply: impl FnMut(Vec<Point>)) -> Result<usize> {
    let since = Timestamp::from_second(from)?.strftime("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut url = format!(
        "{BASE_URL}/observations_tr?grandeur_hydro={quantity}&date_debut_obs={since}&size={PAGE_SIZE}&fields=code_station,date_obs,resultat_obs"
    );
    let mut total = 0;
    for page in 0..MAX_PAGES {
        let body = get_bytes(http, &url).await?;
        let (points, next) = decode_observations(&body)?;
        drop(body);
        total += points.len();
        let empty = points.is_empty();
        apply(points);
        match next {
            // On ne suit que des adresses de Hub'Eau.
            Some(next) if !empty && next.starts_with(BASE_URL) => url = next,
            _ => return Ok(total),
        }
        if page + 1 == MAX_PAGES {
            warn!("rivières : relevé interrompu après {MAX_PAGES} pages");
        }
        tokio::time::sleep(PAGE_PAUSE).await;
    }
    Ok(total)
}

pub async fn poll_forever(http: reqwest::Client) {
    let _ = CLIENT.set(http.clone());
    let mut stations: HashMap<String, Station> = HashMap::new();
    let mut defs_at: Option<Instant> = None;
    let mut sections: Vec<Section> = Vec::new();
    let mut sections_at: Option<Instant> = None;
    let mut first = true;
    loop {
        if defs_at.is_none_or(|at| at.elapsed() >= STATIONS_EVERY) {
            match fetch_stations(&http).await {
                Ok(defs) => {
                    let kept: HashMap<String, StationDef> = defs
                        .into_iter()
                        .filter(|d| matches!((d.longitude_station, d.latitude_station), (Some(lon), Some(lat)) if in_france(lon, lat)))
                        .map(|d| (d.code_station.clone(), d))
                        .collect();
                    info!(stations = kept.len(), "rivières : référentiel mis à jour");
                    for (code, def) in kept {
                        stations.entry(code).and_modify(|s| s.def = def.clone()).or_insert(Station { def, heights: Vec::new(), flow: None });
                    }
                    defs_at = Some(Instant::now());
                }
                Err(error) => warn!("rivières : référentiel indisponible : {error:#}"),
            }
        }
        if sections_at.is_none_or(|at| at.elapsed() >= VIGICRUES_EVERY) {
            match get_bytes(&http, VIGICRUES_URL).await.and_then(|b| decode_vigicrues(&b)) {
                Ok(found) => {
                    sections = found;
                    sections_at = Some(Instant::now());
                }
                Err(error) => warn!("rivières : bulletin Vigicrues indisponible : {error:#}"),
            }
        }
        if !stations.is_empty() {
            let now = Timestamp::now().as_second();
            let from = now - if first { FIRST_WINDOW_S } else { WINDOW_S };
            let heights = fetch_observations(&http, "H", from, |points| {
                for (code, t, value) in points {
                    if let Some(station) = stations.get_mut(&code) {
                        station.heights.push((t, value.round() as i32));
                    }
                }
            })
            .await;
            let flows = fetch_observations(&http, "Q", from, |points| {
                for (code, t, value) in points {
                    if let Some(station) = stations.get_mut(&code) {
                        if station.flow.is_none_or(|(old, _)| t > old) {
                            station.flow = Some((t, value as f32));
                        }
                    }
                }
            })
            .await;
            match (&heights, &flows) {
                (Ok(h), Ok(q)) => {
                    info!(hauteurs = h, debits = q, "rivières : observations relevées");
                    first = false;
                }
                (Err(error), _) | (_, Err(error)) => warn!("rivières : relevé incomplet : {error:#}"),
            }
            for station in stations.values_mut() {
                tidy(&mut station.heights, now);
            }
            stations.retain(|_, s| s.heights.last().is_some_and(|(t, _)| now - t < FORGET_AFTER_S) || s.flow.is_some_and(|(t, _)| now - t < FORGET_AFTER_S));
            publish(&stations, &sections, now);
        }
        tokio::time::sleep(REFRESH_EVERY).await;
    }
}

/// Trie, retire les doublons et ne garde que `KEEP_S` (en gardant au moins la dernière mesure).
fn tidy(heights: &mut Vec<(i64, i32)>, now: i64) {
    heights.sort_unstable_by_key(|(t, _)| *t);
    heights.dedup_by_key(|(t, _)| *t);
    let keep_from = heights.partition_point(|(t, _)| *t < now - KEEP_S).min(heights.len().saturating_sub(1));
    heights.drain(..keep_from);
}

fn round5(x: f64) -> f64 {
    (x * 1e5).round() / 1e5
}

fn publish(stations: &HashMap<String, Station>, sections: &[Section], now: i64) {
    let mut out: Vec<StationOut> = stations
        .values()
        .filter_map(|s| {
            let &(t, h) = s.heights.last()?;
            let (lon, lat) = (s.def.longitude_station?, s.def.latitude_station?);
            let section = nearest_section(sections, lon, lat);
            Some(StationOut {
                id: &s.def.code_station,
                name: s.def.libelle_station.as_deref().unwrap_or(&s.def.code_station),
                river: s.def.libelle_cours_eau.as_deref(),
                lon: round5(lon),
                lat: round5(lat),
                h,
                t,
                d: change_over_3h(&s.heights),
                q: s.flow.map(|(_, q)| q),
                qt: s.flow.map(|(t, _)| t),
                vig: section.map(|x| x.level),
                vig_name: section.map(|x| x.name.as_str()),
            })
        })
        .collect();
    if out.is_empty() {
        return;
    }
    out.sort_by(|a, b| a.id.cmp(b.id));
    let fresh = out.iter().filter(|s| now - s.t < STALE_AFTER_S).count();
    let count = out.len();
    let codes: HashSet<String> = out.iter().map(|s| s.id.to_string()).collect();
    match serde_json::to_vec(&RiversOut { updated_at: now, stations: out }) {
        Ok(body) => {
            info!(stations = count, recentes = fresh, octets = body.len(), "rivières : stations mises à jour");
            *LIVE.write().expect("verrou des rivières") = Some(Bytes::from(body));
            *KNOWN.write().expect("verrou des stations de rivières") = Some(codes);
        }
        Err(error) => warn!("rivières : réponse impossible à écrire : {error}"),
    }
}

// --- Routes ---

/// `GET /api/rivieres` : les stations avec leur dernière hauteur, leur débit et leur tendance.
pub fn response() -> Response {
    match LIVE.read().expect("verrou des rivières").clone() {
        Some(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "rivières : première collecte en cours").into_response(),
    }
}

fn series_body(code: &str, body: &[u8]) -> Result<Vec<u8>> {
    let (points, _) = decode_observations(body)?;
    let mut points: Vec<[i64; 2]> = points.into_iter().map(|(_, t, v)| [t, v.round() as i64]).collect();
    points.sort_unstable_by_key(|p| p[0]);
    points.dedup_by_key(|p| p[0]);
    // Une station à 5 minutes donne 576 points sur 48 h : au-delà de 300, on n'en garde que la moitié, le tiers…
    let stride = points.len().div_ceil(SERIES_MAX_POINTS).max(1);
    if stride > 1 {
        let last = points.last().copied();
        points = points.into_iter().step_by(stride).collect();
        if let (Some(last), Some(kept)) = (last, points.last().copied()) {
            if last != kept {
                points.push(last);
            }
        }
    }
    Ok(serde_json::to_vec(&SeriesOut { id: code, points })?)
}

/// `GET /api/rivieres/{code}` : les 48 dernières heures de hauteur d'une station (une requête à Hub'Eau, gardée 10 minutes).
pub async fn series_handler(UrlPath(code): UrlPath<String>) -> Response {
    let known = KNOWN.read().expect("verrou des stations de rivières").as_ref().is_some_and(|k| k.contains(&code));
    if !known || code.len() > 16 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return (StatusCode::NOT_FOUND, "station inconnue").into_response();
    }
    let cached = |code: &str| {
        let mut cache = SERIES.lock().expect("verrou des courbes de rivières");
        let map = cache.get_or_insert_with(HashMap::new);
        map.retain(|_, (_, at)| at.elapsed() < SERIES_TTL);
        map.get(code).map(|(body, _)| body.clone())
    };
    let respond = |body: Bytes| ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "public, max-age=300")], body).into_response();
    if let Some(body) = cached(&code) {
        return respond(body);
    }
    let Some(http) = CLIENT.get() else { return (StatusCode::SERVICE_UNAVAILABLE, "rivières : pas prêt").into_response() };
    // Une demande à la fois : deux fiches ouvertes en même temps attendent leur tour, la seconde lit le cache de la première.
    let _turn = GATE.lock().await;
    if let Some(body) = cached(&code) {
        return respond(body);
    }
    let from = Timestamp::now().as_second() - SERIES_HOURS * 3600;
    let Ok(since) = Timestamp::from_second(from).map(|t| t.strftime("%Y-%m-%dT%H:%M:%SZ").to_string()) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "date invalide").into_response();
    };
    let url = format!(
        "{BASE_URL}/observations_tr?code_entite={code}&grandeur_hydro=H&date_debut_obs={since}&size=2000&sort=asc&fields=code_station,date_obs,resultat_obs"
    );
    match get_bytes(http, &url).await.and_then(|body| series_body(&code, &body)) {
        Ok(body) => {
            let body = Bytes::from(body);
            let mut cache = SERIES.lock().expect("verrou des courbes de rivières");
            let map = cache.get_or_insert_with(HashMap::new);
            if map.len() >= SERIES_MAX_ENTRIES {
                if let Some(oldest) = map.iter().min_by_key(|(_, (_, at))| *at).map(|(k, _)| k.clone()) {
                    map.remove(&oldest);
                }
            }
            map.insert(code, (body.clone(), Instant::now()));
            respond(body)
        }
        Err(error) => {
            warn!(station = %code, "rivières : courbe impossible : {error:#}");
            (StatusCode::BAD_GATEWAY, "Hub'Eau n'a pas donné la courbe").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATIONS: &str = include_str!("testdata/rivieres_stations_extrait.json");
    const HEIGHTS: &str = include_str!("testdata/rivieres_hauteurs_extrait.json");
    const FLOWS: &str = include_str!("testdata/rivieres_debits_extrait.json");
    const VIGICRUES: &str = include_str!("testdata/rivieres_vigicrues_extrait.json");

    #[test]
    fn decodes_the_stations_and_keeps_only_france() {
        let defs = decode_stations(STATIONS.as_bytes()).unwrap();
        assert_eq!(defs.len(), 4);
        let moselle = defs.iter().find(|d| d.code_station == "A402061001").unwrap();
        assert_eq!(moselle.libelle_station.as_deref(), Some("La Moselle à Fresse-sur-Moselle"));
        assert!(in_france(moselle.longitude_station.unwrap(), moselle.latitude_station.unwrap()));
        // La Guadeloupe est écartée.
        let goyaves = defs.iter().find(|d| d.code_station == "1011000101").unwrap();
        assert!(!in_france(goyaves.longitude_station.unwrap(), goyaves.latitude_station.unwrap()));
    }

    #[test]
    fn decodes_heights_and_flows() {
        let (points, next) = decode_observations(HEIGHTS.as_bytes()).unwrap();
        assert!(!points.is_empty());
        assert!(points.iter().all(|(code, t, _)| !code.is_empty() && *t > 1_700_000_000));
        assert!(next.is_none_or(|n| n.starts_with(BASE_URL)));
        let (flows, _) = decode_observations(FLOWS.as_bytes()).unwrap();
        assert_eq!(flows.len(), 6);
        assert!(flows.iter().all(|(code, _, v)| code == "K055001010" && *v > 0.0));
    }

    #[test]
    fn ignores_observations_without_a_station() {
        // Réponse réelle de Hub'Eau : une observation de débit sans code de station au milieu des autres.
        let body = r#"{"next":null,"data":[{"code_station":"O001004003","date_obs":"2026-11-16T13:45:00Z","resultat_obs":10200.0},{"code_station":null,"date_obs":"2026-11-16T13:45:00Z","resultat_obs":10200.0},{"code_station":"O001004004","date_obs":"2026-11-16T13:45:00Z","resultat_obs":null}]}"#;
        let (points, _) = decode_observations(body.as_bytes()).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].0, "O001004003");
        assert_eq!(points[0].2, 10200.0);
    }

    #[test]
    fn computes_the_three_hour_change() {
        // Une mesure toutes les 30 minutes, +40 mm toutes les 30 minutes : +240 mm en 3 h.
        let heights: Vec<(i64, i32)> = (0..9).map(|i| (1_800_000_000 + i * 1800, 1000 + 40 * i as i32)).collect();
        assert_eq!(change_over_3h(&heights), Some(240));
        // Pas assez de recul (30 minutes) : rien.
        assert_eq!(change_over_3h(&heights[7..]), None);
        // Un recul de 2 h seulement est ramené à 3 h : +160 mm en 2 h, soit +240 mm en 3 h ; de même pour 1 h.
        assert_eq!(change_over_3h(&heights[4..]), Some(240));
        assert_eq!(change_over_3h(&heights[6..]), Some(240));
        assert_eq!(change_over_3h(&[]), None);
    }

    #[test]
    fn tidy_sorts_dedups_and_keeps_the_last_measure() {
        let now = 1_800_000_000;
        let mut heights = vec![(now - 100, 5), (now - 30_000, 1), (now - 100, 5), (now - 7_000, 2)];
        tidy(&mut heights, now);
        assert_eq!(heights, vec![(now - 7_000, 2), (now - 100, 5)]);
        // Une station muette garde sa dernière mesure.
        let mut old = vec![(now - 90_000, 3)];
        tidy(&mut old, now);
        assert_eq!(old.len(), 1);
    }

    #[test]
    fn links_a_station_to_the_section_in_vigilance() {
        let sections = decode_vigicrues(VIGICRUES.as_bytes()).unwrap();
        // Seul le Vistre (jaune) est retenu : le Golo est vert.
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].name, "Vistre");
        assert_eq!(sections[0].level, 2);
        let on_the_line = sections[0].lines[0][1];
        let near = nearest_section(&sections, on_the_line[0] + 0.001, on_the_line[1]).expect("une station à 80 m du tronçon");
        assert_eq!(near.name, "Vistre");
        // À plusieurs dizaines de kilomètres : rien.
        assert!(nearest_section(&sections, on_the_line[0] + 0.5, on_the_line[1]).is_none());
    }

    #[test]
    fn builds_the_series_for_the_card() {
        let body = series_body("K055001010", HEIGHTS.as_bytes()).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["id"], "K055001010");
        let points = json["points"].as_array().unwrap();
        assert!(points.len() > 2);
        assert!(points.windows(2).all(|w| w[0][0].as_i64() < w[1][0].as_i64()));
    }

    #[test]
    fn thins_long_series_and_keeps_the_last_point() {
        let observations: Vec<String> = (0..600)
            .map(|i| format!(r#"{{"code_station":"X","date_obs":"2026-11-16T{:02}:{:02}:00Z","resultat_obs":{}}}"#, (i / 60) % 24, i % 60, 1000 + i))
            .collect();
        let body = format!(r#"{{"data":[{}],"next":null}}"#, observations.join(","));
        let out: serde_json::Value = serde_json::from_slice(&series_body("X", body.as_bytes()).unwrap()).unwrap();
        let points = out["points"].as_array().unwrap();
        assert!(points.len() <= SERIES_MAX_POINTS + 1);
        assert_eq!(points.last().unwrap()[1], 1599);
    }
}
