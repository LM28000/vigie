//! Synthèse « Aujourd'hui en France » : ce qui compte en ce moment, tiré des réponses que les collecteurs gardent déjà en
//! mémoire. **Aucune requête vers l'extérieur** : la route ne fait que relire (et résumer) la vigilance météo, les tronçons
//! Vigicrues et les rivières, les feux, les avions, le brouillage GPS, l'air et les retards SNCF déjà collectés. Les
//! séismes (EMSC) et les prises de vue du site restent côté navigateur.
//!
//! Chaque rubrique est `null` tant que sa source n'a pas répondu (ou quand elle est désactivée, comme l'air sans
//! identifiants) : le site la dit « indisponible », ce qui n'est pas « calme ». Ce qui est vide mais connu est une rubrique
//! avec des listes vides.
//!
//! La réponse est gardée 30 secondes : les clients qui rafraîchissent la synthèse chaque minute ne font pas recalculer
//! les retards (le parcours des circulations du jour prend quelques millisecondes, mais inutile de le répéter).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use tracing::warn;

pub mod veille;

use crate::network::Network;
use crate::realtime::Realtime;
use crate::rivers::{self, FloodSection};
use crate::state::AppState;

/// Durée de vie de la réponse gardée.
const CACHE_FOR: Duration = Duration::from_secs(30);

// --- Seuils : ce qui est « notable » ----------------------------------------------------------------------------------

/// Rivière « en forte montée » : au moins 30 cm en 3 h (le même seuil que la couche des rivières, `FAST_MM`).
const RIVER_FAST_MM: i32 = 300;
/// Une mesure de plus de 3 h n'est plus une tendance.
const RIVER_STALE_S: i64 = 3 * 3600;
/// Les feux : détections des dernières 24 h, sans celles de fiabilité faible, regroupées par case de 0,1° (environ 8 km).
const FIRE_WINDOW_S: i64 = 24 * 3600;
const FIRE_CELL_DEG: f64 = 0.1;
/// Puissance radiative cumulée (MW) d'un regroupement à partir de laquelle un feu est « notable » : en dessous, des petits
/// brûlages agricoles ou des détections isolées. De 100 MW, c'est un feu important.
const FIRE_NOTABLE_MW: f64 = 20.0;
/// Brouillage : part d'avions dégradés à partir de laquelle une case compte (le cran « 10 à 25 % » de la couche).
const JAMMING_SHARE: f64 = 0.10;
/// Retard (minutes) à partir duquel un train est cité ; et à partir duquel il est compté comme « en retard ».
const TRAIN_NOTABLE_MIN: i64 = 30;
const TRAIN_LATE_MIN: i64 = 15;
/// Un train est supprimé « maintenant » s'il devait partir dans l'heure qui vient ou depuis moins d'un quart d'heure.
const TRAIN_CANCEL_BEFORE_S: i64 = 15 * 60;
const TRAIN_CANCEL_AFTER_S: i64 = 3600;
/// Un train très en retard peut rouler longtemps après son arrivée prévue (même borne que `/api/trains`).
const TRAIN_MAX_DELAY_S: i64 = 3 * 3600;

// --- Ce que sert l'API --------------------------------------------------------------------------------------------------

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Synthese {
    /// Instant du calcul (secondes UTC).
    pub generated_at: i64,
    pub vigilance: Option<VigilanceOut>,
    pub floods: Option<FloodsOut>,
    pub rivers: Option<RiversOut>,
    pub fires: Option<FiresOut>,
    pub planes: Option<PlanesOut>,
    pub jamming: Option<JammingOut>,
    pub air: Option<AirOut>,
    pub trains: Option<TrainsOut>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VigilanceOut {
    pub issued_at: i64,
    pub periods: Vec<VigilancePeriod>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VigilancePeriod {
    pub name: String,
    pub begin: i64,
    pub end: i64,
    /// La période qui contient l'instant du calcul.
    pub current: bool,
    /// Nombre de départements en orange ou plus, et en rouge.
    pub orange: usize,
    pub red: usize,
    /// Départements en vigilance jaune pour les orages (phénomène 3) : jaunes presque tous les soirs d'été, ils ne se disent pas comme un orange.
    pub storm_yellow: usize,
    /// Orange et rouge seulement, par phénomène et niveau, les plus graves puis les plus étendus d'abord.
    pub groups: Vec<VigilanceGroup>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct VigilanceGroup {
    /// 1 vent violent, 2 pluie-inondation, 3 orages, 4 crues, 5 neige-verglas, 6 canicule, 7 grand froid, 8 avalanches, 9 vagues-submersion.
    pub phenomenon: u8,
    pub level: u8,
    pub departments: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FloodsOut {
    /// Instant du relevé du bulletin Vigicrues (secondes UTC).
    pub fetched_at: i64,
    pub yellow: usize,
    pub orange: usize,
    pub red: usize,
    /// Les plus graves d'abord (au plus `MAX_FLOODS`).
    pub sections: Vec<FloodSection>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiversOut {
    pub updated_at: i64,
    /// Nombre de stations dont la hauteur monte de 30 cm ou plus en 3 h.
    pub rising_count: usize,
    pub items: Vec<RiverItem>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiverItem {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub river: Option<String>,
    pub lon: f64,
    pub lat: f64,
    /// Montée sur 3 h et hauteur actuelle, en millimètres.
    pub rise_mm: i32,
    pub height_mm: i32,
    /// Vigilance Vigicrues du tronçon voisin (2 jaune, 3 orange, 4 rouge).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vig: Option<u8>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FiresOut {
    pub updated_at: i64,
    /// Détections des dernières 24 h (fiabilité normale ou élevée), notables ou non.
    pub detections: usize,
    pub items: Vec<FireItem>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FireItem {
    /// La détection la plus puissante du regroupement : c'est elle que la fiche de la couche ouvre.
    pub lon: f64,
    pub lat: f64,
    pub time: i64,
    pub satellite: String,
    /// Sa puissance, et la puissance cumulée du regroupement (MW), et le nombre de détections qu'il compte.
    pub frp: f64,
    pub total_frp: f64,
    pub count: usize,
    /// Heure de la détection la plus récente du regroupement.
    pub latest: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanesOut {
    pub updated_at: i64,
    pub military_count: usize,
    pub airborne_count: usize,
    pub items: Vec<PlaneItem>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaneItem {
    pub hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callsign: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub lon: f64,
    pub lat: f64,
    /// Altitude barométrique en mètres.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_m: Option<i32>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JammingOut {
    pub updated_at: i64,
    pub window_s: u32,
    /// Durée réellement couverte par les relevés (courte juste après un démarrage du serveur).
    pub covered_s: u32,
    pub cell_deg: f64,
    /// Cases où au moins 10 % des avions (et deux au moins) annoncent une position dégradée.
    pub affected: usize,
    pub items: Vec<JammingItem>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct JammingItem {
    pub lon: f64,
    pub lat: f64,
    pub n: u32,
    pub bad: u32,
    pub share: f64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AirOut {
    pub updated_at: i64,
    /// Jour de l'indice (« AAAA-MM-JJ », heure de Paris).
    pub day: String,
    /// Zones (communes ou intercommunalités) à l'indice « mauvais » ou pire ce jour-là, sur celles qui en ont un.
    pub bad_count: usize,
    pub total: usize,
    pub worst: Vec<AirZone>,
    pub episodes: Vec<AirEpisode>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct AirZone {
    /// Rang de la zone dans la réponse de `/api/air` (c'est ce que la couche de l'air sélectionne).
    pub i: usize,
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    /// 4 mauvais, 5 très mauvais, 6 extrêmement mauvais.
    pub level: u8,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct AirEpisode {
    pub zone: String,
    pub pol: String,
    /// 1 information et recommandation, 2 alerte, 3 alerte sur persistance.
    pub level: u8,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrainsOut {
    /// Heure de production du flux temps réel par la SNCF (secondes UTC).
    pub feed_at: i64,
    /// Circulations en cours dont le temps réel parle.
    pub running: usize,
    /// En retard de 15 minutes ou plus, et de 30 minutes ou plus.
    pub late: usize,
    pub very_late: usize,
    /// Supprimées (au départ dans l'heure qui vient ou parties depuis moins d'un quart d'heure).
    pub canceled: usize,
    pub delayed: Vec<TrainItem>,
    pub canceled_items: Vec<TrainItem>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrainItem {
    pub number: String,
    pub category: String,
    pub line: String,
    pub delay_min: i64,
    pub canceled: bool,
    /// Premier départ prévu (secondes UTC) : avec le numéro, c'est l'identité de la circulation sur le site.
    pub first_departure: i64,
    pub from: String,
    pub to: String,
    /// Le prochain arrêt (ou, pour un train supprimé, la gare de départ), et sa position.
    pub at: String,
    pub lon: f64,
    pub lat: f64,
}

// --- Ce que les collecteurs gardent (ce dont on se sert) --------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InVigilance {
    issued_at: i64,
    periods: Vec<InPeriod>,
    departments: BTreeMap<String, Vec<InDepartment>>,
}

#[derive(Deserialize)]
struct InPeriod {
    name: String,
    begin: i64,
    end: i64,
}

#[derive(Deserialize)]
struct InDepartment {
    max: u8,
    phenomena: Vec<InPhenomenon>,
}

#[derive(Deserialize)]
struct InPhenomenon {
    id: u8,
    level: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InRivers {
    updated_at: i64,
    stations: Vec<InStation>,
}

#[derive(Deserialize)]
struct InStation {
    id: String,
    name: String,
    river: Option<String>,
    lon: f64,
    lat: f64,
    h: i32,
    t: i64,
    d: Option<i32>,
    vig: Option<u8>,
    /// Nom du tronçon Vigicrues voisin (la veille s'en sert pour ne signaler qu'une fois un même tronçon).
    #[serde(rename = "vigName")]
    vig_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InFires {
    updated_at: i64,
    fires: Vec<InFire>,
}

#[derive(Deserialize)]
struct InFire {
    lon: f64,
    lat: f64,
    time: i64,
    frp: f64,
    confidence: String,
    satellite: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InPlanes {
    updated_at: i64,
    planes: Vec<InPlane>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InPlane {
    hex: String,
    callsign: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    lon: f64,
    lat: f64,
    alt_baro: Option<f64>,
    #[serde(default)]
    ground: bool,
    #[serde(default)]
    military: bool,
    #[serde(default)]
    seen_pos: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InJamming {
    updated_at: i64,
    cell_deg: f64,
    window_s: u32,
    covered_s: u32,
    min_aircraft: u32,
    min_degraded: u32,
    cells: Vec<InCell>,
}

#[derive(Deserialize)]
struct InCell {
    lon: f64,
    lat: f64,
    n: u32,
    bad: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InAir {
    updated_at: i64,
    days: Vec<String>,
    zones: InAirZones,
    episodes: Vec<InEpisode>,
}

#[derive(Deserialize)]
struct InAirZones {
    name: Vec<String>,
    lon: Vec<f64>,
    lat: Vec<f64>,
    v: Vec<String>,
}

#[derive(Deserialize)]
struct InEpisode {
    zone: String,
    pol: String,
    level: u8,
    day: String,
}

// --- Rubriques ---------------------------------------------------------------------------------------------------------

/// Toutes les rubriques sont recalculées depuis les mêmes réponses : un décodage qui échoue n'efface que la sienne.
fn decoded<'a, T: Deserialize<'a>>(what: &str, body: &'a Option<Bytes>) -> Option<T> {
    let body = body.as_ref()?;
    match serde_json::from_slice(body) {
        Ok(value) => Some(value),
        Err(error) => {
            warn!("synthèse : {what} illisible : {error}");
            None
        }
    }
}

fn vigilance(body: &Option<Bytes>, now: i64) -> Option<VigilanceOut> {
    let input: InVigilance = decoded("vigilance", body)?;
    let periods = input
        .periods
        .iter()
        .enumerate()
        // Les périodes passées n'intéressent plus personne.
        .filter(|(_, p)| p.end > now)
        .map(|(index, period)| {
            let mut groups: BTreeMap<(u8, u8), Vec<String>> = BTreeMap::new();
            let (mut orange, mut red, mut storm_yellow) = (0, 0, 0);
            for (code, entries) in &input.departments {
                let Some(entry) = entries.get(index) else { continue };
                if entry.max >= 3 {
                    orange += 1;
                }
                if entry.max >= 4 {
                    red += 1;
                }
                if entry.phenomena.iter().any(|p| p.id == 3 && p.level == 2) {
                    storm_yellow += 1;
                }
                for phenomenon in entry.phenomena.iter().filter(|p| p.level >= 3) {
                    groups.entry((phenomenon.id, phenomenon.level)).or_default().push(code.clone());
                }
            }
            let mut groups: Vec<VigilanceGroup> = groups
                .into_iter()
                .map(|((phenomenon, level), departments)| VigilanceGroup { phenomenon, level, departments })
                .collect();
            // Les plus graves d'abord, puis les plus étendus, puis dans l'ordre des phénomènes.
            groups.sort_by(|a, b| b.level.cmp(&a.level).then(b.departments.len().cmp(&a.departments.len())).then(a.phenomenon.cmp(&b.phenomenon)));
            VigilancePeriod {
                name: period.name.clone(),
                begin: period.begin,
                end: period.end,
                current: period.begin <= now && now < period.end,
                orange,
                red,
                storm_yellow,
                groups,
            }
        })
        .collect();
    Some(VigilanceOut { issued_at: input.issued_at, periods })
}

/// Tronçons cités au plus : les plus graves.
const MAX_FLOODS: usize = 8;

fn floods(input: Option<(i64, Vec<FloodSection>)>) -> Option<FloodsOut> {
    let (fetched_at, mut sections) = input?;
    let count = |level| sections.iter().filter(|s| s.level == level).count();
    let (yellow, orange, red) = (count(2), count(3), count(4));
    sections.sort_by(|a, b| b.level.cmp(&a.level).then(a.name.cmp(&b.name)));
    sections.truncate(MAX_FLOODS);
    Some(FloodsOut { fetched_at, yellow, orange, red, sections })
}

const MAX_RIVERS: usize = 5;

fn rivers(body: &Option<Bytes>, now: i64) -> Option<RiversOut> {
    let input: InRivers = decoded("rivières", body)?;
    // La marée fait monter les marégraphes et les estuaires de 1 à 3 m en 3 h : ce n'est pas une crue (voir `rivers::is_tidal`).
    let mut rising: Vec<&InStation> = input
        .stations
        .iter()
        .filter(|s| now - s.t < RIVER_STALE_S && s.d.is_some_and(|d| d >= RIVER_FAST_MM) && !rivers::is_tidal(&s.name, s.lon, s.lat))
        .collect();
    // Les montées les plus fortes d'abord ; à montée égale, celles qui sont déjà en vigilance.
    rising.sort_by(|a, b| b.d.cmp(&a.d).then(b.vig.cmp(&a.vig)).then(a.id.cmp(&b.id)));
    let rising_count = rising.len();
    let items = rising
        .into_iter()
        .take(MAX_RIVERS)
        .map(|s| RiverItem {
            id: s.id.clone(),
            name: s.name.clone(),
            river: s.river.clone(),
            lon: s.lon,
            lat: s.lat,
            rise_mm: s.d.unwrap_or(0),
            height_mm: s.h,
            vig: s.vig,
        })
        .collect();
    Some(RiversOut { updated_at: input.updated_at, rising_count, items })
}

/// Le site retient ceux qui sont en France (le carré de détection déborde sur la Belgique, l'Espagne, l'Italie…) : on en envoie plus qu'il n'en montre.
const MAX_FIRES: usize = 12;

/// Un regroupement de détections dans une case de `FIRE_CELL_DEG` degrés.
#[derive(Default)]
struct Cluster<'a> {
    total: f64,
    count: usize,
    latest: i64,
    strongest: Option<&'a InFire>,
}

/// Les détections des dernières 24 h, sans celles de fiabilité faible.
fn recent_fires(input: &InFires, now: i64) -> Vec<&InFire> {
    input.fires.iter().filter(|f| now - f.time < FIRE_WINDOW_S && f.confidence != "l").collect()
}

/// Regroupe par case de 0,1° ; la clé est l'indice de la case (stable d'un relevé à l'autre : elle sert d'identifiant à la veille).
fn cluster_fires<'a>(recent: &[&'a InFire]) -> HashMap<(i32, i32), Cluster<'a>> {
    let mut clusters: HashMap<(i32, i32), Cluster> = HashMap::new();
    for &fire in recent {
        let key = ((fire.lon / FIRE_CELL_DEG).floor() as i32, (fire.lat / FIRE_CELL_DEG).floor() as i32);
        let cluster = clusters.entry(key).or_default();
        cluster.total += fire.frp;
        cluster.count += 1;
        cluster.latest = cluster.latest.max(fire.time);
        if cluster.strongest.is_none_or(|s| fire.frp > s.frp) {
            cluster.strongest = Some(fire);
        }
    }
    clusters
}

fn fires(body: &Option<Bytes>, now: i64) -> Option<FiresOut> {
    let input: InFires = decoded("feux", body)?;
    let recent = recent_fires(&input, now);
    let clusters = cluster_fires(&recent);
    let mut notable: Vec<Cluster> = clusters.into_values().filter(|c| c.total >= FIRE_NOTABLE_MW).collect();
    notable.sort_by(|a, b| {
        b.total.total_cmp(&a.total).then_with(|| {
            let (a, b) = (a.strongest.map(|f| (f.lon, f.lat)), b.strongest.map(|f| (f.lon, f.lat)));
            a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let items = notable
        .into_iter()
        .take(MAX_FIRES)
        .filter_map(|c| {
            let fire = c.strongest?;
            Some(FireItem {
                lon: fire.lon,
                lat: fire.lat,
                time: fire.time,
                satellite: fire.satellite.clone(),
                frp: fire.frp,
                total_frp: (c.total * 10.0).round() / 10.0,
                count: c.count,
                latest: c.latest,
            })
        })
        .collect();
    Some(FiresOut { updated_at: input.updated_at, detections: recent.len(), items })
}

const MAX_PLANES: usize = 5;
const FT: f64 = 0.3048;
/// Comme le serveur des avions : une position de plus de 60 s n'est plus montrée.
const PLANE_STALE_S: f64 = 60.0;

fn planes(body: &Option<Bytes>) -> Option<PlanesOut> {
    let input: InPlanes = decoded("avions", body)?;
    let airborne: Vec<&InPlane> = input.planes.iter().filter(|p| !p.ground && p.seen_pos < PLANE_STALE_S).collect();
    let mut military: Vec<&InPlane> = airborne.iter().copied().filter(|p| p.military).collect();
    // Ceux qui s'annoncent (indicatif) d'abord, puis les plus hauts.
    military.sort_by(|a, b| {
        b.callsign.is_some().cmp(&a.callsign.is_some()).then(b.alt_baro.unwrap_or(0.0).total_cmp(&a.alt_baro.unwrap_or(0.0))).then(a.hex.cmp(&b.hex))
    });
    let military_count = military.len();
    let items = military
        .into_iter()
        .take(MAX_PLANES)
        .map(|p| PlaneItem {
            hex: p.hex.clone(),
            callsign: p.callsign.clone().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()),
            kind: p.kind.clone(),
            lon: p.lon,
            lat: p.lat,
            alt_m: p.alt_baro.map(|ft| (ft * FT).round() as i32),
        })
        .collect();
    Some(PlanesOut { updated_at: input.updated_at, military_count, airborne_count: airborne.len(), items })
}

const MAX_JAMMING: usize = 4;

fn jamming(body: &Option<Bytes>) -> Option<JammingOut> {
    let input: InJamming = decoded("brouillage", body)?;
    let mut hit: Vec<JammingItem> = input
        .cells
        .iter()
        .filter(|c| c.n >= input.min_aircraft && c.bad >= input.min_degraded && f64::from(c.bad) / f64::from(c.n) >= JAMMING_SHARE)
        .map(|c| JammingItem { lon: c.lon, lat: c.lat, n: c.n, bad: c.bad, share: f64::from(c.bad) / f64::from(c.n) })
        .collect();
    hit.sort_by(|a, b| b.share.total_cmp(&a.share).then(b.bad.cmp(&a.bad)).then(a.lon.total_cmp(&b.lon)).then(a.lat.total_cmp(&b.lat)));
    let affected = hit.len();
    hit.truncate(MAX_JAMMING);
    Some(JammingOut { updated_at: input.updated_at, window_s: input.window_s, covered_s: input.covered_s, cell_deg: input.cell_deg, affected, items: hit })
}

const MAX_AIR_ZONES: usize = 3;
const MAX_AIR_EPISODES: usize = 4;

fn air(body: &Option<Bytes>, today: &str) -> Option<AirOut> {
    let input: InAir = decoded("air", body)?;
    let day = input.days.iter().position(|d| d == today)?;
    let level_of = |zone: usize| {
        let code = input.zones.v.get(zone).and_then(|v| v.as_bytes().get(day * 6)).copied().unwrap_or(b'-');
        if (b'1'..=b'7').contains(&code) { code - b'0' } else { 0 }
    };
    let mut total = 0;
    let mut bad: Vec<(usize, u8)> = Vec::new();
    for zone in 0..input.zones.name.len() {
        let level = level_of(zone);
        if level == 0 {
            continue;
        }
        total += 1;
        // 7 est « événement » : il n'a pas de gravité à comparer.
        if (4..=6).contains(&level) {
            bad.push((zone, level));
        }
    }
    let bad_count = bad.len();
    bad.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let worst = bad
        .into_iter()
        .take(MAX_AIR_ZONES)
        .filter_map(|(i, level)| Some(AirZone { i, name: input.zones.name.get(i)?.clone(), lon: *input.zones.lon.get(i)?, lat: *input.zones.lat.get(i)?, level }))
        .collect();
    let mut episodes: Vec<AirEpisode> =
        input.episodes.iter().filter(|e| e.day == today).map(|e| AirEpisode { zone: e.zone.clone(), pol: e.pol.clone(), level: e.level }).collect();
    episodes.sort_by(|a, b| b.level.cmp(&a.level).then(a.zone.cmp(&b.zone)).then(a.pol.cmp(&b.pol)));
    episodes.dedup();
    episodes.truncate(MAX_AIR_EPISODES);
    Some(AirOut { updated_at: input.updated_at, day: today.to_string(), bad_count, total, worst, episodes })
}

const MAX_TRAINS: usize = 5;

/// Les retards et suppressions du moment, d'après les horaires et le flux temps réel (comme `/api/trains`, sans rien envoyer
/// des tracés ni des arrêts).
pub fn trains(network: &Network, realtime: &Realtime, now: i64) -> TrainsOut {
    let timetable = &network.timetable;
    let (mut running, mut late, mut very_late, mut canceled) = (0, 0, 0, 0);
    let mut delayed: Vec<TrainItem> = Vec::new();
    let mut canceled_items: Vec<TrainItem> = Vec::new();
    let mut identities: HashSet<(&str, i64)> = HashSet::new();
    let station = |index: u32| timetable.stations.get(index as usize);

    for run in timetable.runs_between(now - TRAIN_MAX_DELAY_S, now + TRAIN_CANCEL_AFTER_S) {
        let stops = &run.trip.stops;
        let (Some(first), Some(last)) = (stops.first(), stops.last()) else { continue };
        let Some(live) = realtime.apply(&run, &timetable.stop_points) else { continue };
        let first_departure = run.day_start + i64::from(first.departure);
        if !identities.insert((run.trip.number.as_str(), first_departure)) {
            continue;
        }
        let (Some(from), Some(to)) = (station(first.station), station(last.station)) else { continue };
        let item = |delay_min: i64, canceled: bool, at: u32| -> Option<TrainItem> {
            let at = station(at)?;
            Some(TrainItem {
                number: run.trip.number.clone(),
                category: run.trip.category.clone(),
                line: run.trip.line.clone(),
                delay_min,
                canceled,
                first_departure,
                from: from.name.clone(),
                to: to.name.clone(),
                at: at.name.clone(),
                lon: at.lon,
                lat: at.lat,
            })
        };

        if live.canceled {
            if first_departure > now - TRAIN_CANCEL_BEFORE_S && first_departure < now + TRAIN_CANCEL_AFTER_S {
                canceled += 1;
                canceled_items.extend(item(0, true, first.station));
            }
            continue;
        }
        let (Some(&start), Some(&end)) = (live.departure.first(), live.arrival.last()) else { continue };
        if now < start || now > end {
            continue;
        }
        running += 1;
        // Le retard au prochain arrêt (au dernier si tous sont passés).
        let next = live.arrival.iter().position(|&t| t >= now).unwrap_or(stops.len() - 1);
        let planned_arrival = run.day_start + i64::from(stops[next].arrival);
        let delay_min = (live.arrival[next] - planned_arrival) / 60;
        if delay_min >= TRAIN_LATE_MIN {
            late += 1;
        }
        if delay_min >= TRAIN_NOTABLE_MIN {
            very_late += 1;
            delayed.extend(item(delay_min, false, stops[next].station));
        }
    }
    delayed.sort_by(|a, b| b.delay_min.cmp(&a.delay_min).then(a.number.cmp(&b.number)));
    delayed.truncate(MAX_TRAINS);
    // Les prochains départs supprimés d'abord.
    canceled_items.sort_by(|a, b| a.first_departure.cmp(&b.first_departure).then(a.number.cmp(&b.number)));
    canceled_items.truncate(MAX_TRAINS);
    TrainsOut { feed_at: realtime.feed_timestamp, running, late, very_late, canceled, delayed, canceled_items }
}

// --- Assemblage ------------------------------------------------------------------------------------------------------

/// Les réponses prêtes des collecteurs, relues telles quelles.
#[derive(Default)]
pub struct Inputs {
    pub vigilance: Option<Bytes>,
    pub rivers: Option<Bytes>,
    pub floods: Option<(i64, Vec<FloodSection>)>,
    pub fires: Option<Bytes>,
    pub planes: Option<Bytes>,
    pub jamming: Option<Bytes>,
    pub air: Option<Bytes>,
}

/// Le jour à Paris, « AAAA-MM-JJ ».
fn paris_day(now: i64) -> String {
    let zone = TimeZone::get("Europe/Paris").unwrap_or(TimeZone::UTC);
    Timestamp::from_second(now).map(|t| t.to_zoned(zone).date().to_string()).unwrap_or_default()
}

pub fn build(inputs: &Inputs, trains: Option<TrainsOut>, now: i64) -> Synthese {
    Synthese {
        generated_at: now,
        vigilance: vigilance(&inputs.vigilance, now),
        floods: floods(inputs.floods.clone()),
        rivers: rivers(&inputs.rivers, now),
        fires: fires(&inputs.fires, now),
        planes: planes(&inputs.planes),
        jamming: jamming(&inputs.jamming),
        air: air(&inputs.air, &paris_day(now)),
        trains,
    }
}

static CACHE: OnceLock<tokio::sync::Mutex<Option<(Instant, Bytes)>>> = OnceLock::new();

/// `GET /api/synthese`
pub async fn handler(State(state): State<AppState>) -> Response {
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    // Le verrou est gardé pendant le calcul : des requêtes simultanées n'en provoquent qu'un.
    let mut guard = cache.lock().await;
    if let Some((at, body)) = guard.as_ref()
        && at.elapsed() < CACHE_FOR
    {
        return respond(body.clone());
    }
    let computed = tokio::task::spawn_blocking(move || {
        let now = Timestamp::now().as_second();
        let inputs = Inputs {
            vigilance: state.vigilance(),
            rivers: rivers::live(),
            floods: rivers::floods(),
            fires: state.fires(),
            planes: state.planes(),
            jamming: state.jamming(),
            air: state.air(),
        };
        let trains = state.realtime().map(|realtime| trains(&state.network(), &realtime, now));
        serde_json::to_vec(&build(&inputs, trains, now))
    })
    .await;
    match computed {
        Ok(Ok(body)) => {
            let body = Bytes::from(body);
            *guard = Some((Instant::now(), body.clone()));
            respond(body)
        }
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

fn respond(body: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-cache")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(json: &str) -> Option<Bytes> {
        Some(Bytes::from(json.to_string()))
    }

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn groups_orange_and_red_by_phenomenon_and_ignores_yellow_and_past_periods() {
        let body = format!(
            r#"{{"issuedAt":{i},"updatedAt":{i},"periods":[{{"name":"hier","begin":{b0},"end":{e0}}},{{"name":"J","begin":{e0},"end":{e1}}},{{"name":"J1","begin":{e1},"end":{e2}}}],
            "departments":{{
              "33":[{{"max":2,"phenomena":[]}},{{"max":3,"phenomena":[{{"id":3,"level":3,"slots":[]}},{{"id":1,"level":2,"slots":[]}}]}},{{"max":4,"phenomena":[{{"id":3,"level":4,"slots":[]}}]}}],
              "40":[{{"max":2,"phenomena":[]}},{{"max":3,"phenomena":[{{"id":3,"level":3,"slots":[]}}]}},{{"max":1,"phenomena":[]}}],
              "64":[{{"max":2,"phenomena":[]}},{{"max":4,"phenomena":[{{"id":2,"level":4,"slots":[]}}]}},{{"max":1,"phenomena":[]}}]
            }}}}"#,
            i = NOW - 3600,
            b0 = NOW - 90_000,
            e0 = NOW - 3_600,
            e1 = NOW + 80_000,
            e2 = NOW + 160_000,
        );
        let out = vigilance(&bytes(&body), NOW).unwrap();
        assert_eq!(out.periods.len(), 2, "la période passée est écartée");
        let today = &out.periods[0];
        assert!(today.current);
        assert_eq!((today.orange, today.red), (3, 1));
        // Rouge d'abord (pluie-inondation), puis les orages orange sur deux départements ; le jaune (vent) n'apparaît pas.
        assert_eq!(today.groups.iter().map(|g| (g.phenomenon, g.level, g.departments.len())).collect::<Vec<_>>(), vec![(2, 4, 1), (3, 3, 2)]);
        assert_eq!(today.groups[1].departments, vec!["33", "40"]);
        let tomorrow = &out.periods[1];
        assert!(!tomorrow.current);
        assert_eq!((tomorrow.orange, tomorrow.red), (1, 1));
        assert_eq!(tomorrow.groups[0].departments, vec!["33"]);
    }

    #[test]
    fn counts_every_flood_level_and_keeps_the_worst_sections() {
        let section = |id: &str, name: &str, level| FloodSection { id: id.into(), name: name.into(), level, lon: 2.0, lat: 47.0 };
        let mut sections = vec![section("1", "Aa", 2), section("2", "Bb", 4), section("3", "Cc", 3), section("4", "Dd", 2)];
        for i in 0..10 {
            sections.push(section(&format!("x{i}"), &format!("Zz{i}"), 2));
        }
        let out = floods(Some((NOW, sections))).unwrap();
        assert_eq!((out.yellow, out.orange, out.red), (12, 1, 1));
        assert_eq!(out.sections.len(), MAX_FLOODS);
        assert_eq!(out.sections[0].name, "Bb");
        assert_eq!(out.sections[1].name, "Cc");
        assert!(floods(None).is_none(), "avant le premier bulletin, la rubrique est absente (pas « calme »)");
    }

    #[test]
    fn keeps_the_fast_rising_rivers_with_a_recent_measure() {
        let station = |id: &str, t: i64, d: Option<i32>, vig: Option<u8>| {
            let d = d.map_or(String::new(), |d| format!(r#","d":{d}"#));
            let vig = vig.map_or(String::new(), |v| format!(r#","vig":{v}"#));
            format!(r#"{{"id":"{id}","name":"Station {id}","river":"La {id}","lon":2.0,"lat":47.0,"h":1500,"t":{t}{d}{vig}}}"#)
        };
        let body = format!(
            r#"{{"updatedAt":{NOW},"stations":[{},{},{},{},{}]}}"#,
            station("a", NOW - 600, Some(450), None),
            station("b", NOW - 600, Some(300), Some(3)),
            station("c", NOW - 600, Some(299), None),
            station("d", NOW - 5 * 3600, Some(900), None),
            station("e", NOW - 600, None, None),
        );
        let out = rivers(&bytes(&body), NOW).unwrap();
        assert_eq!(out.rising_count, 2, "299 mm, une mesure vieille de 5 h et une station sans tendance ne comptent pas");
        assert_eq!(out.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(out.items[1].vig, Some(3));
    }

    #[test]
    fn leaves_the_tide_out_of_the_rising_rivers() {
        let body = format!(
            r#"{{"updatedAt":{NOW},"stations":[
              {{"id":"O960001001","name":"La Garonne à Cadillac","river":"La Garonne","lon":-0.32422,"lat":44.63555,"h":2240,"t":{t},"d":3050}},
              {{"id":"J050000101","name":"[La Manche] à Cancale - [Marégraphe] - Port de Cancale","lon":-1.85172,"lat":48.66839,"h":1630,"t":{t},"d":2489}},
              {{"id":"E530021001","name":"La Liane à Isques","river":"La Liane","lon":1.6333,"lat":50.68073,"h":2419,"t":{t},"d":327,"vig":2}}
            ]}}"#,
            t = NOW - 600
        );
        let out = rivers(&bytes(&body), NOW).unwrap();
        assert_eq!(out.rising_count, 1);
        assert_eq!(out.items[0].id, "E530021001");
    }

    #[test]
    fn groups_fire_detections_and_keeps_the_notable_ones() {
        let fire = |lon: f64, lat: f64, age_h: i64, frp: f64, conf: &str| {
            format!(r#"{{"lon":{lon},"lat":{lat},"time":{},"frp":{frp},"confidence":"{conf}","satellite":"NOAA-20","day":true}}"#, NOW - age_h * 3600)
        };
        let body = format!(
            r#"{{"updatedAt":{NOW},"fires":[{},{},{},{},{},{}]}}"#,
            // Un grand feu : trois détections voisines, 90 MW en tout.
            fire(2.01, 44.01, 2, 50.0, "n"),
            fire(2.02, 44.02, 3, 30.0, "h"),
            fire(2.03, 44.03, 3, 10.0, "n"),
            // Un petit brûlage, une détection de faible fiabilité, une détection de la veille.
            fire(5.5, 45.5, 2, 6.0, "n"),
            fire(1.5, 43.5, 2, 80.0, "l"),
            fire(0.5, 42.5, 30, 80.0, "n"),
        );
        let out = fires(&bytes(&body), NOW).unwrap();
        assert_eq!(out.detections, 4, "la détection de faible fiabilité et celle de plus de 24 h sont écartées");
        assert_eq!(out.items.len(), 1);
        let item = &out.items[0];
        assert_eq!((item.count, item.total_frp, item.frp), (3, 90.0, 50.0));
        assert_eq!((item.lon, item.lat, item.time), (2.01, 44.01, NOW - 2 * 3600));
        assert_eq!(item.latest, NOW - 2 * 3600);
    }

    #[test]
    fn lists_airborne_military_planes_only() {
        let body = format!(
            r#"{{"updatedAt":{NOW},"planes":[
              {{"hex":"3b7a01","callsign":"CTM2001 ","type":"A400","lon":2.3,"lat":48.8,"altBaro":12000,"ground":false,"military":true,"seenPos":2}},
              {{"hex":"3b7a02","lon":2.2,"lat":48.7,"altBaro":30000,"ground":false,"military":true,"seenPos":2}},
              {{"hex":"3b7a03","callsign":"MIL3","lon":2.1,"lat":48.6,"ground":true,"military":true,"seenPos":2}},
              {{"hex":"3b7a04","callsign":"MIL4","lon":2.1,"lat":48.6,"altBaro":9000,"ground":false,"military":true,"seenPos":300}},
              {{"hex":"4d24cb","callsign":"RYR4AU","lon":0.4,"lat":50.4,"altBaro":37000,"ground":false,"seenPos":1}}
            ]}}"#
        );
        let out = planes(&bytes(&body)).unwrap();
        assert_eq!((out.military_count, out.airborne_count), (2, 3));
        assert_eq!(out.items[0].hex, "3b7a01", "l'avion qui s'annonce passe devant");
        assert_eq!(out.items[0].callsign.as_deref(), Some("CTM2001"));
        assert_eq!(out.items[0].alt_m, Some(3658));
        assert_eq!(out.items[1].callsign, None);
    }

    #[test]
    fn keeps_jamming_cells_with_enough_planes_and_a_real_share() {
        let body = format!(
            r#"{{"updatedAt":{NOW},"cellDeg":0.5,"windowS":1200,"coveredS":1200,"minAircraft":5,"minDegraded":2,"cells":[
              {{"lon":10.0,"lat":40.0,"n":20,"bad":10}},
              {{"lon":11.0,"lat":40.0,"n":30,"bad":4}},
              {{"lon":12.0,"lat":40.0,"n":4,"bad":4}},
              {{"lon":13.0,"lat":40.0,"n":8,"bad":1}},
              {{"lon":14.0,"lat":40.0,"n":50,"bad":3}}
            ]}}"#
        );
        let out = jamming(&bytes(&body)).unwrap();
        // 10/20 (50 %) et 4/30 (13 %) comptent ; 4/4 manque d'avions, 1/8 d'avions dégradés, 3/50 (6 %) est sous le seuil.
        assert_eq!(out.affected, 2);
        assert_eq!(out.items.iter().map(|c| c.lon).collect::<Vec<_>>(), vec![10.0, 11.0]);
    }

    #[test]
    fn reads_todays_air_quality_and_episodes() {
        // Trois zones, deux jours (6 caractères par jour : indice global puis cinq sous-indices).
        let body = format!(
            r#"{{"updatedAt":{NOW},"days":["2026-11-15","2026-11-16"],"sources":["x"],
              "zones":{{"name":["A","B","C"],"lon":[1.0,2.0,3.0],"lat":[40.0,41.0,42.0],"src":[0,0,0],"epci":[0,0,0],
                "v":["1-----5-----","2-----4-----","6-----3-----"]}},
              "episodes":[{{"zone":"ILE-DE-FRANCE","pol":"O3","level":2,"day":"2026-11-16"}},{{"zone":"X","pol":"PM10","level":1,"day":"2026-11-15"}}]}}"#
        );
        let out = air(&bytes(&body), "2026-11-16").unwrap();
        assert_eq!((out.bad_count, out.total), (2, 3));
        assert_eq!(out.worst.iter().map(|z| (z.name.as_str(), z.level)).collect::<Vec<_>>(), vec![("A", 5), ("B", 4)]);
        assert_eq!(out.episodes.len(), 1, "l'épisode d'hier est écarté");
        assert!(air(&bytes(&body), "2026-11-20").is_none(), "pas d'indice publié pour ce jour : rubrique absente");
    }

    #[test]
    fn a_broken_source_only_empties_its_own_section() {
        let inputs = Inputs { vigilance: bytes("pas du json"), fires: bytes(&format!(r#"{{"updatedAt":{NOW},"fires":[]}}"#)), ..Inputs::default() };
        let out = build(&inputs, None, NOW);
        assert!(out.vigilance.is_none());
        assert_eq!(out.fires.unwrap().items.len(), 0);
        assert!(out.trains.is_none() && out.air.is_none());
    }

    /// Trois gares, quatre circulations du 10 novembre 2026 ; à 10:10 (heure de Paris), deux sont en retard (40 et 20 minutes), une
    /// est à l'heure et une, qui devait partir à 10:30, est supprimée.
    #[test]
    fn finds_the_late_and_the_canceled_trains() {
        use crate::gtfs_rt::{FeedEntity, FeedHeader, FeedMessage, StopTimeEvent, StopTimeUpdate, TripDescriptor, TripUpdate};
        use crate::timetable::{Station, StopTime, Timetable, Trip};
        use jiff::civil::date;

        let zone = TimeZone::get("Europe/Paris").unwrap();
        let hm = |h: i32, m: i32| h * 3600 + m * 60;
        let station = |code: &str, lon: f64| Station { code: code.into(), name: format!("Gare {code}"), lon, lat: 48.0 };
        let trip = |number: &str, stops: &[(u32, i32)]| Trip {
            id: number.into(),
            number: number.into(),
            category: "TER".into(),
            line: "Ligne X".into(),
            service: 0,
            stops: stops.iter().enumerate().map(|(i, &(station, t))| StopTime { station, stop_point: station, stop_sequence: i as u32, arrival: t, departure: t }).collect(),
        };
        let trips = vec![
            trip("1001", &[(0, hm(9, 0)), (1, hm(10, 0)), (2, hm(11, 0))]),
            trip("2002", &[(0, hm(9, 10)), (2, hm(10, 50))]),
            trip("3003", &[(0, hm(10, 30)), (2, hm(11, 30))]),
            trip("4004", &[(0, hm(9, 30)), (2, hm(11, 0))]),
        ];
        let timetable = Timetable::new(
            1,
            vec![station("A", 2.0), station("B", 2.5), station("C", 3.0)],
            Vec::new(),
            trips,
            "test".into(),
            vec![(0..10).collect()],
            date(2026, 11, 9),
            zone.clone(),
        );
        let network = Network::new(std::sync::Arc::new(timetable), None);
        let now = date(2026, 11, 10).at(10, 10, 0, 0).to_zoned(zone).unwrap().timestamp().as_second();

        let update = |trip: &str, delay: Option<i32>| FeedEntity {
            id: trip.into(),
            is_deleted: None,
            vehicle: None,
            trip_update: Some(TripUpdate {
                trip: TripDescriptor {
                    trip_id: Some(trip.into()),
                    start_date: None,
                    schedule_relationship: delay.is_none().then_some(crate::gtfs_rt::TRIP_CANCELED),
                    route_id: None,
                },
                stop_time_update: delay
                    .map(|delay| {
                        vec![StopTimeUpdate {
                            stop_sequence: Some(0),
                            arrival: Some(StopTimeEvent { delay: Some(delay), time: None }),
                            departure: Some(StopTimeEvent { delay: Some(delay), time: None }),
                            stop_id: None,
                            schedule_relationship: None,
                        }]
                    })
                    .unwrap_or_default(),
                timestamp: None,
            }),
        };
        let entity = vec![update("1001", Some(40 * 60)), update("2002", Some(0)), update("3003", None), update("4004", Some(20 * 60))];
        let realtime = crate::realtime::from_feed(FeedMessage { header: FeedHeader { gtfs_realtime_version: "2.0".into(), timestamp: Some(now as u64) }, entity }, now);

        let out = trains(&network, &realtime, now);
        assert_eq!((out.running, out.late, out.very_late, out.canceled), (3, 2, 1, 1));
        assert_eq!(out.delayed.len(), 1, "seul le retard de 30 minutes ou plus est cité");
        let late = &out.delayed[0];
        assert_eq!((late.number.as_str(), late.delay_min, late.at.as_str(), late.to.as_str()), ("1001", 40, "Gare B", "Gare C"));
        let canceled = &out.canceled_items[0];
        assert_eq!((canceled.number.as_str(), canceled.canceled, canceled.at.as_str()), ("3003", true, "Gare A"));
        assert_eq!(canceled.first_departure, now + 20 * 60);
    }

    #[test]
    fn paris_day_follows_the_local_date() {
        // 2026-11-15 23:30 UTC est déjà le 16 à Paris (UTC+1 en hiver).
        let t = "2026-11-15T23:30:00Z".parse::<Timestamp>().unwrap().as_second();
        assert_eq!(paris_day(t), "2026-11-16");
    }
}
