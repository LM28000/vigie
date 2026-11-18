//! Zones surveillées : `POST /api/veille`. Le navigateur envoie les zones que l'utilisateur surveille (contour, départements
//! qu'elles touchent, types d'événements voulus) et reçoit ce qui s'y passe **en ce moment**. Le serveur ne garde ni zone ni
//! alerte : l'utilisateur les conserve dans son navigateur, qui interroge toutes les minutes et retient lui-même ce qu'il a
//! déjà signalé (`web/src/core/veille.ts`, dédoublonnage par identifiant d'événement).
//!
//! # Aucune requête externe
//!
//! Comme la synthèse (dont ce module est un enfant : il relit les mêmes structures), il ne fait que relire ce que les
//! collecteurs gardent en mémoire : vigilance, Vigicrues, rivières, feux, avions, brouillage, retards SNCF. **Zéro requête
//! vers PRIM IDFM ou toute autre source.** Les séismes (EMSC) sont lus par le navigateur et évalués côté site.
//!
//! # Un index, puis un filtre par zone
//!
//! Chaque rubrique produit des événements ponctuels (identifiant, gravité, position, fiche à ouvrir) dans un **index
//! national** recalculé au plus toutes les 30 s ; une requête ne fait que filtrer cet index par zone (point dans le contour,
//! ou département pour la vigilance). Le coût d'une requête ne dépend donc ni du nombre de clients ni de la taille des zones.
//!
//! # Identifiants
//!
//! L'identifiant d'un événement est stable tant que c'est le même phénomène (`vig:33:3:3` pour les orages en orange en Gironde,
//! `montee:O972001001`, `train:8642@1794932520:arr`) et change quand sa gravité change (orange puis rouge) : c'est ce que le
//! client compare pour ne signaler qu'une fois.
//!
//! # Seuils par défaut
//!
//! Vigilance : orange et rouge (le jaune est quotidien). Crues : jaune et plus (rare, et déjà un avis officiel). Rivière :
//! 30 cm en 3 h, marée exclue. Incendie : regroupement d'au moins 20 MW. Brouillage : au moins 10 % d'avions dégradés. Avion :
//! tout avion militaire en vol. Train : 30 minutes de retard au départ ou à l'arrivée d'une gare de la zone, ou suppression.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::*;

/// Les types que le serveur sait évaluer (le séisme est évalué par le site).
pub const TYPES: [&str; 10] = ["vigilance", "crue", "montee", "incendie", "brouillage", "avion", "train", "avalanche", "evenement", "actualite"];

const MAX_ZONES: usize = 12;
const MAX_VERTICES: usize = 500;
const MAX_EVENTS_PER_ZONE: usize = 40;
/// Un train est « très en retard » à partir de là (comme la synthèse).
const TRAIN_ALERT_MIN: i64 = 30;
/// Retard à partir duquel la gravité passe de « notable » à « important ».
const TRAIN_SEVERE_MIN: i64 = 90;
/// Une suppression est signalée dans l'heure qui précède l'horaire prévu, et un quart d'heure après.
const CANCEL_BEFORE_S: i64 = 15 * 60;
const CANCEL_AFTER_S: i64 = 3600;
/// Fenêtre des circulations examinées autour de l'instant (un train très en retard roule longtemps après son horaire).
const TRAIN_WINDOW_S: i64 = 3 * 3600;

/// Les noms des phénomènes de vigilance, par numéro (le même tableau que `PHENOMENA` côté site).
const PHENOMENA: [&str; 10] =
    ["", "vent violent", "pluie-inondation", "orages", "crues", "neige-verglas", "canicule", "grand froid", "avalanches", "vagues-submersion"];

// --- Ce que sert l'API ------------------------------------------------------------------------------------------------

/// Un événement dans une zone. La gravité suit l'échelle de la synthèse : 1 à noter, 2 notable (jaune), 3 important
/// (orange), 4 critique (rouge).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub severity: u8,
    pub title: String,
    pub detail: String,
    /// Absent pour la vigilance (qui vaut pour un département : le site place l'événement au milieu du département).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    /// Le département d'une vigilance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub department: Option<String>,
    /// Instant de l'observation (secondes UTC), quand la source en donne un.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<i64>,
    /// La couche à afficher, l'objet à sélectionner (sa fiche s'ouvre) et le zoom : de quoi voler vers l'objet.
    pub module: &'static str,
    pub selection: Value,
    pub zoom: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ZoneOut {
    id: String,
    events: Vec<Event>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct VeilleOut {
    generated_at: i64,
    /// Les types dont la source n'a pas encore répondu : « rien à signaler » ne vaut rien pour eux.
    unavailable: Vec<&'static str>,
    zones: Vec<ZoneOut>,
}

// --- Ce que reçoit l'API -----------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Request {
    zones: Vec<ZoneIn>,
}

#[derive(Deserialize)]
struct ZoneIn {
    id: String,
    /// Contour (anneau ouvert ou fermé) : `[longitude, latitude]`.
    ring: Vec<[f64; 2]>,
    /// Codes des départements que la zone touche (le site les calcule : il a les contours).
    #[serde(default)]
    departments: Vec<String>,
    /// Types voulus ; vide : tous.
    #[serde(default)]
    types: Vec<String>,
}

/// Une zone validée, prête à filtrer.
#[derive(Debug)]
pub struct Zone {
    id: String,
    ring: Vec<[f64; 2]>,
    /// Ouest, sud, est, nord.
    bounds: [f64; 4],
    departments: HashSet<String>,
    types: HashSet<&'static str>,
}

fn bounds_of(ring: &[[f64; 2]]) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for &[lon, lat] in ring {
        b = [b[0].min(lon), b[1].min(lat), b[2].max(lon), b[3].max(lat)];
    }
    b
}

/// Le point est-il dans l'anneau (règle pair-impair) ?
pub fn in_ring(lon: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let [xi, yi] = ring[i];
        let [xj, yj] = ring[j];
        if (yi > lat) != (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

impl Zone {
    fn parse(input: ZoneIn) -> Result<Zone, String> {
        if input.id.is_empty() || input.id.len() > 64 {
            return Err("identifiant de zone invalide".into());
        }
        if input.ring.len() < 3 || input.ring.len() > MAX_VERTICES {
            return Err(format!("zone {} : entre 3 et {MAX_VERTICES} sommets attendus", input.id));
        }
        if input.ring.iter().any(|&[lon, lat]| !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat)) {
            return Err(format!("zone {} : coordonnées invalides", input.id));
        }
        if input.departments.len() > 120 || input.departments.iter().any(|d| d.is_empty() || d.len() > 3) {
            return Err(format!("zone {} : départements invalides", input.id));
        }
        let types: HashSet<&'static str> = if input.types.is_empty() {
            // Les événements publics ne sont surveillés que sur demande expresse.
            TYPES.iter().copied().filter(|t| *t != "evenement" && *t != "actualite").collect()
        } else {
            TYPES.iter().copied().filter(|t| input.types.iter().any(|wanted| wanted == t)).collect()
        };
        Ok(Zone { bounds: bounds_of(&input.ring), id: input.id, ring: input.ring, departments: input.departments.into_iter().collect(), types })
    }

    pub fn contains(&self, lon: f64, lat: f64) -> bool {
        let b = self.bounds;
        lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && in_ring(lon, lat, &self.ring)
    }

    /// La zone touche-t-elle ce rectangle (ouest, sud, est, nord) ? Approximation : un sommet de la zone dans le rectangle, ou le
    /// centre ou un coin du rectangle dans la zone (suffisant pour les cases de brouillage de 0,5°).
    pub fn touches(&self, rect: [f64; 4]) -> bool {
        let b = self.bounds;
        if rect[2] < b[0] || rect[0] > b[2] || rect[3] < b[1] || rect[1] > b[3] {
            return false;
        }
        let inside = |lon: f64, lat: f64| lon >= rect[0] && lon <= rect[2] && lat >= rect[1] && lat <= rect[3];
        self.ring.iter().any(|&[lon, lat]| inside(lon, lat))
            || [(rect[0], rect[1]), (rect[2], rect[1]), (rect[2], rect[3]), (rect[0], rect[3]), ((rect[0] + rect[2]) / 2.0, (rect[1] + rect[3]) / 2.0)]
                .iter()
                .any(|&(lon, lat)| in_ring(lon, lat, &self.ring))
    }
}

// --- L'index national ------------------------------------------------------------------------------------------------

/// Un événement posé quelque part : on le teste contre le contour d'une zone (ou, pour une case, contre son rectangle).
#[derive(Debug)]
pub struct Located {
    pub event: Event,
    rect: Option<[f64; 4]>,
}

#[derive(Debug, Default)]
pub struct Index {
    pub generated_at: i64,
    located: Vec<Located>,
    /// Vigilance : événements par département (la zone dit quels départements elle touche).
    by_department: Vec<Event>,
    unavailable: Vec<&'static str>,
}

fn level_word(level: u8) -> &'static str {
    match level {
        4 => "rouge",
        3 => "orange",
        _ => "jaune",
    }
}

/// Un événement ponctuel : tout est nommé, rien n'est positionnel.
struct Point {
    kind: &'static str,
    id: String,
    severity: u8,
    title: String,
    detail: String,
    lon: f64,
    lat: f64,
    time: Option<i64>,
    module: &'static str,
    selection: Value,
    zoom: f64,
}

impl Point {
    fn located(self, rect: Option<[f64; 4]>) -> Located {
        Located {
            event: Event {
                id: self.id,
                kind: self.kind,
                severity: self.severity,
                title: self.title,
                detail: self.detail,
                lon: Some(self.lon),
                lat: Some(self.lat),
                department: None,
                time: self.time,
                module: self.module,
                selection: self.selection,
                zoom: self.zoom,
            },
            rect,
        }
    }
}

fn vigilance_events(body: &Option<Bytes>, now: i64) -> Option<Vec<Event>> {
    let input: InVigilance = decoded("vigilance (veille)", body)?;
    let index = input.periods.iter().position(|p| p.begin <= now && now < p.end)?;
    let mut events = Vec::new();
    for (code, entries) in &input.departments {
        let Some(entry) = entries.get(index) else { continue };
        for phenomenon in entry.phenomena.iter().filter(|p| p.level >= 3) {
            let name = PHENOMENA.get(usize::from(phenomenon.id)).copied().unwrap_or("phénomène");
            events.push(Event {
                id: format!("vig:{code}:{}:{}", phenomenon.id, phenomenon.level),
                kind: "vigilance",
                severity: phenomenon.level.min(4),
                title: format!("Vigilance {} · {name}", level_word(phenomenon.level)),
                detail: String::new(),
                lon: None,
                lat: None,
                department: Some(code.clone()),
                time: Some(input.issued_at),
                module: "vigilance-meteo",
                selection: json!({ "code": code }),
                zoom: 7.4,
            });
        }
    }
    Some(events)
}

/// Crues : les tronçons Vigicrues (leur point central) puis les stations voisines d'un tronçon en vigilance. Un tronçon vu des
/// deux façons n'est signalé qu'une fois : l'identifiant est le même (nom du tronçon, niveau) et le tronçon passe en premier.
fn flood_events(sections: Option<(i64, Vec<FloodSection>)>, rivers_body: &Option<Bytes>, now: i64) -> Option<Vec<Located>> {
    let (fetched_at, sections) = sections?;
    let mut out: Vec<Located> = sections
        .iter()
        .filter(|s| s.level >= 2)
        .map(|s| {
            Point {
                kind: "crue",
                id: format!("crue:{}:{}", s.name, s.level),
                severity: s.level.min(4),
                title: format!("Vigilance crues {}", level_word(s.level)),
                detail: s.name.clone(),
                lon: s.lon,
                lat: s.lat,
                time: Some(fetched_at),
                module: "vigicrues",
                selection: json!({ "id": s.id }),
                zoom: 9.0,
            }
            .located(None)
        })
        .collect();
    if let Some(rivers) = decoded::<InRivers>("rivières (veille, crues)", rivers_body) {
        for s in rivers.stations.iter().filter(|s| now - s.t < RIVER_STALE_S) {
            let (Some(level), Some(section)) = (s.vig, s.vig_name.as_ref()) else { continue };
            if level < 2 {
                continue;
            }
            out.push(
                Point {
                    kind: "crue",
                    id: format!("crue:{section}:{level}"),
                    severity: level.min(4),
                    title: format!("Vigilance crues {}", level_word(level)),
                    detail: section.clone(),
                    lon: s.lon,
                    lat: s.lat,
                    time: Some(s.t),
                    module: "rivieres",
                    selection: json!({ "id": s.id }),
                    zoom: 11.0,
                }
                .located(None),
            );
        }
    }
    Some(out)
}

fn rising_events(body: &Option<Bytes>, now: i64) -> Option<Vec<Located>> {
    let input: InRivers = decoded("rivières (veille)", body)?;
    let events = input
        .stations
        .iter()
        .filter(|s| now - s.t < RIVER_STALE_S && s.d.is_some_and(|d| d >= RIVER_FAST_MM) && !s.tidal && !rivers::is_tidal(&s.name, s.lon, s.lat))
        .map(|s| {
            let rise = s.d.unwrap_or(0);
            let height = format!("{:.2}", f64::from(s.h) / 1000.0).replace('.', ",");
            Point {
                kind: "montee",
                id: format!("montee:{}", s.id),
                severity: if s.vig.is_some_and(|v| v >= 3) { 3 } else { 2 },
                title: "Rivière en forte montée".into(),
                detail: format!("{} · +{} cm en 3 h · {height} m", s.name, rise / 10),
                lon: s.lon,
                lat: s.lat,
                time: Some(s.t),
                module: "rivieres",
                selection: json!({ "id": s.id }),
                zoom: 11.0,
            }
            .located(None)
        })
        .collect();
    Some(events)
}

fn fire_events(body: &Option<Bytes>, now: i64) -> Option<Vec<Located>> {
    let input: InFires = decoded("feux (veille)", body)?;
    let recent = recent_fires(&input, now);
    let events = cluster_fires(&recent)
        .into_iter()
        .filter(|(_, c)| c.total >= FIRE_NOTABLE_MW)
        .filter_map(|((ix, iy), c)| {
            let fire = c.strongest?;
            Some(
                Point {
                    kind: "incendie",
                    id: format!("feu:{ix}:{iy}"),
                    severity: if c.total >= 100.0 { 3 } else { 2 },
                    title: "Incendie détecté par satellite".into(),
                    detail: format!("{} MW · {} détection{}", (c.total * 10.0).round() / 10.0, c.count, if c.count > 1 { "s" } else { "" }),
                    lon: fire.lon,
                    lat: fire.lat,
                    time: Some(c.latest),
                    module: "feux",
                    // Même clé que la couche : satellite, heure, position de la détection la plus puissante.
                    selection: json!({ "key": format!("{}|{}|{}|{}", fire.satellite, fire.time, fire.lon, fire.lat) }),
                    zoom: 10.5,
                }
                .located(None),
            )
        })
        .collect();
    Some(events)
}

/// Risque d'avalanche fort (4) ou très fort (5) sur un massif : le risque marqué (3) est quotidien en plein hiver. Le massif est
/// testé par son rectangle englobant (la zone le touche), la fiche s'ouvre sur le massif. Le risque est dans l'identifiant : un
/// massif qui passe de 4 à 5 est signalé de nouveau.
fn avalanche_events(warnings: &Option<Vec<crate::neige::Warning>>) -> Option<Vec<Located>> {
    let events = warnings
        .as_ref()?
        .iter()
        .filter(|w| w.risk >= 4)
        .map(|w| {
            let band = match (w.risk_low, w.risk_high, w.altitude) {
                (Some(low), Some(high), Some(alt)) if low != high => format!(" · risque {low} sous {alt} m, {high} au-dessus"),
                _ => String::new(),
            };
            Point {
                kind: "avalanche",
                id: format!("avalanche:{}:{}", w.id, w.risk),
                severity: if w.risk >= 5 { 4 } else { 3 },
                title: format!("Risque d'avalanche {}", if w.risk >= 5 { "très fort (5/5)" } else { "fort (4/5)" }),
                detail: format!("Massif {}{band}", w.name),
                lon: w.lon,
                lat: w.lat,
                time: Some(w.issued),
                module: "neige",
                selection: json!({ "id": w.id }),
                zoom: 9.0,
            }
            .located(Some(w.bounds))
        })
        .collect();
    Some(events)
}

fn jamming_events(body: &Option<Bytes>) -> Option<Vec<Located>> {
    let input: InJamming = decoded("brouillage (veille)", body)?;
    let half = input.cell_deg / 2.0;
    let events = input
        .cells
        .iter()
        .filter(|c| c.n >= input.min_aircraft && c.bad >= input.min_degraded && f64::from(c.bad) / f64::from(c.n) >= JAMMING_SHARE)
        .map(|c| {
            let share = f64::from(c.bad) / f64::from(c.n);
            Point {
                kind: "brouillage",
                id: format!("brouillage:{}:{}", c.lon, c.lat),
                severity: if share >= 0.25 { 3 } else { 2 },
                title: "Brouillage GPS".into(),
                detail: format!("{} avion{} sur {} à la position dégradée ({} %)", c.bad, if c.bad > 1 { "s" } else { "" }, c.n, (share * 100.0).round()),
                lon: c.lon + half,
                lat: c.lat + half,
                time: Some(input.updated_at),
                module: "brouillage-gps",
                selection: json!({ "key": format!("{},{}", c.lon, c.lat) }),
                zoom: 6.5,
            }
            .located(Some([c.lon, c.lat, c.lon + input.cell_deg, c.lat + input.cell_deg]))
        })
        .collect();
    Some(events)
}

fn plane_events(body: &Option<Bytes>) -> Option<Vec<Located>> {
    let input: InPlanes = decoded("avions (veille)", body)?;
    let events = input
        .planes
        .iter()
        .filter(|p| p.military && !p.ground && p.seen_pos < PLANE_STALE_S)
        .map(|p| {
            let callsign = p.callsign.as_deref().map(str::trim).filter(|c| !c.is_empty());
            let detail = [p.kind.clone(), p.alt_baro.map(|ft| format!("{} m", (ft * FT).round() as i64))].into_iter().flatten().collect::<Vec<_>>().join(" · ");
            Point {
                kind: "avion",
                id: format!("avion:{}", p.hex),
                severity: 1,
                title: format!("Avion militaire {}", callsign.map_or_else(|| format!("ICAO {}", p.hex.to_uppercase()), str::to_string)),
                detail,
                lon: p.lon,
                lat: p.lat,
                time: Some(input.updated_at),
                module: "avions",
                selection: json!({ "hex": p.hex }),
                zoom: 8.0,
            }
            .located(None)
        })
        .collect();
    Some(events)
}

fn paris_hm(seconds: i64) -> String {
    let zone = TimeZone::get("Europe/Paris").unwrap_or(TimeZone::UTC);
    Timestamp::from_second(seconds)
        .map(|t| {
            let zoned = t.to_zoned(zone);
            format!("{:02}:{:02}", zoned.hour(), zoned.minute())
        })
        .unwrap_or_default()
}

/// Trains très en retard ou supprimés, posés sur la gare de départ ou d'arrivée (un événement par extrémité concernée) : la zone
/// les attrape si cette gare est dedans. Même source que `trains()` de la synthèse (horaires et temps réel déjà en mémoire).
fn train_events(network: &Network, realtime: &Realtime, now: i64) -> Vec<Located> {
    let timetable = &network.timetable;
    let mut out = Vec::new();
    let mut identities: HashSet<(&str, i64)> = HashSet::new();
    for run in timetable.runs_between(now - TRAIN_WINDOW_S, now + TRAIN_WINDOW_S) {
        let stops = &run.trip.stops;
        let (Some(first), Some(last)) = (stops.first(), stops.last()) else { continue };
        let Some(live) = realtime.apply(&run, &timetable.stop_points) else { continue };
        let planned_departure = run.day_start + i64::from(first.departure);
        let planned_arrival = run.day_start + i64::from(last.arrival);
        if !identities.insert((run.trip.number.as_str(), planned_departure)) {
            continue;
        }
        let (Some(from), Some(to)) = (timetable.stations.get(first.station as usize), timetable.stations.get(last.station as usize)) else { continue };
        let name = if run.trip.category.is_empty() { run.trip.number.clone() } else { format!("{} {}", run.trip.category, run.trip.number) };
        let route = format!("{} → {}", from.name, to.name);
        let identity = format!("{}@{planned_departure}", run.trip.number);

        // Un train qui roule se sélectionne par son identité ; un train supprimé, par sa gare (le tableau des départs le montre supprimé).
        let rolling = |end: &str, severity: u8, title: String, detail: String, station: &crate::timetable::Station, time: i64| {
            Point {
                kind: "train",
                id: format!("train:{identity}:{end}"),
                severity,
                title,
                detail,
                lon: station.lon,
                lat: station.lat,
                time: Some(time),
                module: "trains",
                selection: json!({ "type": "train", "id": identity }),
                zoom: 9.5,
            }
            .located(None)
        };
        let canceled = |end: &str, title: String, detail: String, station: &crate::timetable::Station, time: i64| {
            Point {
                kind: "train",
                id: format!("train:{identity}:{end}"),
                severity: 3,
                title,
                detail,
                lon: station.lon,
                lat: station.lat,
                time: Some(time),
                module: "trains",
                selection: json!({ "type": "gare", "key": format!("{}|{:.4}|{:.4}", station.name, station.lon, station.lat) }),
                zoom: 11.0,
            }
            .located(None)
        };

        if live.canceled {
            if planned_departure > now - CANCEL_BEFORE_S && planned_departure < now + CANCEL_AFTER_S {
                out.push(canceled("dep", format!("{name} supprimé"), format!("{route} · départ prévu à {}", paris_hm(planned_departure)), from, planned_departure));
            }
            if planned_arrival > now - CANCEL_BEFORE_S && planned_arrival < now + CANCEL_AFTER_S {
                out.push(canceled("arr", format!("{name} supprimé"), format!("{route} · arrivée prévue à {}", paris_hm(planned_arrival)), to, planned_arrival));
            }
            continue;
        }
        let (Some(&start), Some(&end)) = (live.departure.first(), live.arrival.last()) else { continue };
        // Au départ : retard annoncé, train pas encore parti (ou parti depuis un instant).
        let departure_delay = (start - planned_departure) / 60;
        if departure_delay >= TRAIN_ALERT_MIN && now < start + 300 {
            let severity = if departure_delay >= TRAIN_SEVERE_MIN { 3 } else { 2 };
            out.push(rolling("dep", severity, format!("{name} · +{departure_delay} min au départ"), format!("{route} · départ prévu à {}", paris_hm(planned_departure)), from, start));
        }
        // À l'arrivée : retard prévu au terminus, train pas encore arrivé (ou arrivé depuis un instant).
        let arrival_delay = (end - planned_arrival) / 60;
        if arrival_delay >= TRAIN_ALERT_MIN && now < end + 900 {
            let severity = if arrival_delay >= TRAIN_SEVERE_MIN { 3 } else { 2 };
            out.push(rolling("arr", severity, format!("{name} · +{arrival_delay} min à l’arrivée"), format!("{route} · arrivée prévue à {}", paris_hm(planned_arrival)), to, end));
        }
    }
    out
}

/// Événements publics (concerts, marchés…) qui commencent dans les 6 prochaines heures, d'après la couche « Événements » (déjà en
/// mémoire). Gravité « à noter » : ils passent après tout le reste dans une zone. Pas de rubrique « muette » si la source manque :
/// c'est un type facultatif, désactivé par défaut.
fn add_public_events(index: &mut Index, now: i64) {
    let Some(soon) = crate::events::starting_soon(now, 6) else { return };
    index.located.extend(soon.into_iter().map(|e| {
        Point {
            kind: "evenement",
            id: format!("evt:{}:{}", e.id, e.start),
            severity: 1,
            title: e.title,
            detail: e.detail,
            lon: e.lon,
            lat: e.lat,
            time: Some(e.start),
            module: "evenements",
            selection: json!({ "id": e.id }),
            zoom: 14.0,
        }
        .located(None)
    }));
}

/// Titres d'actualité locale des 3 dernières heures (au plus 400), posés sur leur commune (ou le milieu de leur département).
fn news_events(now: i64) -> Option<Vec<Located>> {
    let news = crate::actualite::recent(now, 3 * 3600, 400)?;
    Some(
        news.into_iter()
            .map(|n| {
                Point {
                    kind: "actualite",
                    id: n.id,
                    severity: 1,
                    title: n.title,
                    detail: format!("{} · {}", n.place_name, n.source),
                    lon: n.lon,
                    lat: n.lat,
                    time: Some(n.t),
                    module: "actualite",
                    selection: json!({ "place": n.place }),
                    zoom: 11.0,
                }
                .located(None)
            })
            .collect(),
    )
}

pub fn build_index(inputs: &Inputs, trains: Option<Vec<Located>>, now: i64) -> Index {
    let mut index = Index { generated_at: now, ..Index::default() };
    match vigilance_events(&inputs.vigilance, now) {
        Some(events) => index.by_department = events,
        None => index.unavailable.push("vigilance"),
    }
    let mut add = |kind: &'static str, events: Option<Vec<Located>>| match events {
        Some(events) => index.located.extend(events),
        None => index.unavailable.push(kind),
    };
    add("crue", flood_events(inputs.floods.clone(), &inputs.rivers, now));
    add("montee", rising_events(&inputs.rivers, now));
    add("incendie", fire_events(&inputs.fires, now));
    add("brouillage", jamming_events(&inputs.jamming));
    add("avion", plane_events(&inputs.planes));
    add("avalanche", avalanche_events(&inputs.avalanches));
    add("train", trains);
    index
}

// --- Évaluation d'une zone -----------------------------------------------------------------------------------------------

/// Les événements de l'index qui sont dans la zone et d'un type voulu, les plus graves d'abord (puis les plus récents), sans doublon.
pub fn evaluate(index: &Index, zone: &Zone) -> Vec<Event> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut found: Vec<&Event> = Vec::new();
    for event in index.by_department.iter().filter(|e| zone.types.contains(e.kind) && e.department.as_ref().is_some_and(|d| zone.departments.contains(d))) {
        if seen.insert(&event.id) {
            found.push(event);
        }
    }
    for located in &index.located {
        let event = &located.event;
        if !zone.types.contains(event.kind) {
            continue;
        }
        let (Some(lon), Some(lat)) = (event.lon, event.lat) else { continue };
        let inside = match located.rect {
            Some(rect) => zone.touches(rect),
            None => zone.contains(lon, lat),
        };
        if inside && seen.insert(&event.id) {
            found.push(event);
        }
    }
    found.sort_by(|a, b| b.severity.cmp(&a.severity).then(b.time.cmp(&a.time)).then(a.id.cmp(&b.id)));
    found.truncate(MAX_EVENTS_PER_ZONE);
    found.into_iter().cloned().collect()
}

// --- La route ------------------------------------------------------------------------------------------------------------

static INDEX: std::sync::OnceLock<tokio::sync::Mutex<Option<(Instant, Arc<Index>)>>> = std::sync::OnceLock::new();

async fn current_index(state: AppState) -> Result<Arc<Index>, String> {
    let cache = INDEX.get_or_init(|| tokio::sync::Mutex::new(None));
    // Le verrou est gardé pendant le calcul : des requêtes simultanées n'en provoquent qu'un.
    let mut guard = cache.lock().await;
    if let Some((at, index)) = guard.as_ref()
        && at.elapsed() < CACHE_FOR
    {
        return Ok(index.clone());
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
            air: None,
            avalanches: crate::neige::warnings(now),
        };
        let trains = state.realtime().map(|realtime| train_events(&state.network(), &realtime, now));
        let mut index = build_index(&inputs, trains, now);
        add_public_events(&mut index, now);
        // Actualité locale : les titres des 3 dernières heures, un événement par titre (gravité 1, à noter).
        // Pas signalée « muette » quand elle n'a pas démarré : c'est une option, pas une alerte officielle.
        if let Some(events) = news_events(now) {
            index.located.extend(events);
        }
        index
    })
    .await
    .map_err(|e| e.to_string())?;
    let index = Arc::new(computed);
    *guard = Some((Instant::now(), index.clone()));
    Ok(index)
}

/// `POST /api/veille` : `{ "zones": [{ "id", "ring": [[lon, lat], …], "departments": ["33"], "types": ["vigilance", …] }] }`.
pub async fn handler(State(state): State<AppState>, body: Bytes) -> Response {
    if body.len() > 256 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "requête trop grosse").into_response();
    }
    let request: Request = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::UNPROCESSABLE_ENTITY, format!("requête illisible : {error}")).into_response(),
    };
    if request.zones.len() > MAX_ZONES {
        return (StatusCode::UNPROCESSABLE_ENTITY, format!("{MAX_ZONES} zones au plus")).into_response();
    }
    let zones: Result<Vec<Zone>, String> = request.zones.into_iter().map(Zone::parse).collect();
    let zones = match zones {
        Ok(zones) => zones,
        Err(message) => return (StatusCode::UNPROCESSABLE_ENTITY, message).into_response(),
    };
    let index = match current_index(state).await {
        Ok(index) => index,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    };
    let out = VeilleOut {
        generated_at: index.generated_at,
        unavailable: index.unavailable.clone(),
        zones: zones.iter().map(|zone| ZoneOut { id: zone.id.clone(), events: evaluate(&index, zone) }).collect(),
    };
    ([(axum::http::header::CACHE_CONTROL, "no-store")], Json(out)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn bytes(json: &str) -> Option<Bytes> {
        Some(Bytes::from(json.to_string()))
    }

    fn zone(id: &str, ring: &[[f64; 2]], departments: &[&str], types: &[&str]) -> Zone {
        Zone::parse(ZoneIn { id: id.into(), ring: ring.to_vec(), departments: departments.iter().map(|d| d.to_string()).collect(), types: types.iter().map(|t| t.to_string()).collect() }).unwrap()
    }

    /// Un carré de 1° autour de (2, 47).
    const SQUARE: [[f64; 2]; 4] = [[1.5, 46.5], [2.5, 46.5], [2.5, 47.5], [1.5, 47.5]];

    #[test]
    fn point_in_polygon_handles_inside_outside_and_concave_shapes() {
        assert!(in_ring(2.0, 47.0, &SQUARE));
        assert!(!in_ring(3.0, 47.0, &SQUARE));
        assert!(!in_ring(2.0, 48.0, &SQUARE));
        // Un « U » : le creux n'est pas dedans.
        let u = [[0.0, 0.0], [3.0, 0.0], [3.0, 3.0], [2.0, 3.0], [2.0, 1.0], [1.0, 1.0], [1.0, 3.0], [0.0, 3.0]];
        assert!(in_ring(0.5, 2.0, &u));
        assert!(in_ring(2.5, 2.0, &u));
        assert!(!in_ring(1.5, 2.0, &u), "le creux du U est dehors");
        assert!(in_ring(1.5, 0.5, &u));
    }

    #[test]
    fn rejects_invalid_zones() {
        let bad = |ring: Vec<[f64; 2]>| Zone::parse(ZoneIn { id: "z".into(), ring, departments: vec![], types: vec![] }).is_err();
        assert!(bad(vec![[0.0, 0.0], [1.0, 1.0]]), "deux sommets");
        assert!(bad(vec![[0.0, 0.0], [1.0, 1.0], [400.0, 2.0]]), "longitude impossible");
        assert!(bad(vec![[0.0, 0.0]; MAX_VERTICES + 1]), "trop de sommets");
        assert!(Zone::parse(ZoneIn { id: String::new(), ring: SQUARE.to_vec(), departments: vec![], types: vec![] }).is_err());
    }

    #[test]
    fn a_jamming_cell_touches_a_zone_it_overlaps_even_when_its_centre_is_outside() {
        // Zone minuscule au bord est d'une case de 0,5° : ni le centre de la case ni ses coins ne sont dedans, mais un sommet de la zone y est.
        let tiny = zone("z", &[[2.40, 46.90], [2.45, 46.90], [2.45, 46.95]], &[], &[]);
        assert!(tiny.touches([2.0, 46.5, 2.5, 47.0]));
        assert!(!tiny.touches([3.0, 46.5, 3.5, 47.0]));
        // Une grande zone qui contient la case sans y avoir de sommet.
        let big = zone("z", &[[0.0, 40.0], [5.0, 40.0], [5.0, 50.0], [0.0, 50.0]], &[], &[]);
        assert!(big.touches([2.0, 46.5, 2.5, 47.0]));
    }

    #[test]
    fn the_zone_gets_vigilance_by_department_and_only_orange_or_red() {
        let body = format!(
            r#"{{"issuedAt":{i},"periods":[{{"name":"J","begin":{b},"end":{e}}}],"departments":{{
              "18":[{{"max":3,"phenomena":[{{"id":3,"level":3,"slots":[]}},{{"id":1,"level":2,"slots":[]}}]}}],
              "36":[{{"max":4,"phenomena":[{{"id":2,"level":4,"slots":[]}}]}}],
              "33":[{{"max":3,"phenomena":[{{"id":1,"level":3,"slots":[]}}]}}]
            }}}}"#,
            i = NOW - 100,
            b = NOW - 1000,
            e = NOW + 1000
        );
        let events = vigilance_events(&bytes(&body), NOW).unwrap();
        assert_eq!(events.len(), 3, "le jaune (vent dans le Cher) n'est pas une alerte");
        let index = Index { generated_at: NOW, by_department: events, ..Index::default() };
        let found = evaluate(&index, &zone("a", &SQUARE, &["18", "36"], &[]));
        assert_eq!(found.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["vig:36:2:4", "vig:18:3:3"], "rouge d'abord, la Gironde (33) est hors zone");
        assert_eq!(found[1].title, "Vigilance orange · orages");
        let only_floods = evaluate(&index, &zone("b", &SQUARE, &["18"], &["crue"]));
        assert!(only_floods.is_empty(), "un type non demandé n'apparaît pas");
    }

    #[test]
    fn rising_rivers_and_fires_are_filtered_by_the_contour_and_tide_is_left_out() {
        let rivers = format!(
            r#"{{"updatedAt":{NOW},"stations":[
              {{"id":"in","name":"Station in","river":"La Loire","lon":2.0,"lat":47.0,"h":1500,"t":{t},"d":450}},
              {{"id":"out","name":"Station out","lon":5.0,"lat":47.0,"h":1500,"t":{t},"d":450}},
              {{"id":"tide","name":"La Garonne à Cadillac","lon":-0.32,"lat":44.63,"h":2240,"t":{t},"d":3050}},
              {{"id":"flat","name":"Station flat","lon":2.1,"lat":47.0,"h":1500,"t":{t},"d":100}}
            ]}}"#,
            t = NOW - 600
        );
        let fires = format!(
            r#"{{"updatedAt":{NOW},"fires":[
              {{"lon":2.01,"lat":47.01,"time":{t},"frp":30.0,"confidence":"n","satellite":"NOAA-20","day":true}},
              {{"lon":2.02,"lat":47.02,"time":{t},"frp":5.0,"confidence":"n","satellite":"NOAA-20","day":true}},
              {{"lon":2.01,"lat":46.9,"time":{t},"frp":3.0,"confidence":"n","satellite":"NOAA-20","day":true}}
            ]}}"#,
            t = NOW - 3600
        );
        let mut located = rising_events(&bytes(&rivers), NOW).unwrap();
        assert_eq!(located.len(), 2, "la marée (Cadillac) et une montée de 10 cm sont écartées");
        located.extend(fire_events(&bytes(&fires), NOW).unwrap());
        let index = Index { generated_at: NOW, located, ..Index::default() };
        let found = evaluate(&index, &zone("a", &SQUARE, &[], &[]));
        let ids: Vec<&str> = found.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(found.len(), 2, "{ids:?}");
        assert!(ids.contains(&"montee:in") && ids.contains(&"feu:20:470"), "{ids:?}");
        assert!(!ids.contains(&"montee:out"));
        let fire = found.iter().find(|e| e.kind == "incendie").unwrap();
        assert_eq!(fire.selection["key"], format!("NOAA-20|{}|2.01|47.01", NOW - 3600));
        assert_eq!(fire.detail, "35 MW · 2 détections");
    }

    #[test]
    fn tidal_stations_flagged_by_the_server_never_raise_a_rise_or_a_flood_alert() {
        // Le serveur n'envoie ni `d` ni `vig` pour une station soumise à la marée ; même si un ancien serveur les envoyait, le drapeau l'emporte.
        let rivers = format!(
            r#"{{"updatedAt":{NOW},"stations":[
              {{"id":"estuaire","name":"Station A","lon":2.0,"lat":47.0,"h":2240,"t":{t},"d":3050,"vig":3,"vigName":"Basse Seine","tidal":true}},
              {{"id":"vraie","name":"Station B","lon":2.0,"lat":47.0,"h":1500,"t":{t},"d":450}}
            ]}}"#,
            t = NOW - 600
        );
        let rising = rising_events(&bytes(&rivers), NOW).unwrap();
        assert_eq!(rising.iter().map(|l| l.event.id.as_str()).collect::<Vec<_>>(), vec!["montee:vraie"]);
    }

    #[test]
    fn strong_avalanche_risk_is_reported_for_a_zone_touching_the_massif_and_changes_id_with_the_risk() {
        let warning = |risk| crate::neige::Warning {
            id: 3,
            name: "Mont-Blanc".into(),
            lon: 2.0,
            lat: 47.0,
            bounds: [1.9, 46.9, 2.1, 47.1],
            risk,
            risk_low: Some(3),
            risk_high: Some(risk),
            altitude: Some(2700),
            issued: NOW - 3600,
            valid_until: NOW + 80_000,
        };
        assert!(avalanche_events(&None).is_none());
        let marked = avalanche_events(&Some(vec![warning(3)])).unwrap();
        assert!(marked.is_empty(), "le risque marqué est quotidien : pas d'alerte");
        let located = avalanche_events(&Some(vec![warning(4)])).unwrap();
        let index = Index { generated_at: NOW, located, ..Index::default() };
        let found = evaluate(&index, &zone("a", &SQUARE, &[], &["avalanche"]));
        assert_eq!(found.len(), 1);
        let event = &found[0];
        assert_eq!((event.id.as_str(), event.severity, event.module), ("avalanche:3:4", 3, "neige"));
        assert_eq!(event.detail, "Massif Mont-Blanc · risque 3 sous 2700 m, 4 au-dessus");
        assert_eq!(event.selection["id"], 3);
        let very = avalanche_events(&Some(vec![warning(5)])).unwrap();
        assert_eq!((very[0].event.id.as_str(), very[0].event.severity), ("avalanche:3:5", 4));
        assert!(evaluate(&Index { generated_at: NOW, located: very, ..Index::default() }, &zone("b", &SQUARE, &[], &["train"])).is_empty());
    }

    #[test]
    fn a_flood_section_seen_twice_is_reported_once_and_the_section_wins() {
        let section = FloodSection { id: "797".into(), name: "Hem".into(), level: 2, lon: 2.0, lat: 47.0 };
        let rivers = format!(
            r#"{{"updatedAt":{NOW},"stations":[{{"id":"E1","name":"La Hem à X","lon":2.05,"lat":47.05,"h":900,"t":{t},"vig":2,"vigName":"Hem"}}]}}"#,
            t = NOW - 600
        );
        let located = flood_events(Some((NOW, vec![section])), &bytes(&rivers), NOW).unwrap();
        assert_eq!(located.len(), 2);
        let index = Index { generated_at: NOW, located, ..Index::default() };
        let found = evaluate(&index, &zone("a", &SQUARE, &[], &["crue"]));
        assert_eq!(found.len(), 1, "même tronçon, même niveau : une seule alerte");
        assert_eq!(found[0].module, "vigicrues");
        assert_eq!(found[0].id, "crue:Hem:2");
    }

    #[test]
    fn a_jamming_cell_is_reported_for_a_zone_inside_it_and_carries_the_layer_key() {
        let body = format!(
            r#"{{"updatedAt":{NOW},"cellDeg":0.5,"windowS":1200,"coveredS":1200,"minAircraft":4,"minDegraded":2,"cells":[{{"lon":2.0,"lat":47.0,"n":10,"bad":4}},{{"lon":3.0,"lat":47.0,"n":10,"bad":1}}]}}"#
        );
        let located = jamming_events(&bytes(&body)).unwrap();
        assert_eq!(located.len(), 1);
        let index = Index { generated_at: NOW, located, ..Index::default() };
        // Une zone au milieu de la case, sans sommet dans le rectangle de la case à moins que ce soit elle qui la contienne.
        let found = evaluate(&index, &zone("a", &[[2.1, 47.1], [2.2, 47.1], [2.2, 47.2]], &[], &[]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].selection["key"], "2,47");
        assert_eq!(found[0].severity, 3);
    }
}
