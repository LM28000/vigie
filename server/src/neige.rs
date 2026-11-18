//! Neige et avalanches : le bulletin d'estimation du risque d'avalanche (BRA) de chaque massif des Alpes, des Pyrénées et de
//! la Corse, et la hauteur de neige mesurée aux stations de Météo-France des départements de montagne.
//!
//! # Les sources (portail API de Météo-France, clé dans `METEOFRANCE_API_KEY`, en-tête `apikey`, côté serveur seulement)
//!
//! - **« Données Publiques BRA »** : `DPBRA/v1/massif/BRA?id-massif=<n>&format=xml`, un bulletin XML par massif (risque de 1 à 5
//!   par tranche d'altitude, orientations de pentes dangereuses, enneigement, neige fraîche, textes, dates de rédaction et de
//!   validité). Les bulletins sont rédigés vers 16 h pour le lendemain, de début novembre à fin mai environ. Les identifiants
//!   des 35 massifs sont ceux du descriptif Météo-France : ils sont embarqués avec les contours (`data/massifs_bra.geojson`,
//!   fichier « Metadata massifs » publié par Météo-France sur data.gouv.fr, Licence Ouverte 2.0).
//! - **« Données Publiques Paquet Observation »** : `DPPaquetObs/v1/paquet/horaire?id-departement=<dép.>&format=json`, la
//!   dernière observation horaire de toutes les stations d'un département, dont `sss`, la hauteur totale de neige au sol (en
//!   mètres) pour celles qui la mesurent ; les noms et altitudes viennent de `DPObs/v2/liste-stations` (CSV).
//! - **« Données Publiques Observation »** (v2) seule, sans le Paquet : `DPObs/v2/station/horaire?id_station=<id>&format=json`,
//!   station par station. Quand le paquet d'un département est refusé (`403`, abonnement absent), le serveur interroge ainsi
//!   les stations des départements de montagne situées à 800 m ou plus (environ 160), au même rythme espacé.
//!
//! # Quotas : on ne demande que ce qu'il faut
//!
//! Le portail limite à environ 50 requêtes par minute. Le serveur espace ses requêtes (`PACE`) et s'arrête au premier refus
//! `429` :
//! - **les 35 bulletins : deux fois par jour au plus** (un relevé après la parution de 17 h 30, heure de Paris, un autre douze
//!   heures plus tard au plus tôt), soit 70 requêtes par jour ; tout est gardé en mémoire et sur disque
//!   (`DATA_DIR/neige/bulletins.json`) : un redémarrage ne redemande rien, et **la fiche d'un massif ne coûte aucune requête**,
//!   elle relit la mémoire ;
//! - **les stations** : une requête par département de montagne (13), toutes les heures, plus la liste des stations une fois
//!   par jour, soit environ 340 requêtes par jour ; sans le Paquet, une requête par station de montagne (environ 160) toutes
//!   les heures, soit environ 3 900 requêtes par jour, sous la limite de 100 par minute de l'abonnement Observation.
//!
//! # Sans clé, ou hors saison
//!
//! Sans clé, le serveur démarre normalement et ne fait aucune requête : `/api/neige` répond `503` « clé Météo-France absente ».
//! Hors saison (aucun massif n'a de bulletin : le portail répond `404` ou vide), la réponse est `200`, les massifs sont là sans
//! bulletin (`b` absent) : le site dit « pas de bulletin en cours », pas une erreur. Un bulletin dont la validité est finie
//! depuis plus de 6 heures n'est plus servi comme « en cours » (le site le dit expiré).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, OnceLock, RwLock};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::extract::Path as UrlPath;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

const DEFAULT_BASE: &str = "https://public-api.meteofrance.fr/public";
/// Pause entre deux requêtes : 1,4 s, soit moins de 45 requêtes par minute.
const PACE: Duration = Duration::from_millis(1400);
/// Réveil de la boucle : on regarde alors ce qui est à relever.
const TICK: Duration = Duration::from_secs(60);
/// Deux relevés des bulletins par jour au plus : au moins 12 h entre deux, et le jour même après la parution de 17 h 30.
const BULLETINS_MIN_GAP_S: i64 = 12 * 3600;
const BULLETINS_AFTER_HOUR: (i8, i8) = (17, 30);
/// Après un échec, on réessaie dans une demi-heure.
const RETRY_AFTER_S: i64 = 30 * 60;
const STATIONS_EVERY_S: i64 = 3600;
const STATION_LIST_EVERY_S: i64 = 24 * 3600;
const STATIONS_REFUSED_RETRY_S: i64 = 6 * 3600;
/// Un bulletin n'est plus « en cours » 6 h après la fin de sa validité (le suivant paraît dans l'après-midi).
pub const GRACE_S: i64 = 6 * 3600;
/// Les départements de montagne qui ont un massif BRA.
const DEPARTMENTS: [&str; 13] = ["74", "73", "38", "05", "04", "06", "2A", "2B", "64", "65", "31", "09", "66"];
/// Sans le Paquet, on n'interroge une à une que les stations assez hautes pour avoir de la neige au sol.
const MIN_STATION_ALT_M: i32 = 800;

static MASSIFS: OnceLock<Vec<MassifDef>> = OnceLock::new();
static STATE: LazyLock<RwLock<State>> = LazyLock::new(|| RwLock::new(State::new()));
static REQUESTS: AtomicUsize = AtomicUsize::new(0);

// --- Les massifs (contours Météo-France embarqués) ---

#[derive(Debug, Clone)]
pub struct MassifDef {
    pub id: u16,
    pub name: String,
    pub mountain: String,
    pub dep: String,
    pub lon: f64,
    pub lat: f64,
    /// Ouest, sud, est, nord.
    pub bounds: [f64; 4],
}

#[derive(Deserialize)]
struct GeoCollection {
    features: Vec<GeoFeature>,
}
#[derive(Deserialize)]
struct GeoFeature {
    properties: GeoProps,
    geometry: GeoGeometry,
}
#[derive(Deserialize)]
struct GeoProps {
    code: u16,
    name: String,
    mountain: String,
    dep: String,
    lon: f64,
    lat: f64,
}
#[derive(Deserialize)]
struct GeoGeometry {
    coordinates: Vec<Vec<Vec<[f64; 2]>>>,
}

pub fn massifs() -> &'static [MassifDef] {
    MASSIFS.get_or_init(|| {
        let collection: GeoCollection = serde_json::from_str(include_str!("data/massifs_bra.geojson")).expect("contours des massifs BRA embarqués");
        collection
            .features
            .into_iter()
            .map(|f| {
                let mut bounds = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
                for [lon, lat] in f.geometry.coordinates.iter().flatten().flatten() {
                    bounds = [bounds[0].min(*lon), bounds[1].min(*lat), bounds[2].max(*lon), bounds[3].max(*lat)];
                }
                MassifDef { id: f.properties.code, name: f.properties.name, mountain: f.properties.mountain, dep: f.properties.dep, lon: f.properties.lon, lat: f.properties.lat, bounds }
            })
            .collect()
    })
}

pub fn massif(id: u16) -> Option<&'static MassifDef> {
    massifs().iter().find(|m| m.id == id)
}

// --- Le bulletin décodé ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnowLevel {
    pub alt: i32,
    /// Épaisseur de neige (cm) en versant nord et en versant sud.
    pub n: i32,
    pub s: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FreshDay {
    /// Jour (secondes UTC de minuit, heure de Paris).
    pub date: i64,
    /// Neige fraîche en 24 h (cm), à `fresh_altitude`, et équivalent en eau (mm).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rr: Option<i32>,
}

/// Un bulletin d'estimation du risque d'avalanche (BRA), ce qu'on en garde.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bulletin {
    pub id: u16,
    pub name: String,
    /// Rédaction, fin de validité, diffusion (secondes UTC).
    pub issued: i64,
    pub valid_until: i64,
    pub broadcast: i64,
    pub amended: bool,
    /// Risque (1 à 5) sous et au-dessus de `altitude` (mètres) ; sans altitude, `risk_low` vaut pour tout le massif.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_low: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_high: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub altitude: Option<i32>,
    /// Évolution du risque dans la journée (valeur en fin de journée), sous et au-dessus de l'altitude.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evol_low: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evol_high: Option<u8>,
    /// Risque maximal du massif pour la période de validité, et pour le surlendemain (`risk_j2_date`, minuit Paris, secondes UTC).
    pub risk_max: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_j2: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_j2_date: Option<i64>,
    pub risk_comment: String,
    /// Orientations de pentes particulièrement dangereuses : N, NE, E, SE, S, SW, W, NW.
    pub slopes: Vec<String>,
    pub slopes_comment: String,
    pub accidental: String,
    pub natural: String,
    pub summary: String,
    pub risk_j2_text: String,
    pub risk_j2_comment: String,
    pub stability_title: String,
    pub stability_text: String,
    pub quality_text: String,
    /// Limites sud et nord de la neige (mètres), à la date du bulletin ; `-1` : pas de limite.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snow_limit_south: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snow_limit_north: Option<i32>,
    pub snow_levels: Vec<SnowLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fresh_altitude: Option<i32>,
    pub fresh: Vec<FreshDay>,
}

const SLOPES: [&str; 8] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/// Une date locale du bulletin (« 2026-11-16T16:00:00 », heure de Paris, sans fuseau) en secondes UTC.
fn paris_second(text: &str) -> Option<i64> {
    let civil: DateTime = text.trim().parse().ok()?;
    let zone = TimeZone::get("Europe/Paris").ok()?;
    civil.to_zoned(zone).ok().map(|z| z.timestamp().as_second())
}

fn int_attr(node: roxmltree::Node, name: &str) -> Option<i32> {
    node.attribute(name).and_then(|v| v.trim().parse().ok())
}

fn risk_attr(node: roxmltree::Node, name: &str) -> Option<u8> {
    int_attr(node, name).filter(|r| (1..=5).contains(r)).map(|r| r as u8)
}

fn child<'a, 'i>(parent: roxmltree::Node<'a, 'i>, tag: &str) -> Option<roxmltree::Node<'a, 'i>> {
    parent.children().find(|c| c.has_tag_name(tag))
}

fn text_of(node: roxmltree::Node, tag: &str) -> String {
    node.children().find(|c| c.has_tag_name(tag)).map(|c| c.text().unwrap_or("").trim().to_string()).unwrap_or_default()
}

/// Décode le XML d'un bulletin (voir le descriptif « Bulletin du risque d'avalanche, format XML » de Météo-France).
pub fn parse_bulletin(xml: &str) -> Result<Bulletin> {
    let document = roxmltree::Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() })
        .context("XML du bulletin illisible")?;
    let root = document.root_element();
    if !root.has_tag_name("BULLETINS_NEIGE_AVALANCHE") {
        bail!("ce n'est pas un bulletin de risque d'avalanche ({})", root.tag_name().name());
    }
    let id: u16 = root.attribute("ID").and_then(|v| v.trim().parse().ok()).context("identifiant du massif absent")?;
    let issued = root.attribute("DATEBULLETIN").and_then(paris_second).context("date de rédaction absente")?;
    let valid_until = root.attribute("DATEVALIDITE").or_else(|| root.attribute("DATEECHEANCE")).and_then(paris_second).context("date de validité absente")?;
    let mut bulletin = Bulletin {
        id,
        name: root.attribute("MASSIF").unwrap_or_default().to_string(),
        issued,
        valid_until,
        broadcast: root.attribute("DATEDIFFUSION").and_then(paris_second).unwrap_or(issued),
        amended: root.attribute("AMENDEMENT") == Some("true"),
        ..Bulletin::default()
    };
    if let Some(cartouche) = child(root, "CARTOUCHERISQUE") {
        if let Some(r) = child(cartouche, "RISQUE") {
            bulletin.risk_low = risk_attr(r, "RISQUE1");
            bulletin.risk_high = risk_attr(r, "RISQUE2");
            bulletin.altitude = int_attr(r, "ALTITUDE").filter(|a| *a > 0);
            bulletin.evol_low = risk_attr(r, "EVOLURISQUE1");
            bulletin.evol_high = risk_attr(r, "EVOLURISQUE2");
            bulletin.risk_max = risk_attr(r, "RISQUEMAXI").or(bulletin.risk_high).or(bulletin.risk_low).unwrap_or(0);
            bulletin.risk_j2 = risk_attr(r, "RISQUEMAXIJ2");
            bulletin.risk_j2_date = r.attribute("DATE_RISQUE_J2").and_then(paris_second);
            bulletin.risk_comment = r.attribute("COMMENTAIRE").unwrap_or_default().trim().to_string();
            // Sans altitude, le risque ne change pas avec elle : un seul risque pour tout le massif.
            if bulletin.altitude.is_none() {
                bulletin.risk_high = None;
                bulletin.evol_high = None;
            }
        }
        if let Some(p) = child(cartouche, "PENTE") {
            bulletin.slopes = SLOPES.iter().filter(|name| p.attribute(**name) == Some("true")).map(|s| s.to_string()).collect();
            bulletin.slopes_comment = p.attribute("COMMENTAIRE").unwrap_or_default().trim().to_string();
        }
        bulletin.accidental = text_of(cartouche, "ACCIDENTEL");
        bulletin.natural = text_of(cartouche, "NATUREL");
        bulletin.summary = text_of(cartouche, "RESUME");
        bulletin.risk_j2_text = text_of(cartouche, "RisqueJ2");
        bulletin.risk_j2_comment = text_of(cartouche, "CommentaireRisqueJ2");
    }
    if bulletin.risk_max == 0 {
        bail!("bulletin sans risque");
    }
    if let Some(stability) = child(root, "STABILITE") {
        bulletin.stability_title = text_of(stability, "TITRE");
        bulletin.stability_text = text_of(stability, "TEXTESANSTITRE");
    }
    if let Some(quality) = child(root, "QUALITE") {
        bulletin.quality_text = text_of(quality, "TEXTE");
    }
    if let Some(snow) = child(root, "ENNEIGEMENT") {
        bulletin.snow_limit_south = int_attr(snow, "LimiteSud");
        bulletin.snow_limit_north = int_attr(snow, "LimiteNord");
        bulletin.snow_levels = snow
            .children()
            .filter(|c| c.has_tag_name("NIVEAU"))
            .filter_map(|c| Some(SnowLevel { alt: int_attr(c, "ALTI")?, n: int_attr(c, "N").unwrap_or(0), s: int_attr(c, "S").unwrap_or(0) }))
            .collect();
    }
    if let Some(fresh) = child(root, "NEIGEFRAICHE") {
        bulletin.fresh_altitude = int_attr(fresh, "ALTITUDESS");
        bulletin.fresh = fresh
            .children()
            .filter(|c| c.has_tag_name("NEIGE24H"))
            .filter_map(|c| Some(FreshDay { date: paris_second(c.attribute("DATE")?)?, min: int_attr(c, "SS24Min"), max: int_attr(c, "SS24Max"), rr: int_attr(c, "RR24") }))
            .collect();
    }
    Ok(bulletin)
}

// --- Les stations (hauteur de neige) ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnowStation {
    pub id: String,
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    /// Altitude de la station (mètres), si la liste des stations la donne.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<i32>,
    /// Hauteur de neige au sol (centimètres) et heure de la mesure (secondes UTC).
    pub cm: i32,
    pub t: i64,
}

/// Les observations horaires d'un département : seules celles qui ont `sss` (hauteur de neige, en mètres) sont gardées.
/// Une station qui apparaît plusieurs fois garde sa mesure la plus récente.
pub fn parse_observations(body: &[u8]) -> Result<Vec<SnowStation>> {
    let value: serde_json::Value = serde_json::from_slice(body).context("observations illisibles")?;
    let rows = match &value {
        serde_json::Value::Array(rows) => rows.as_slice(),
        serde_json::Value::Object(map) => map.get("data").and_then(|d| d.as_array()).map(Vec::as_slice).unwrap_or_default(),
        _ => bail!("observations : forme inattendue"),
    };
    let number = |v: Option<&serde_json::Value>| match v? {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    let mut best: HashMap<String, SnowStation> = HashMap::new();
    for row in rows {
        let id = match row.get("geo_id_insee") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => format!("{:08}", n.as_u64().unwrap_or(0)),
            _ => continue,
        };
        let Some(sss) = number(row.get("sss")).filter(|v| v.is_finite() && (0.0..=15.0).contains(v)) else { continue };
        let (Some(lon), Some(lat)) = (number(row.get("lon")), number(row.get("lat"))) else { continue };
        let Some(t) = row.get("validity_time").or_else(|| row.get("reference_time")).and_then(|v| v.as_str()).and_then(|v| v.parse::<Timestamp>().ok()) else { continue };
        let station = SnowStation { name: id.clone(), id: id.clone(), lon, lat, alt: None, cm: (sss * 100.0).round() as i32, t: t.as_second() };
        match best.get(&id) {
            Some(known) if known.t >= station.t => {}
            _ => {
                best.insert(id, station);
            }
        }
    }
    Ok(best.into_values().collect())
}

/// La liste des stations (CSV séparé par des points-virgules : `Id_station;Id_omm;Nom_usuel;Latitude;Longitude;Altitude;…`) :
/// identifiant → (nom, altitude).
pub fn parse_station_list(body: &str) -> HashMap<String, (String, Option<i32>)> {
    let mut lines = body.lines();
    let Some(header) = lines.next() else { return HashMap::new() };
    let columns: Vec<String> = header.trim_start_matches('\u{feff}').split(';').map(|c| c.trim().to_lowercase()).collect();
    let find = |name: &str| columns.iter().position(|c| c == name);
    let (Some(id), Some(name)) = (find("id_station"), find("nom_usuel")) else { return HashMap::new() };
    let altitude = find("altitude");
    lines
        .filter_map(|line| {
            let cells: Vec<&str> = line.split(';').collect();
            let id = cells.get(id)?.trim().to_string();
            let name = cells.get(name)?.trim();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let alt = altitude.and_then(|i| cells.get(i)).and_then(|a| a.trim().parse::<f64>().ok()).map(|a| a.round() as i32);
            Some((id, (title_case(name), alt)))
        })
        .collect()
}

/// « VAL D ISERE » → « Val d'Isère » serait trop ambitieux : on met seulement une majuscule à chaque mot.
fn title_case(name: &str) -> String {
    name.split(' ')
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// --- L'état ---

struct State {
    /// Clé présente : sinon la couche dit « clé Météo-France absente ».
    key: bool,
    /// Instant du dernier relevé complet des bulletins (même sans bulletin : hors saison).
    fetched_at: Option<i64>,
    /// Dernier échec (dernier relevé qui n'a pas abouti), pour les journaux et pour réessayer.
    failed_at: Option<i64>,
    bulletins: BTreeMap<u16, Bulletin>,
    stations: Vec<SnowStation>,
    stations_at: Option<i64>,
    /// Dernier échec du relevé des stations et sa raison (par exemple l'abonnement à l'API Observation non accordé).
    stations_failed_at: Option<i64>,
    stations_error: Option<String>,
    names: HashMap<String, (String, Option<i32>)>,
    names_at: Option<i64>,
    /// Massifs dont le dernier relevé a échoué : redemandés seuls dans une demi-heure (pas les 35).
    retry: Vec<u16>,
    /// Réponse prête de `/api/neige`.
    live: Option<Bytes>,
}

impl State {
    fn new() -> Self {
        State { key: false, fetched_at: None, failed_at: None, bulletins: BTreeMap::new(), stations: Vec::new(), stations_at: None, stations_failed_at: None, stations_error: None, names: HashMap::new(), names_at: None, retry: Vec::new(), live: None }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    fetched_at: i64,
    bulletins: Vec<Bulletin>,
}

// --- Ce que reçoit le site ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MassifOut<'a> {
    id: u16,
    name: &'a str,
    mountain: &'a str,
    dep: &'a str,
    lon: f64,
    lat: f64,
    /// Le bulletin en cours, absent hors saison ou sans bulletin.
    #[serde(skip_serializing_if = "Option::is_none")]
    b: Option<BulletinOut<'a>>,
}

/// Le bulletin sans ses textes (ils sont à `/api/neige/{id}`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BulletinOut<'a> {
    issued: i64,
    valid_until: i64,
    amended: bool,
    /// Risque maximal du massif (1 à 5).
    risk: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    risk_low: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    risk_high: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    altitude: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evol_low: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evol_high: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    risk_j2: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    risk_j2_date: Option<i64>,
    slopes: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    snow_limit_south: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snow_limit_north: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NeigeOut<'a> {
    updated_at: i64,
    /// Relevé des bulletins (secondes UTC), absent avant le premier.
    #[serde(skip_serializing_if = "Option::is_none")]
    bulletins_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stations_at: Option<i64>,
    /// Pourquoi les hauteurs de neige manquent (abonnement refusé, erreur), absent quand tout va bien.
    #[serde(skip_serializing_if = "Option::is_none")]
    stations_error: Option<&'a str>,
    /// Vrai quand au moins un massif a un bulletin en cours.
    season: bool,
    massifs: Vec<MassifOut<'a>>,
    stations: &'a [SnowStation],
}

/// Ce que le site peut dire de l'échec des stations, sans détail technique.
fn stations_reason(error: &str) -> &'static str {
    if error.contains("refusé") { "API Observation de Météo-France non accordée à cette clé" } else { "relevé des stations en échec" }
}

/// Le bulletin d'un massif s'il est encore « en cours » à l'instant `now`.
fn current(bulletin: &Bulletin, now: i64) -> bool {
    now <= bulletin.valid_until + GRACE_S
}

fn publish(state: &mut State, now: i64) {
    let massifs: Vec<MassifOut> = massifs()
        .iter()
        .map(|m| MassifOut {
            id: m.id,
            name: &m.name,
            mountain: &m.mountain,
            dep: &m.dep,
            lon: m.lon,
            lat: m.lat,
            b: state.bulletins.get(&m.id).filter(|b| current(b, now)).map(|b| BulletinOut {
                issued: b.issued,
                valid_until: b.valid_until,
                amended: b.amended,
                risk: b.risk_max,
                risk_low: b.risk_low,
                risk_high: b.risk_high,
                altitude: b.altitude,
                evol_low: b.evol_low,
                evol_high: b.evol_high,
                risk_j2: b.risk_j2,
                risk_j2_date: b.risk_j2_date,
                slopes: &b.slopes,
                snow_limit_south: b.snow_limit_south,
                snow_limit_north: b.snow_limit_north,
            }),
        })
        .collect();
    let season = massifs.iter().any(|m| m.b.is_some());
    let out = NeigeOut { updated_at: now, bulletins_at: state.fetched_at, stations_at: state.stations_at, stations_error: state.stations_error.as_deref().map(stations_reason), season, massifs, stations: &state.stations };
    match serde_json::to_vec(&out) {
        Ok(body) => state.live = Some(Bytes::from(body)),
        Err(error) => warn!("neige : réponse impossible à écrire : {error}"),
    }
}

/// La réponse prête de `/api/neige`, ou `None` (pas de clé, ou premier relevé pas encore fait).
pub fn live() -> Option<Bytes> {
    STATE.read().expect("verrou de la neige").live.clone()
}

/// Un bulletin en cours, pour la synthèse et la veille : massif, risque maximal, détail par altitude.
#[derive(Debug, Clone, PartialEq)]
pub struct Warning {
    pub id: u16,
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub bounds: [f64; 4],
    pub risk: u8,
    pub risk_low: Option<u8>,
    pub risk_high: Option<u8>,
    pub altitude: Option<i32>,
    pub issued: i64,
    pub valid_until: i64,
}

/// Les bulletins en cours à `now` (`None` sans clé ou avant le premier relevé : la rubrique est « indisponible », pas « calme »).
pub fn warnings(now: i64) -> Option<Vec<Warning>> {
    let state = STATE.read().expect("verrou de la neige");
    state.fetched_at?;
    Some(
        massifs()
            .iter()
            .filter_map(|m| {
                let b = state.bulletins.get(&m.id).filter(|b| current(b, now))?;
                Some(Warning {
                    id: m.id,
                    name: m.name.clone(),
                    lon: m.lon,
                    lat: m.lat,
                    bounds: m.bounds,
                    risk: b.risk_max,
                    risk_low: b.risk_low,
                    risk_high: b.risk_high,
                    altitude: b.altitude,
                    issued: b.issued,
                    valid_until: b.valid_until,
                })
            })
            .collect(),
    )
}

// --- Relevés ---

fn base() -> String {
    // Surcharge pour les essais (un serveur local qui rejoue des bulletins) : jamais utile en production.
    std::env::var("METEOFRANCE_API_BASE").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| DEFAULT_BASE.to_string()).trim_end_matches('/').to_string()
}

fn api_key() -> Option<String> {
    std::env::var("METEOFRANCE_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// Plafond de requêtes par processus (`METEOFRANCE_MAX_REQUETES`) : un garde-fou pour les essais, absent par défaut.
fn request_budget() -> Option<usize> {
    std::env::var("METEOFRANCE_MAX_REQUETES").ok().and_then(|v| v.trim().parse().ok())
}

enum Fetched {
    Body(Vec<u8>),
    /// 404, 204 ou corps vide : pas de bulletin (ou pas de données).
    Nothing,
    /// 429 : on arrête là.
    RateLimited,
}

async fn get(http: &reqwest::Client, key: &str, url: &str) -> Result<Fetched> {
    if let Some(max) = request_budget() {
        if REQUESTS.load(Ordering::Relaxed) >= max {
            bail!("plafond de {max} requêtes atteint (METEOFRANCE_MAX_REQUETES)");
        }
    }
    REQUESTS.fetch_add(1, Ordering::Relaxed);
    let response = http.get(url).header("apikey", key).header(header::ACCEPT, "*/*").timeout(Duration::from_secs(40)).send().await?;
    let status = response.status();
    match status.as_u16() {
        200 => {
            let body = response.bytes().await?.to_vec();
            Ok(if body.iter().all(u8::is_ascii_whitespace) { Fetched::Nothing } else { Fetched::Body(body) })
        }
        204 | 404 => Ok(Fetched::Nothing),
        429 => Ok(Fetched::RateLimited),
        401 | 403 => bail!("clé Météo-France refusée (HTTP {status}) : vérifier l'abonnement aux API « BRA » et « Observation »"),
        _ => bail!("Météo-France a répondu {status}"),
    }
}

/// Les bulletins relevés, et les massifs dont le relevé a échoué (à redemander seuls, plus tard).
struct Harvest {
    found: Vec<Bulletin>,
    failed: Vec<u16>,
}

/// Relève les bulletins des massifs `ids`. `Ok(None)` : le portail a limité le débit, le relevé est abandonné.
async fn fetch_bulletins(http: &reqwest::Client, key: &str, ids: &[u16]) -> Result<Option<Harvest>> {
    let base = base();
    let mut found = Vec::new();
    let mut failed = Vec::new();
    let mut missing = 0;
    let mut errors = 0;
    for m in massifs().iter().filter(|m| ids.contains(&m.id)) {
        let url = format!("{base}/DPBRA/v1/massif/BRA?id-massif={}&format=xml", m.id);
        match get(http, key, &url).await {
            Ok(Fetched::Body(body)) => match std::str::from_utf8(&body).map_err(anyhow::Error::from).and_then(parse_bulletin) {
                Ok(bulletin) if bulletin.id == m.id => found.push(bulletin),
                Ok(other) => {
                    warn!(massif = m.id, recu = other.id, "neige : bulletin d'un autre massif, ignoré");
                    errors += 1;
                    failed.push(m.id);
                }
                Err(error) => {
                    warn!(massif = m.id, "neige : bulletin illisible : {error:#}");
                    errors += 1;
                    failed.push(m.id);
                }
            },
            Ok(Fetched::Nothing) => missing += 1,
            Ok(Fetched::RateLimited) => {
                warn!("neige : le portail Météo-France limite le débit, relevé abandonné");
                return Ok(None);
            }
            Err(error) => {
                // Un refus de clé ou un plafond arrête tout ; une erreur isolée (réseau, 5xx) n'arrête pas les autres massifs.
                let text = format!("{error:#}");
                if text.contains("clé Météo-France refusée") || text.contains("plafond") {
                    return Err(error);
                }
                warn!(massif = m.id, "neige : bulletin non relevé : {text}");
                errors += 1;
                failed.push(m.id);
            }
        }
        tokio::time::sleep(PACE).await;
    }
    if found.is_empty() && errors > 0 {
        bail!("aucun bulletin relevé ({errors} erreurs)");
    }
    info!(bulletins = found.len(), sans_bulletin = missing, erreurs = errors, "neige : bulletins relevés");
    Ok(Some(Harvest { found, failed }))
}

async fn fetch_station_list(http: &reqwest::Client, key: &str) -> Result<Option<HashMap<String, (String, Option<i32>)>>> {
    let url = format!("{}/DPObs/v2/liste-stations", base());
    match get(http, key, &url).await? {
        Fetched::Body(body) => Ok(Some(parse_station_list(&String::from_utf8_lossy(&body)))),
        Fetched::Nothing => Ok(Some(HashMap::new())),
        Fetched::RateLimited => Ok(None),
    }
}

/// Les stations de montagne à interroger une à une (sans le Paquet) : départements des massifs, 800 m ou plus.
/// Les identifiants commencent par le numéro du département (« 20 » pour la Corse).
pub fn mountain_stations(names: &HashMap<String, (String, Option<i32>)>) -> Vec<String> {
    let mut ids: Vec<String> = names
        .iter()
        .filter(|(id, (_, alt))| {
            let department = id.get(..2).unwrap_or_default();
            let mountain = DEPARTMENTS.contains(&department) || (department == "20" && DEPARTMENTS.contains(&"2A"));
            mountain && alt.is_some_and(|a| a >= MIN_STATION_ALT_M)
        })
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    ids
}

async fn fetch_stations(http: &reqwest::Client, key: &str, names: &HashMap<String, (String, Option<i32>)>) -> Result<Option<Vec<SnowStation>>> {
    let base = base();
    let mut all = Vec::new();
    for department in DEPARTMENTS {
        let url = format!("{base}/DPPaquetObs/v1/paquet/horaire?id-departement={department}&format=json");
        match get(http, key, &url).await {
            Ok(Fetched::Body(body)) => match parse_observations(&body) {
                Ok(mut stations) => all.append(&mut stations),
                Err(error) => warn!(departement = department, "neige : observations illisibles : {error:#}"),
            },
            Ok(Fetched::Nothing) => {}
            Ok(Fetched::RateLimited) => return Ok(None),
            Err(error) => {
                let text = format!("{error:#}");
                // Le Paquet n'est pas accordé à cette clé : l'API Observation seule suffit, station par station.
                if text.contains("clé Météo-France refusée") && all.is_empty() {
                    tokio::time::sleep(PACE).await;
                    return fetch_stations_one_by_one(http, key, names).await;
                }
                if text.contains("clé Météo-France refusée") || text.contains("plafond") {
                    return Err(error);
                }
                warn!(departement = department, "neige : observations non relevées : {text}");
            }
        }
        tokio::time::sleep(PACE).await;
    }
    Ok(Some(all))
}

async fn fetch_stations_one_by_one(http: &reqwest::Client, key: &str, names: &HashMap<String, (String, Option<i32>)>) -> Result<Option<Vec<SnowStation>>> {
    let ids = mountain_stations(names);
    if ids.is_empty() {
        bail!("liste des stations Météo-France absente : relevé station par station impossible");
    }
    let base = base();
    let mut all = Vec::new();
    for id in &ids {
        let url = format!("{base}/DPObs/v2/station/horaire?id_station={id}&format=json");
        match get(http, key, &url).await? {
            Fetched::Body(body) => match parse_observations(&body) {
                Ok(mut stations) => all.append(&mut stations),
                Err(error) => warn!(station = %id, "neige : observation illisible : {error:#}"),
            },
            Fetched::Nothing => {}
            Fetched::RateLimited => return Ok(None),
        }
        tokio::time::sleep(PACE).await;
    }
    info!(interrogees = ids.len(), "neige : stations interrogées une à une (sans le Paquet Observation)");
    Ok(Some(all))
}

fn save_path(dir: &Path) -> PathBuf {
    dir.join("neige").join("bulletins.json")
}

async fn save(dir: &Path, fetched_at: i64, bulletins: &BTreeMap<u16, Bulletin>) {
    let saved = Saved { fetched_at, bulletins: bulletins.values().cloned().collect() };
    let path = save_path(dir);
    let result = async {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, serde_json::to_vec(&saved)?).await?;
        tokio::fs::rename(&tmp, &path).await?;
        anyhow::Ok(())
    }
    .await;
    if let Err(error) = result {
        warn!("neige : bulletins non enregistrés : {error:#}");
    }
}

/// Faut-il relever les bulletins ? Deux fois par jour au plus : 12 h après le dernier relevé, et dans la journée seulement
/// après la parution de 17 h 30 (heure de Paris).
fn bulletins_due(fetched_at: Option<i64>, failed_at: Option<i64>, now: i64) -> bool {
    if failed_at.is_some_and(|f| now - f < RETRY_AFTER_S) {
        return false;
    }
    let Some(last) = fetched_at else { return true };
    if now - last < BULLETINS_MIN_GAP_S {
        return false;
    }
    let zone = TimeZone::get("Europe/Paris").unwrap_or(TimeZone::UTC);
    let paris = Timestamp::from_second(now).map(|t| t.to_zoned(zone.clone()));
    let Ok(paris) = paris else { return true };
    let release = paris.date().to_zoned(zone).ok().and_then(|midnight| {
        midnight.checked_add(jiff::Span::new().hours(i64::from(BULLETINS_AFTER_HOUR.0)).minutes(i64::from(BULLETINS_AFTER_HOUR.1))).ok()
    });
    match release {
        // Après la parution du jour, et le dernier relevé date d'avant : à relever.
        Some(release) => now >= release.timestamp().as_second() && last < release.timestamp().as_second(),
        None => true,
    }
}

pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf) {
    let Some(key) = api_key() else {
        info!("neige : METEOFRANCE_API_KEY absente, couche désactivée (503 « clé Météo-France absente »)");
        return;
    };
    STATE.write().expect("verrou de la neige").key = true;
    // Relire ce qu'on avait : un redémarrage ne coûte aucune requête.
    if let Ok(bytes) = tokio::fs::read(save_path(&data_dir)).await {
        match serde_json::from_slice::<Saved>(&bytes) {
            Ok(saved) => {
                let mut state = STATE.write().expect("verrou de la neige");
                state.fetched_at = Some(saved.fetched_at);
                state.bulletins = saved.bulletins.into_iter().map(|b| (b.id, b)).collect();
                publish(&mut state, Timestamp::now().as_second());
                info!(bulletins = state.bulletins.len(), "neige : bulletins relus du disque");
            }
            Err(error) => warn!("neige : fichier des bulletins illisible : {error}"),
        }
    }
    loop {
        let now = Timestamp::now().as_second();
        let (fetched_at, failed_at, stations_at, names_at) = {
            let state = STATE.read().expect("verrou de la neige");
            (state.fetched_at, state.failed_at, state.stations_at, state.names_at)
        };
        let retry: Vec<u16> = STATE.read().expect("verrou de la neige").retry.clone();
        let all = bulletins_due(fetched_at, failed_at, now);
        // Un relevé complet, ou seulement les massifs qui ont échoué la dernière fois (au plus toutes les demi-heures).
        let ids: Vec<u16> = if all { massifs().iter().map(|m| m.id).collect() } else if !retry.is_empty() && failed_at.is_none_or(|f| now - f >= RETRY_AFTER_S) { retry } else { Vec::new() };
        if !ids.is_empty() {
            match fetch_bulletins(&http, &key, &ids).await {
                Ok(Some(harvest)) => {
                    let now = Timestamp::now().as_second();
                    let bulletins = {
                        let mut state = STATE.write().expect("verrou de la neige");
                        // Hors saison : le portail ne donne rien, les anciens bulletins (expirés) sont gardés pour la relecture mais ne sont plus « en cours ».
                        for b in harvest.found {
                            state.bulletins.insert(b.id, b);
                        }
                        if all || state.fetched_at.is_none() {
                            state.fetched_at = Some(now);
                        }
                        state.failed_at = if harvest.failed.is_empty() { None } else { Some(now) };
                        state.retry = harvest.failed;
                        publish(&mut state, now);
                        state.bulletins.clone()
                    };
                    save(&data_dir, now, &bulletins).await;
                }
                Ok(None) => STATE.write().expect("verrou de la neige").failed_at = Some(now),
                Err(error) => {
                    warn!("neige : bulletins non relevés : {error:#}");
                    STATE.write().expect("verrou de la neige").failed_at = Some(now);
                }
            }
        }
        let now = Timestamp::now().as_second();
        let (stations_failed_at, refused) = {
            let state = STATE.read().expect("verrou de la neige");
            (state.stations_failed_at, state.stations_error.as_ref().is_some_and(|e| e.contains("refusé")))
        };
        // Après un échec : une demi-heure ; après un refus d'abonnement, six heures (rien ne change tant que l'abonnement ne change pas).
        let wait = if refused { STATIONS_REFUSED_RETRY_S } else { RETRY_AFTER_S };
        let stations_due = stations_at.is_none_or(|t| now - t >= STATIONS_EVERY_S) && stations_failed_at.is_none_or(|f| now - f >= wait);
        if stations_due {
            let outcome: Result<Option<Vec<SnowStation>>> = async {
                if names_at.is_none_or(|t| now - t >= STATION_LIST_EVERY_S) {
                    if let Some(names) = fetch_station_list(&http, &key).await?.filter(|n| !n.is_empty()) {
                        let mut state = STATE.write().expect("verrou de la neige");
                        state.names = names;
                        state.names_at = Some(now);
                    }
                    tokio::time::sleep(PACE).await;
                }
                let names = STATE.read().expect("verrou de la neige").names.clone();
                fetch_stations(&http, &key, &names).await
            }
            .await;
            let now = Timestamp::now().as_second();
            let mut state = STATE.write().expect("verrou de la neige");
            match outcome {
                Ok(Some(mut stations)) => {
                    for s in &mut stations {
                        if let Some((name, alt)) = state.names.get(&s.id) {
                            s.name = name.clone();
                            s.alt = *alt;
                        }
                    }
                    stations.sort_by(|a, b| a.id.cmp(&b.id));
                    info!(stations = stations.len(), "neige : hauteurs de neige relevées");
                    state.stations = stations;
                    state.stations_at = Some(now);
                    state.stations_failed_at = None;
                    state.stations_error = None;
                    publish(&mut state, now);
                }
                Ok(None) => state.stations_failed_at = Some(now),
                Err(error) => {
                    let text = format!("{error:#}");
                    warn!("neige : hauteurs de neige non relevées : {text}");
                    state.stations_failed_at = Some(now);
                    state.stations_error = Some(text);
                    publish(&mut state, now);
                }
            }
        }
        // Le relevé des bulletins qui a abouti avant le premier relevé des stations publie déjà ; sinon, on republie pour
        // que « bulletin expiré » arrive à l'heure même sans nouveau relevé.
        {
            let mut state = STATE.write().expect("verrou de la neige");
            if state.fetched_at.is_some() || state.stations_at.is_some() {
                publish(&mut state, Timestamp::now().as_second());
            }
        }
        tokio::time::sleep(TICK).await;
    }
}

// --- Routes ---

fn unavailable() -> Response {
    let state = STATE.read().expect("verrou de la neige");
    let message = if !state.key { "neige : clé Météo-France absente (METEOFRANCE_API_KEY)" } else { "neige : première collecte en cours" };
    (StatusCode::SERVICE_UNAVAILABLE, message).into_response()
}

/// `GET /api/neige` : les massifs avec leur bulletin en cours (risque, altitude, pentes), les stations de neige.
pub fn response() -> Response {
    match live() {
        Some(body) => ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-cache")], body).into_response(),
        None => unavailable(),
    }
}

/// `GET /api/neige/{id}` : le bulletin complet d'un massif (textes, enneigement, neige fraîche), relu de la mémoire.
pub async fn bulletin_handler(UrlPath(id): UrlPath<u16>) -> Response {
    let state = STATE.read().expect("verrou de la neige");
    if !state.key || state.fetched_at.is_none() {
        drop(state);
        return unavailable();
    }
    match state.bulletins.get(&id) {
        Some(bulletin) => match serde_json::to_vec(bulletin) {
            Ok(body) => ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-cache")], body).into_response(),
            Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        },
        None => (StatusCode::NOT_FOUND, "neige : pas de bulletin pour ce massif").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stations_de_montagne_interrogees_une_a_une() {
        let names = parse_station_list(
            "Id_station;Id_omm;Nom_usuel;Latitude;Longitude;Altitude;Date_ouverture;Pack\n\
             74056001;;CHAMONIX;45.93;6.88;1042;1990-01-01;ETENDU\n\
             74010001;;ANNECY;45.9;6.1;448;1990-01-01;ETENDU\n\
             20004002;;AJACCIO;41.9;8.8;5;1990-01-01;ETENDU\n\
             20148001;;BASTELICA;42.0;9.0;1640;1990-01-01;RADOME\n\
             75114001;;PARIS-MONTSOURIS;48.8;2.3;75;1990-01-01;ETENDU\n\
             63113001;;PUY DE DOME;45.8;2.9;1415;1990-01-01;ETENDU\n",
        );
        // Chamonix et Bastelica (Corse) : assez hautes, dans un département de massif ; le puy de Dôme n'a pas de massif BRA.
        assert_eq!(mountain_stations(&names), vec!["20148001".to_string(), "74056001".to_string()]);
    }

    const MONT_BLANC: &str = include_str!("testdata/bra_mont_blanc.xml");
    const PAYS_BASQUE: &str = include_str!("testdata/bra_pays_basque.xml");

    #[test]
    fn embeds_the_35_massifs_with_unique_ids_and_sane_bounds() {
        let all = massifs();
        assert_eq!(all.len(), 35);
        let mut ids: Vec<u16> = all.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 35);
        let mont_blanc = massif(3).unwrap();
        assert_eq!(mont_blanc.name, "Mont-Blanc");
        assert!(mont_blanc.bounds[0] < mont_blanc.lon && mont_blanc.lon < mont_blanc.bounds[2]);
        assert!(mont_blanc.bounds[1] < mont_blanc.lat && mont_blanc.lat < mont_blanc.bounds[3]);
        assert!(massif(71).is_none(), "l'Andorre n'a pas de bulletin");
    }

    #[test]
    fn parses_a_bulletin_with_two_altitude_bands_and_an_evolution_free_day() {
        let b = parse_bulletin(MONT_BLANC).unwrap();
        assert_eq!((b.id, b.name.as_str()), (3, "Mont-Blanc"));
        // 16 h à Paris en novembre : 15 h UTC ; valable jusqu'au lendemain 18 h.
        assert_eq!(b.issued, paris_second("2026-11-16T16:00:00").unwrap());
        assert_eq!(b.valid_until - b.issued, 26 * 3600);
        assert_eq!((b.risk_low, b.risk_high, b.altitude), (Some(2), Some(3), Some(2700)));
        assert_eq!((b.risk_max, b.risk_j2), (3, Some(3)));
        assert_eq!((b.evol_low, b.evol_high), (None, None));
        assert_eq!(b.slopes.len(), 8);
        assert!(b.accidental.starts_with("Nombreuses plaques"));
        assert!(b.stability_text.contains("Au-dessus de 2700 m"));
        assert_eq!((b.snow_limit_south, b.snow_limit_north), (Some(1700), Some(1700)));
        assert_eq!(b.snow_levels, vec![SnowLevel { alt: 1500, n: 0, s: 0 }, SnowLevel { alt: 2000, n: 3, s: 3 }, SnowLevel { alt: 2500, n: 65, s: 55 }]);
        assert_eq!(b.fresh_altitude, Some(1800));
        assert_eq!(b.fresh.len(), 6);
        assert_eq!((b.fresh[3].min, b.fresh[3].max), (Some(7), Some(10)));
        assert!(!b.amended);
    }

    #[test]
    fn a_low_risk_bulletin_has_one_level_and_no_dangerous_slope() {
        let b = parse_bulletin(PAYS_BASQUE).unwrap();
        assert_eq!(b.id, 64);
        assert_eq!((b.risk_low, b.risk_high, b.altitude, b.risk_max), (Some(1), None, None, 1));
        assert!(b.slopes.is_empty(), "risque 1 : aucune pente signalée");
        assert_eq!(b.snow_limit_south, Some(-1));
    }

    #[test]
    fn rejects_other_documents_and_bulletins_without_risk() {
        assert!(parse_bulletin("<html><body>Erreur</body></html>").is_err());
        assert!(parse_bulletin("pas du xml").is_err());
        let no_risk = r#"<BULLETINS_NEIGE_AVALANCHE ID="3" MASSIF="x" DATEBULLETIN="2026-11-16T16:00:00" DATEVALIDITE="2026-11-17T18:00:00"><CARTOUCHERISQUE/></BULLETINS_NEIGE_AVALANCHE>"#;
        assert!(parse_bulletin(no_risk).is_err());
    }

    #[test]
    fn keeps_the_slope_orientations_and_the_afternoon_evolution() {
        let xml = r#"<BULLETINS_NEIGE_AVALANCHE ID="10" MASSIF="Vanoise" DATEBULLETIN="2027-01-15T16:00:00" DATEVALIDITE="2027-01-16T18:00:00" AMENDEMENT="true">
          <CARTOUCHERISQUE>
            <RISQUE RISQUE1="3" EVOLURISQUE1="4" LOC1="&lt;2400" ALTITUDE="2400" RISQUE2="4" EVOLURISQUE2="" LOC2="&gt;2400" RISQUEMAXI="4" COMMENTAIRE="" RISQUEMAXIJ2="5" DATE_RISQUE_J2="2027-01-17T00:00:00"/>
            <PENTE NE="true" E="true" SE="false" S="false" SW="false" W="false" NW="true" N="true" COMMENTAIRE="Altitude"/>
          </CARTOUCHERISQUE></BULLETINS_NEIGE_AVALANCHE>"#;
        let b = parse_bulletin(xml).unwrap();
        assert!(b.amended);
        assert_eq!((b.risk_low, b.risk_high, b.evol_low, b.evol_high, b.risk_max, b.risk_j2), (Some(3), Some(4), Some(4), None, 4, Some(5)));
        assert_eq!(b.slopes, vec!["N", "NE", "E", "NW"]);
        assert_eq!(b.slopes_comment, "Altitude");
    }

    #[test]
    fn a_bulletin_is_current_until_six_hours_after_its_validity() {
        let b = parse_bulletin(MONT_BLANC).unwrap();
        assert!(current(&b, b.issued + 3600));
        assert!(current(&b, b.valid_until + GRACE_S));
        assert!(!current(&b, b.valid_until + GRACE_S + 1));
    }

    #[test]
    fn decodes_snow_depth_stations_and_keeps_only_those_that_measure_it() {
        let body = br#"[
          {"geo_id_insee":"73054001","lat":45.1,"lon":6.4,"reference_time":"2026-11-18T10:00:00Z","validity_time":"2026-11-18T09:00:00Z","sss":0.35},
          {"geo_id_insee":"73054001","lat":45.1,"lon":6.4,"validity_time":"2026-11-18T08:00:00Z","sss":0.30},
          {"geo_id_insee":"73099002","lat":45.2,"lon":6.5,"validity_time":"2026-11-18T09:00:00Z","sss":null},
          {"geo_id_insee":"73099003","lat":45.3,"lon":6.6,"validity_time":"2026-11-18T09:00:00Z","t":280.1},
          {"geo_id_insee":"73099004","lat":45.4,"lon":6.7,"validity_time":"2026-11-18T09:00:00Z","sss":0.0},
          {"geo_id_insee":"73099005","lat":45.5,"lon":6.8,"validity_time":"2026-11-18T09:00:00Z","sss":9999}
        ]"#;
        let mut stations = parse_observations(body).unwrap();
        stations.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(stations.iter().map(|s| (s.id.as_str(), s.cm)).collect::<Vec<_>>(), vec![("73054001", 35), ("73099004", 0)]);
        assert_eq!(stations[0].t, "2026-11-18T09:00:00Z".parse::<Timestamp>().unwrap().as_second(), "la mesure la plus récente l'emporte");
        assert!(parse_observations(b"<html>").is_err());
    }

    #[test]
    fn decodes_the_station_list() {
        let csv = "Id_station;Id_omm;Nom_usuel;Latitude;Longitude;Altitude;Date_ouverture;Pack\n73054001;;VAL D ISERE;45.45;6.98;1850;1990-01-01;RADOME\n74001002;;CHAMONIX;45.9;6.8;;;\n";
        let list = parse_station_list(csv);
        assert_eq!(list["73054001"], ("Val D Isere".to_string(), Some(1850)));
        assert_eq!(list["74001002"], ("Chamonix".to_string(), None));
        assert!(parse_station_list("n'importe quoi").is_empty());
    }

    #[test]
    fn bulletins_are_due_twice_a_day_at_most() {
        let t = |text: &str| paris_second(text).unwrap();
        // Jamais relevé : tout de suite.
        assert!(bulletins_due(None, None, t("2026-11-18T10:00:00")));
        // Relevé hier à 18 h : pas à midi (le bulletin du jour n'est pas encore paru), oui après 17 h 30.
        let last = t("2026-11-17T18:00:00");
        assert!(!bulletins_due(Some(last), None, t("2026-11-18T12:00:00")));
        assert!(!bulletins_due(Some(last), None, t("2026-11-18T17:00:00")));
        assert!(bulletins_due(Some(last), None, t("2026-11-18T17:31:00")));
        // Relevé aujourd'hui à 17 h 40 : pas avant demain.
        let last = t("2026-11-18T17:40:00");
        assert!(!bulletins_due(Some(last), None, t("2026-11-18T23:00:00")));
        assert!(!bulletins_due(Some(last), None, t("2026-11-19T10:00:00")));
        assert!(bulletins_due(Some(last), None, t("2026-11-19T17:45:00")));
        // Un échec récent retient le relevé une demi-heure.
        let now = t("2026-11-18T18:00:00");
        assert!(!bulletins_due(None, Some(now - 600), now));
        assert!(bulletins_due(None, Some(now - 3600), now));
    }

    #[test]
    fn out_of_season_the_massifs_are_listed_without_bulletin() {
        let mut state = State::new();
        state.fetched_at = Some(1);
        publish(&mut state, 1_800_000_000);
        let json: serde_json::Value = serde_json::from_slice(state.live.as_ref().unwrap()).unwrap();
        assert_eq!(json["season"], false);
        assert_eq!(json["massifs"].as_array().unwrap().len(), 35);
        assert!(json["massifs"][0].get("b").is_none());
        // Un abonnement Observation refusé est dit, sans casser les bulletins.
        state.stations_error = Some("clé Météo-France refusée (HTTP 403 Forbidden) : vérifier l'abonnement".into());
        publish(&mut state, 1_800_000_000);
        let json: serde_json::Value = serde_json::from_slice(state.live.as_ref().unwrap()).unwrap();
        assert_eq!(json["stationsError"], "API Observation de Météo-France non accordée à cette clé");
        // Un bulletin récent rend la saison « ouverte ».
        let b = parse_bulletin(MONT_BLANC).unwrap();
        let now = b.issued + 3600;
        state.bulletins.insert(b.id, b);
        publish(&mut state, now);
        let json: serde_json::Value = serde_json::from_slice(state.live.as_ref().unwrap()).unwrap();
        assert_eq!(json["season"], true);
        let mb = json["massifs"].as_array().unwrap().iter().find(|m| m["id"] == 3).unwrap();
        assert_eq!(mb["b"]["risk"], 3);
        assert_eq!(mb["b"]["altitude"], 2700);
        assert!(mb["b"].get("accidental").is_none(), "les textes ne sont que dans la fiche détaillée");
    }
}
