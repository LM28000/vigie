//! Caméras de vidéoprotection d'OpenStreetMap : les points `man_made=surveillance` de la France
//! métropolitaine (environ 80 000), extraits **une fois par semaine** de l'API Overpass.
//!
//! Pourquoi une extraction préparée plutôt qu'une requête Overpass par zone regardée : Overpass est
//! un service gratuit souvent saturé (voir `rails.rs`), une requête par déplacement de carte serait
//! à la fois lente et peu polie, alors que la base change peu. Trente requêtes (trente rectangles de
//! la France), l'une après l'autre, espacées de 5 s, une fois par semaine ; le résultat (environ
//! 5 Mo de JSON, 1,5 Mo compressé) est rangé dans `DATA_DIR/cameras/cameras.json.gz` et gardé
//! **compressé** en mémoire : il est servi tel quel, avec `Content-Encoding: gzip`.
//!
//! Format de la réponse : `{ "updatedAt", "cameras": [[id, lon, lat, genre, type, direction,
//! inclinaison, niveau, zone, fixation, hauteur, exploitant], …] }`. Les codes sont expliqués sur
//! `kind`, `camera_type`, `level`, `zone` et `mount`. Seuls les points sont gardés (les rares
//! chemins `man_made=surveillance` n'ont pas de position utile), sans aucune balise de texte libre
//! hors l'exploitant (`operator`), raccourci.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use flate2::Compression;
use flate2::write::GzEncoder;
use jiff::Timestamp;
use serde::Deserialize;
use tracing::{info, warn};

/// La France métropolitaine en 30 rectangles (5 rangées de latitude, 6 colonnes de longitude) : des réponses de
/// quelques Mo au plus (Paris et sa banlieue en font environ 3), qu'Overpass sert sans couper la connexion, là où
/// les six grands rectangles des voies ferrées échouaient.
const LATITUDES: [f64; 6] = [41.3, 43.7, 46.0, 48.3, 49.6, 51.15];
const LON_WEST: f64 = -5.2;
const LON_STEP: f64 = 14.8 / 6.0;

/// Rectangles (sud, ouest, nord, est), de l'ouest vers l'est puis du sud vers le nord.
fn tiles() -> Vec<(f64, f64, f64, f64)> {
    let mut list = Vec::new();
    for rows in LATITUDES.windows(2) {
        for column in 0..6 {
            let west = LON_WEST + LON_STEP * f64::from(column);
            list.push((rows[0], west, rows[1], west + LON_STEP));
        }
    }
    list
}
const FRANCE_AREA: &str = r#"area["ISO3166-1"="FR"]["admin_level"="2"]->.fr;"#;
/// La base OSM change tous les jours, mais une semaine de retard ne gêne pas une carte de repérage.
const REFRESH_EVERY: Duration = Duration::from_secs(7 * 24 * 3600);
const RETRY_AFTER: Duration = Duration::from_secs(3 * 3600);
const PAUSE_BETWEEN_QUERIES: Duration = Duration::from_secs(5);

/// Réponse prête à servir (JSON compressé en gzip).
static BODY: RwLock<Option<Bytes>> = RwLock::new(None);

/// La réponse de `/api/cameras`.
pub fn response() -> Response {
    let body = BODY.read().expect("verrou des caméras").clone();
    match body {
        Some(body) => ([(header::CONTENT_TYPE, "application/json"), (header::CONTENT_ENCODING, "gzip")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "caméras : première collecte en cours").into_response(),
    }
}

/// Fait vivre la couche : relit le cache s'il est récent, sinon interroge Overpass, puis recommence la semaine suivante.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf) {
    let dir = data_dir.join("cameras");
    let cache = dir.join("cameras.json.gz");
    loop {
        let age = cache_age(&cache).await;
        if BODY.read().expect("verrou des caméras").is_none()
            && let Ok(body) = tokio::fs::read(&cache).await
        {
            info!(age_h = age.map_or(-1, |a| (a.as_secs() / 3600) as i64), "caméras : cache chargé");
            *BODY.write().expect("verrou des caméras") = Some(Bytes::from(body));
        }
        if age.is_some_and(|a| a < REFRESH_EVERY) {
            tokio::time::sleep(REFRESH_EVERY - age.unwrap_or_default()).await;
            continue;
        }
        match refresh(&http, &dir, &cache).await {
            Ok((body, count)) => {
                info!(cameras = count, octets = body.len(), "caméras : extraction OpenStreetMap mise à jour");
                *BODY.write().expect("verrou des caméras") = Some(Bytes::from(body));
            }
            Err(error) => {
                warn!("caméras : extraction OpenStreetMap impossible : {error:#}");
                tokio::time::sleep(RETRY_AFTER).await;
            }
        }
    }
}

async fn cache_age(cache: &Path) -> Option<Duration> {
    tokio::fs::metadata(cache).await.ok()?.modified().ok()?.elapsed().ok()
}

async fn refresh(http: &reqwest::Client, dir: &Path, cache: &Path) -> Result<(Vec<u8>, usize)> {
    tokio::fs::create_dir_all(dir).await?;
    let mut rows: Vec<Row> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    let tiles = tiles();
    for (index, (south, west, north, east)) in tiles.iter().enumerate() {
        let query = format!(
            r#"[out:json][timeout:600];{FRANCE_AREA}node["man_made"="surveillance"](area.fr)({south},{west},{north},{east});out body qt;"#
        );
        info!(rectangle = index + 1, total = tiles.len(), "caméras : requête Overpass…");
        let bytes = crate::rails::overpass(http, &query).await.with_context(|| format!("rectangle {}", index + 1))?;
        for row in decode(&bytes)? {
            // Un point sur la limite de deux rectangles peut être rendu deux fois.
            if seen.insert(row.id) {
                rows.push(row);
            }
        }
        tokio::time::sleep(PAUSE_BETWEEN_QUERIES).await;
    }
    let count = rows.len();
    let body = tokio::task::spawn_blocking(move || encode(&rows, Timestamp::now().as_second())).await??;
    let tmp = cache.with_extension("gz.part");
    tokio::fs::write(&tmp, &body).await?;
    tokio::fs::rename(&tmp, cache).await?;
    Ok((body, count))
}

#[derive(Deserialize)]
struct OverpassResponse {
    elements: Vec<Element>,
}

#[derive(Deserialize)]
struct Element {
    #[serde(default)]
    r#type: String,
    id: u64,
    #[serde(default)]
    lat: f64,
    #[serde(default)]
    lon: f64,
    #[serde(default)]
    tags: HashMap<String, String>,
}

/// Une caméra, réduite à ce que la carte affiche.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: u64,
    pub lon: f64,
    pub lat: f64,
    pub kind: u8,
    pub camera_type: u8,
    pub direction: Option<u16>,
    pub tilt: Option<i16>,
    pub level: u8,
    pub zone: u8,
    pub mount: u8,
    pub height: Option<f32>,
    pub operator: String,
}

/// Lit une réponse Overpass (`out body`) et garde les caméras (et lecteurs de plaques).
pub fn decode(bytes: &[u8]) -> Result<Vec<Row>> {
    let response: OverpassResponse = serde_json::from_slice(bytes).context("réponse Overpass illisible")?;
    Ok(response.elements.iter().filter(|e| e.r#type == "node").filter_map(row).collect())
}

fn row(element: &Element) -> Option<Row> {
    let tags = &element.tags;
    if tags.get("man_made").map(String::as_str) != Some("surveillance") {
        return None;
    }
    let tag = |key: &str| tags.get(key).map(|v| v.trim()).filter(|v| !v.is_empty());
    let kind = kind(tag("surveillance:type"))?;
    if !(41.0..=52.0).contains(&element.lat) || !(-6.0..=10.0).contains(&element.lon) {
        return None;
    }
    Some(Row {
        id: element.id,
        lon: (element.lon * 1e5).round() / 1e5,
        lat: (element.lat * 1e5).round() / 1e5,
        kind,
        camera_type: camera_type(tag("camera:type")),
        direction: tag("camera:direction").or(tag("direction")).and_then(parse_direction),
        tilt: tag("camera:angle").and_then(parse_tilt),
        level: level(tag("surveillance")),
        zone: zone(tag("surveillance:zone")),
        mount: mount(tag("camera:mount")),
        height: tag("height").and_then(parse_height),
        operator: truncate(tag("operator").unwrap_or(""), 40),
    })
}

/// Genre : 0 caméra (y compris quand `surveillance:type` n'est pas renseigné : c'est le cas courant),
/// 1 lecture de plaques d'immatriculation. Les gardiens et détecteurs de tirs ne sont pas des caméras : `None`.
fn kind(value: Option<&str>) -> Option<u8> {
    match value.map(str::to_lowercase).as_deref() {
        None | Some("camera") => Some(0),
        Some("alpr") => Some(1),
        _ => None,
    }
}

/// Type de caméra : 0 fixe, 1 dôme, 2 panoramique (qui balaie), 3 autre, 4 inconnu.
fn camera_type(value: Option<&str>) -> u8 {
    match value.map(str::to_lowercase).as_deref() {
        None => 4,
        Some("fixed") => 0,
        Some("dome") => 1,
        Some("panning") => 2,
        Some(_) => 3,
    }
}

/// Niveau (`surveillance`) : 0 espace public, 1 extérieur privé, 2 intérieur, 3 privé, 4 inconnu.
fn level(value: Option<&str>) -> u8 {
    match value.map(str::to_lowercase).as_deref() {
        Some("public") => 0,
        Some("outdoor") => 1,
        Some("indoor") => 2,
        Some("private") => 3,
        _ => 4,
    }
}

/// Zone (`surveillance:zone`) : 0 inconnue, 1 ville et rue, 2 parking, 3 circulation routière, 4 commerce,
/// 5 banque, 6 bâtiment et entrée, 7 gare et quai, 8 autre.
fn zone(value: Option<&str>) -> u8 {
    match value.map(str::to_lowercase).as_deref() {
        None => 0,
        Some("town" | "street" | "area" | "public") => 1,
        Some("parking") => 2,
        Some("traffic") => 3,
        Some("shop") => 4,
        Some("bank") => 5,
        Some("building" | "entrance") => 6,
        Some(z) if z.contains("station") || z.contains("platform") => 7,
        Some(_) => 8,
    }
}

/// Fixation (`camera:mount`) : 0 inconnue, 1 mur, 2 poteau, 3 plafond, 4 lampadaire, 5 feux tricolores,
/// 6 bâtiment ou toit, 7 autre.
fn mount(value: Option<&str>) -> u8 {
    match value.map(str::to_lowercase).as_deref() {
        None => 0,
        Some("wall") => 1,
        Some("pole") => 2,
        Some("ceiling") => 3,
        Some("street_lamp") => 4,
        Some("traffic_signals") => 5,
        Some("building" | "roof") => 6,
        Some(_) => 7,
    }
}

/// Direction en degrés depuis le nord (0 à 359), d'après un nombre (« 125 », « 40° »), un point cardinal
/// (« NE », « SSW ») ou la première valeur d'une liste (« 90;270 »). **360 n'est pas une direction** : les
/// dômes portent souvent `camera:direction=360` pour dire « tout autour » ; on le traite comme inconnu
/// (sinon la moitié des dômes de Paris regarderaient vers le nord).
pub fn parse_direction(value: &str) -> Option<u16> {
    let first = value.split(';').next()?.trim().trim_end_matches('°').trim();
    let cardinal = match first.to_uppercase().as_str() {
        "N" => Some(0.0),
        "NNE" => Some(22.5),
        "NE" => Some(45.0),
        "ENE" => Some(67.5),
        "E" => Some(90.0),
        "ESE" => Some(112.5),
        "SE" => Some(135.0),
        "SSE" => Some(157.5),
        "S" => Some(180.0),
        "SSW" => Some(202.5),
        "SW" => Some(225.0),
        "WSW" => Some(247.5),
        "W" => Some(270.0),
        "WNW" => Some(292.5),
        "NW" => Some(315.0),
        "NNW" => Some(337.5),
        _ => None,
    };
    let degrees = match cardinal {
        Some(d) => d,
        None => first.replace(',', ".").parse::<f64>().ok().filter(|d| d.is_finite())?,
    };
    if !(0.0..360.0).contains(&degrees) {
        return None;
    }
    Some(degrees.round() as u16 % 360)
}

/// Inclinaison (`camera:angle`) : l'angle de la caméra sous l'horizontale, en degrés (de −90 à 90). Le wiki d'OSM
/// le définit ainsi (« camera tilt angle from the horizon plane »), ce n'est pas le champ de vision ; les valeurs
/// absurdes (« NW », 180) sont écartées. Le signe est celui du wiki ; la carte n'utilise que la valeur absolue.
pub fn parse_tilt(value: &str) -> Option<i16> {
    let degrees: f64 = value.trim().trim_end_matches('°').replace(',', ".").parse().ok()?;
    (-90.0..=90.0).contains(&degrees).then(|| degrees.round() as i16)
}

/// Hauteur de fixation en mètres (« 5 », « 6 m », « 4,5 »), de 0 à 100.
pub fn parse_height(value: &str) -> Option<f32> {
    let number: String = value.trim().chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',').collect();
    let meters: f32 = number.replace(',', ".").parse().ok()?;
    (0.0..=100.0).contains(&meters).then_some((meters * 10.0).round() / 10.0)
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max { text } else { format!("{}…", text.chars().take(max).collect::<String>().trim_end()) }
}

/// La réponse JSON, compressée en gzip.
pub fn encode(rows: &[Row], updated_at: i64) -> Result<Vec<u8>> {
    use std::io::Write;
    let mut gzip = GzEncoder::new(Vec::new(), Compression::new(6));
    write!(gzip, "{{\"updatedAt\":{updated_at},\"cameras\":[")?;
    for (i, r) in rows.iter().enumerate() {
        if i > 0 {
            gzip.write_all(b",")?;
        }
        let value = serde_json::json!([
            r.id, r.lon, r.lat, r.kind, r.camera_type, r.direction, r.tilt, r.level, r.zone, r.mount, r.height, r.operator
        ]);
        serde_json::to_writer(&mut gzip, &value)?;
    }
    gzip.write_all(b"]}")?;
    let body = gzip.finish()?;
    if rows.is_empty() {
        bail!("aucune caméra : la réponse d'Overpass est vide");
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Extrait réel d'OpenStreetMap (Paris et Hauts-de-Seine, 15 points, balises utiles seulement).
    const SAMPLE: &str = include_str!("testdata/osm_cameras_extrait.json");

    fn by_id(rows: &[Row], id: u64) -> &Row {
        rows.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("point {id} absent"))
    }

    #[test]
    fn decode_lextrait_osm_et_ecarte_le_gardien() {
        let rows = decode(SAMPLE.as_bytes()).unwrap();
        // 15 points, dont un gardien (`surveillance:type=guard`) qui n'est pas une caméra.
        assert_eq!(rows.len(), 14);
        assert!(rows.iter().all(|r| r.id != 14183014692));

        // Caméra fixe sur mur, direction 125°, extérieur privé, zone « bâtiment ».
        let a = by_id(&rows, 4391359170);
        assert_eq!((a.kind, a.camera_type, a.direction, a.level, a.zone, a.mount), (0, 0, Some(125), 1, 6, 1));
        // Fixe sur poteau à 5 m, espace public, zone « ville ».
        let b = by_id(&rows, 1583552603);
        assert_eq!((b.direction, b.height, b.level, b.zone, b.mount), (Some(265), Some(5.0), 0, 1, 2));
        assert!((b.lon - 2.2).abs() < 1.0 && (b.lat - 48.8).abs() < 0.5);
    }

    #[test]
    fn direction_360_des_domes_est_inconnue() {
        let rows = decode(SAMPLE.as_bytes()).unwrap();
        // « 360° » et « 360 » : tout autour, pas une direction.
        assert_eq!(by_id(&rows, 8748784205).direction, None);
        assert_eq!(by_id(&rows, 8748784208).direction, None);
        assert_eq!(by_id(&rows, 8748784205).operator, "ville clamart");
        // Dôme sans aucune direction.
        let dome = by_id(&rows, 9703484340);
        assert_eq!((dome.camera_type, dome.direction), (1, None));
        // Panoramique en zone « circulation ».
        let panning = by_id(&rows, 3807942266);
        assert_eq!((panning.camera_type, panning.zone, panning.level), (2, 3, 1));
    }

    #[test]
    fn direction_cardinale_et_balise_direction() {
        let rows = decode(SAMPLE.as_bytes()).unwrap();
        // `direction=S` quand `camera:direction` manque.
        assert_eq!(by_id(&rows, 11860260368).direction, Some(180));
        // `camera:direction=E`.
        assert_eq!(by_id(&rows, 13046117969).direction, Some(90));
        assert_eq!(by_id(&rows, 13046117969).zone, 7);
        // Point presque sans balise : une caméra de genre 0, tout le reste inconnu.
        let bare = by_id(&rows, 2307380395);
        assert_eq!((bare.kind, bare.camera_type, bare.level, bare.zone, bare.mount), (0, 4, 1, 0, 0));
    }

    #[test]
    fn inclinaison_valide_ou_ecartee() {
        let rows = decode(SAMPLE.as_bytes()).unwrap();
        // `camera:angle=NW` et `180` : pas une inclinaison.
        assert_eq!(by_id(&rows, 5595296249).tilt, None);
        assert_eq!(by_id(&rows, 4366402491).tilt, None);
        assert_eq!(parse_tilt("-30"), Some(-30));
        assert_eq!(parse_tilt("45°"), Some(45));
        assert_eq!(parse_tilt("90"), Some(90));
        assert_eq!(parse_tilt("91"), None);
    }

    #[test]
    fn analyse_des_valeurs() {
        assert_eq!(parse_direction("125"), Some(125));
        assert_eq!(parse_direction(" 40° "), Some(40));
        assert_eq!(parse_direction("90;270"), Some(90));
        assert_eq!(parse_direction("ssw"), Some(203));
        assert_eq!(parse_direction("0"), Some(0));
        assert_eq!(parse_direction("359.6"), Some(0));
        assert_eq!(parse_direction("360"), None);
        assert_eq!(parse_direction("forward"), None);
        assert_eq!(parse_direction("-10"), None);
        assert_eq!(parse_height("6 m"), Some(6.0));
        assert_eq!(parse_height("4,5"), Some(4.5));
        assert_eq!(parse_height("haut"), None);
        assert_eq!(parse_height("250"), None);
        assert_eq!(zone(Some("station platform")), 7);
        assert_eq!(kind(Some("ALPR")), Some(1));
        assert_eq!(kind(Some("gunshot_detector")), None);
    }

    #[test]
    fn la_reponse_est_un_json_gzip_de_tableaux() {
        let rows = decode(SAMPLE.as_bytes()).unwrap();
        let gz = encode(&rows, 1_700_000_000).unwrap();
        let mut text = String::new();
        flate2::read::GzDecoder::new(gz.as_slice()).read_to_string(&mut text).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["updatedAt"], 1_700_000_000);
        let cameras = json["cameras"].as_array().unwrap();
        assert_eq!(cameras.len(), rows.len());
        let first = &cameras[0];
        assert_eq!(first.as_array().unwrap().len(), 12);
        assert_eq!(first[0], 4391359170u64);
        assert_eq!(first[5], 125);
        assert!(first[6].is_null());
        assert!(encode(&[], 0).is_err());
    }

    #[test]
    fn un_chemin_ou_un_point_hors_de_france_est_ecarte() {
        let json = r#"{"elements":[
            {"type":"way","id":1,"tags":{"man_made":"surveillance"}},
            {"type":"node","id":2,"lat":10.0,"lon":2.0,"tags":{"man_made":"surveillance"}},
            {"type":"node","id":3,"lat":45.0,"lon":2.0,"tags":{"man_made":"surveillance","surveillance:type":"ALPR"}}]}"#;
        let rows = decode(json.as_bytes()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].id, rows[0].kind), (3, 1));
    }
}
