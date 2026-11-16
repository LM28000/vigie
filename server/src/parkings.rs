//! Parkings : places libres en direct dans les parkings et parcs relais des villes qui publient
//! leur disponibilité en données ouvertes, rassemblées en une seule liste.
//!
//! Il n'existe pas d'agrégat national de la disponibilité en temps réel (le catalogue de
//! transport.data.gouv.fr ne référence que des bases statiques, sans places libres) : chaque
//! ville publie sur son portail, presque toujours en Opendatasoft (API « explore v2.1 »). Les
//! sources retenues sont ouvertes (Licence Ouverte 2.0, ODbL) et sans compte ; la liste est dans
//! `SOURCES`, une ligne par jeu de données, avec la fonction qui décode sa réponse.
//!
//! Chaque source est relevée à son rythme (5 minutes : les exploitants rafraîchissent leurs
//! compteurs chaque minute ou presque, mais une jauge de parking n'a pas besoin de plus). Le
//! serveur ne garde que la dernière liste de chaque source et, pour la courbe de la journée,
//! les places libres des dernières 24 heures (un relevé toutes les 5 minutes, 8 octets chacun :
//! quelques centaines de ko pour toute la France). L'historique est perdu au redémarrage.

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::extract::Query;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use flate2::read::GzDecoder;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinSet;
use tracing::{info, warn};

/// Au plus un relevé toutes les 5 minutes par source.
const EVERY: Duration = Duration::from_secs(5 * 60);
/// Le cycle de réveil : on regarde alors quelles sources sont à relever.
const TICK: Duration = Duration::from_secs(30);
/// Une source muette depuis plus longtemps disparaît de la liste (mieux vaut pas de jauge qu'une jauge d'hier).
const DROP_AFTER: Duration = Duration::from_secs(6 * 3600);
/// Durée de l'historique gardé pour les courbes.
const HISTORY_S: i64 = 24 * 3600;
/// Description fixe de Grenoble (noms, capacités) : quelques fois par jour.
const GRENOBLE_SITES_EVERY: Duration = Duration::from_secs(6 * 3600);
const PAGE: usize = 100;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Parking,
    Relais,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Ouvert,
    Complet,
    Ferme,
    /// Ouvert aux abonnés seulement.
    Abonnes,
}

/// Un parking, dans le format commun à toutes les sources.
#[derive(Clone, Debug, PartialEq)]
struct Parking {
    /// Identifiant dans la source.
    id: String,
    name: String,
    lon: f64,
    lat: f64,
    capacity: Option<u32>,
    free: u32,
    /// Heure du relevé de l'exploitant (secondes Unix), si la source la donne.
    measured_at: Option<i64>,
    kind: Kind,
    status: Status,
}

enum Fetch {
    /// Jeu Opendatasoft : portail, jeu, champs demandés, filtre éventuel.
    Ods { host: &'static str, dataset: &'static str, select: &'static str, filter: Option<&'static str>, decode: fn(&[Value]) -> Vec<Parking>, stamped_by_dataset: bool },
    /// Mobilités M (Grenoble) : sites (GeoJSON) et places libres (JSON), deux fichiers.
    Grenoble,
}

struct Source {
    /// Agglomération, pour regrouper les parkings de loin.
    area: &'static str,
    /// Nom du jeu de données, tel que le crédite la fiche.
    name: &'static str,
    licence: &'static str,
    /// Page du jeu de données.
    link: &'static str,
    fetch: Fetch,
}

const ODS_RENNES: &str = "data.rennesmetropole.fr";
const ODS_NANTES: &str = "data.nantesmetropole.fr";
const ODBL: &str = "ODbL";
const LO2: &str = "Licence Ouverte 2.0";

const SOURCES: &[Source] = &[
    Source {
        area: "Rennes",
        name: "Rennes Métropole, parkings en ouvrage (Citédia)",
        licence: ODBL,
        link: "https://data.rennesmetropole.fr/explore/dataset/export-api-parking-citedia/",
        fetch: Fetch::Ods { host: ODS_RENNES, dataset: "export-api-parking-citedia", select: "key,status,max,free,id,geo", filter: None, decode: decode_rennes, stamped_by_dataset: true },
    },
    Source {
        area: "Rennes",
        name: "STAR, parcs relais de Rennes",
        licence: ODBL,
        link: "https://data.explore.star.fr/explore/dataset/tco-parcsrelais-star-etat-tr/",
        fetch: Fetch::Ods {
            host: "data.explore.star.fr",
            dataset: "tco-parcsrelais-star-etat-tr",
            select: "idparc,nom,coordonnees,lastupdate,capacitesoliste,jrdinfosoliste,etatouverture,etatremplissage",
            filter: None,
            decode: decode_star,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Nantes",
        name: "Nantes Métropole, parkings publics (Naolib)",
        licence: ODBL,
        link: "https://data.nantesmetropole.fr/explore/dataset/244400404_parkings-publics-nantes-disponibilites/",
        fetch: Fetch::Ods {
            host: ODS_NANTES,
            dataset: "244400404_parkings-publics-nantes-disponibilites",
            select: NANTES_SELECT,
            filter: None,
            decode: decode_nantes,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Nantes",
        name: "Nantes Métropole, parcs relais (Naolib)",
        licence: ODBL,
        link: "https://data.nantesmetropole.fr/explore/dataset/244400404_parcs-relais-nantes-metropole-disponibilites/",
        fetch: Fetch::Ods {
            host: ODS_NANTES,
            dataset: "244400404_parcs-relais-nantes-metropole-disponibilites",
            select: NANTES_SELECT,
            filter: None,
            decode: decode_nantes,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Strasbourg",
        name: "Eurométropole de Strasbourg, occupation des parkings",
        licence: "Licence Ouverte (Etalab)",
        link: "https://data.strasbourg.eu/explore/dataset/occupation-parkings-temps-reel/",
        fetch: Fetch::Ods {
            host: "data.strasbourg.eu",
            dataset: "occupation-parkings-temps-reel",
            select: "ident,nom_parking,etat,total,libre,position",
            filter: None,
            decode: decode_strasbourg,
            stamped_by_dataset: true,
        },
    },
    Source {
        area: "Bordeaux",
        name: "Bordeaux Métropole, parkings hors voirie",
        licence: "Licence Ouverte (Etalab)",
        link: "https://datahub.bordeaux-metropole.fr/explore/dataset/st_park_p/",
        fetch: Fetch::Ods {
            host: "datahub.bordeaux-metropole.fr",
            dataset: "st_park_p",
            select: "ident,nom,etat,libres,total,np_total,mdate,geo_point_2d",
            // Seuls les parkings dont le compteur est branché ont des places libres : les autres sont de simples fiches.
            filter: Some("connecte=1"),
            decode: decode_bordeaux,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Clermont-Ferrand",
        name: "Clermont Auvergne Métropole, parcs de stationnement",
        licence: LO2,
        link: "https://opendata.clermontmetropole.eu/explore/dataset/occupation_parcs_stationnement_metropolitains/",
        fetch: Fetch::Ods {
            host: "opendata.clermontmetropole.eu",
            dataset: "occupation_parcs_stationnement_metropolitains",
            select: "identifiant,nom,etat,places_libres,capacite_maximale,horodatage,point_geo",
            filter: None,
            decode: decode_clermont,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Tours",
        name: "Tours Métropole Val de Loire, parkings en ouvrage (Indigo)",
        licence: ODBL,
        link: "https://data.tours-metropole.fr/explore/dataset/etat-des-parkings-en-ouvrage-en-temps-reel-tours-metropole-val-de-loire/",
        fetch: Fetch::Ods {
            host: "data.tours-metropole.fr",
            dataset: "etat-des-parkings-en-ouvrage-en-temps-reel-tours-metropole-val-de-loire",
            select: "key,libelle_parking,capacite,free_spots,status,updated_at,geo_point",
            filter: None,
            decode: decode_tours,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Aix-Marseille",
        name: "Métropole Aix-Marseille-Provence, disponibilités des places de parkings",
        licence: LO2,
        link: "https://data.ampmetropole.fr/explore/dataset/disponibilites-des-places-de-parkings/",
        fetch: Fetch::Ods {
            host: "data.ampmetropole.fr",
            dataset: "disponibilites-des-places-de-parkings",
            select: "nom,commune,typeparking,tempsreel,voitureplacescapacite,voitureplacesdisponibles,datemajpy,pointgeo",
            filter: None,
            decode: decode_amp,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Orléans",
        name: "Orléans Métropole, parcs de stationnement",
        licence: LO2,
        link: "https://data.orleans-metropole.fr/explore/dataset/om-mobilite-parcs-stationnement/",
        fetch: Fetch::Ods {
            host: "data.orleans-metropole.fr",
            dataset: "om-mobilite-parcs-stationnement",
            select: "nom,type_parking,nb_places,nb_places_disponibles,horodatage_maj_places_disponibles,places_disponibles_temps_reel,etat_equipement,xlong,ylat",
            filter: None,
            decode: decode_orleans,
            stamped_by_dataset: false,
        },
    },
    Source {
        area: "Grenoble",
        name: "Grenoble-Alpes Métropole, Mobilités M, parkings",
        licence: ODBL,
        link: "https://data.mobilites-m.fr/",
        fetch: Fetch::Grenoble,
    },
];

const NANTES_SELECT: &str = "grp_identifiant,grp_nom,grp_statut,grp_disponible,grp_exploitation,grp_complet,grp_horodatage,location";

// --- Lecture des champs ---

/// Un nombre est un nombre ou un texte selon les portails.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().replace(',', ".").parse().ok(),
        _ => None,
    }
}

fn count(value: &Value) -> Option<u32> {
    number(value).filter(|n| *n >= 0.0 && *n < 1.0e6).map(|n| n.round() as u32)
}

fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Instant d'un texte avec fuseau (« 2026-11-16T14:36:03+01:00 »).
fn instant(value: &Value) -> Option<i64> {
    value.as_str()?.parse::<Timestamp>().ok().map(|t| t.as_second())
}

/// Position d'un objet `{lon, lat}` d'Opendatasoft.
fn point(value: &Value) -> Option<(f64, f64)> {
    Some((number(&value["lon"])?, number(&value["lat"])?))
}

/// Des mots tout en majuscules (« DECRE - BOUFFAY ») deviennent « Decré - Bouffay » à peu près :
/// première lettre en capitale, les petits mots en minuscule. Un nom déjà en casse mixte ne bouge pas.
fn tidy_name(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().any(|c| c.is_lowercase()) {
        return collapsed;
    }
    let small = ["de", "du", "des", "la", "le", "les", "d", "l", "et", "sur", "en"];
    let mut out = String::with_capacity(collapsed.len());
    for (index, word) in collapsed.split(' ').enumerate() {
        if index > 0 {
            out.push(' ');
        }
        // Les segments séparés par un tiret ou une apostrophe sont traités un par un.
        let mut start = true;
        let mut segment = String::new();
        let flush = |segment: &mut String, out: &mut String, first: bool| {
            let lower = segment.to_lowercase();
            if !first && small.contains(&lower.as_str()) {
                out.push_str(&lower);
            } else if lower.contains('+') || (lower.len() <= 3 && lower.chars().all(|c| c.is_ascii_digit())) {
                out.push_str(segment);
            } else {
                let mut chars = lower.chars();
                if let Some(first) = chars.next() {
                    out.extend(first.to_uppercase());
                    out.push_str(chars.as_str());
                }
            }
            segment.clear();
        };
        for c in word.chars() {
            if c == '-' || c == '\'' || c == '’' {
                flush(&mut segment, &mut out, index == 0 && start);
                out.push(c);
                start = false;
            } else {
                segment.push(c);
            }
        }
        flush(&mut segment, &mut out, index == 0 && start);
    }
    out
}

fn kind_of(name: &str, hint: Option<&str>) -> Kind {
    let lower = name.to_lowercase();
    let hint = hint.unwrap_or_default().to_lowercase();
    if lower.contains("relais") || lower.contains("p+r") || lower.contains("p + r") || hint.contains("relais") || hint.contains("p + r") || hint.contains("p+r") {
        Kind::Relais
    } else {
        Kind::Parking
    }
}

/// Un parking ouvert sans place libre est complet. Une position hors de la France ou un comptage absurde écarte la ligne.
fn finish(mut parking: Parking) -> Option<Parking> {
    if !(-6.0..=10.0).contains(&parking.lon) || !(41.0..=52.0).contains(&parking.lat) {
        return None;
    }
    if parking.capacity == Some(0) {
        parking.capacity = None;
    }
    // Plus de places libres que de places : le compteur ou la capacité est faux, on ne montre pas de rapport.
    if parking.capacity.is_some_and(|c| parking.free > c) {
        parking.capacity = None;
    }
    if parking.status == Status::Ouvert && parking.free == 0 {
        parking.status = Status::Complet;
    }
    parking.name = tidy_name(&parking.name);
    if parking.name.is_empty() {
        return None;
    }
    Some(parking)
}

// --- Décodeurs, un par format de source ---

/// Rennes, Citédia : `{key, status, max, free, id, geo}`, sans heure de relevé.
fn decode_rennes(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            let (lon, lat) = point(&r["geo"])?;
            let name = r["key"].as_str()?.replace('-', " ");
            let status = match r["status"].as_str().unwrap_or_default().to_uppercase().as_str() {
                "OUVERT" => Status::Ouvert,
                "COMPLET" => Status::Complet,
                _ => Status::Ferme,
            };
            finish(Parking {
                id: text(&r["id"]).unwrap_or_else(|| name.clone()),
                kind: kind_of(&name, None),
                name,
                lon,
                lat,
                capacity: count(&r["max"]),
                free: count(&r["free"])?,
                measured_at: None,
                status,
            })
        })
        .collect()
}

/// STAR, parcs relais : les places « soliste » sont les places ordinaires (les autres sont réservées : électriques, PMR, covoiturage).
fn decode_star(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            let (lon, lat) = point(&r["coordonnees"])?;
            let status = match (r["etatouverture"].as_str().unwrap_or_default().to_uppercase().as_str(), r["etatremplissage"].as_str().unwrap_or_default().to_uppercase().as_str()) {
                ("OUVERT", "COMPLET") => Status::Complet,
                ("OUVERT", _) => Status::Ouvert,
                _ => Status::Ferme,
            };
            finish(Parking {
                id: text(&r["idparc"])?,
                name: text(&r["nom"])?,
                lon,
                lat,
                capacity: count(&r["capacitesoliste"]),
                free: count(&r["jrdinfosoliste"])?,
                measured_at: instant(&r["lastupdate"]),
                kind: Kind::Relais,
                status,
            })
        })
        .collect()
}

/// Nantes (parkings publics et parcs relais) : le statut vaut 0 (compteur hors service), 1 (fermé), 2 (abonnés) ou 5 (ouvert) ;
/// le seuil « complet » est celui de l'exploitant, qui affiche « COMPLET » dès qu'il reste ce nombre de places ou moins.
fn decode_nantes(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            let (lon, lat) = point(&r["location"])?;
            let free = count(&r["grp_disponible"])?;
            let threshold = count(&r["grp_complet"]).unwrap_or(0);
            let status = match count(&r["grp_statut"])? {
                5 if free <= threshold => Status::Complet,
                5 => Status::Ouvert,
                1 => Status::Ferme,
                2 => Status::Abonnes,
                _ => return None,
            };
            let name = text(&r["grp_nom"])?;
            finish(Parking {
                id: text(&r["grp_identifiant"])?,
                kind: kind_of(&name, None),
                name,
                lon,
                lat,
                capacity: count(&r["grp_exploitation"]),
                free,
                measured_at: instant(&r["grp_horodatage"]),
                status,
            })
        })
        .collect()
}

/// Strasbourg : `etat` vaut 0 (comptage indisponible), 1 (ouvert), 2 (fermé) ou 3 (complet).
fn decode_strasbourg(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            let (lon, lat) = point(&r["position"])?;
            let status = match count(&r["etat"])? {
                1 => Status::Ouvert,
                2 => Status::Ferme,
                3 => Status::Complet,
                _ => return None,
            };
            let name = text(&r["nom_parking"])?;
            finish(Parking {
                id: text(&r["ident"])?,
                kind: kind_of(&name, None),
                name,
                lon,
                lat,
                capacity: count(&r["total"]),
                free: count(&r["libre"])?,
                measured_at: None,
                status,
            })
        })
        .collect()
}

/// Bordeaux : `etat` vaut LIBRE, COMPLET, ABONNES, FERME ou OUVERT ; la capacité du compteur est `total`, à défaut `np_total`.
fn decode_bordeaux(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            let (lon, lat) = point(&r["geo_point_2d"])?;
            let status = match r["etat"].as_str().unwrap_or_default().to_uppercase().as_str() {
                "LIBRE" | "OUVERT" => Status::Ouvert,
                "COMPLET" => Status::Complet,
                "ABONNES" => Status::Abonnes,
                _ => Status::Ferme,
            };
            let name = text(&r["nom"])?;
            finish(Parking {
                id: text(&r["ident"])?,
                kind: kind_of(&name, None),
                name,
                lon,
                lat,
                capacity: count(&r["total"]).filter(|c| *c > 0).or_else(|| count(&r["np_total"])),
                free: count(&r["libres"])?,
                measured_at: instant(&r["mdate"]),
                status,
            })
        })
        .collect()
}

/// Clermont-Ferrand : les compteurs en panne ont l'état « Invalide » et pas de places libres.
fn decode_clermont(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            if r["etat"].as_str() != Some("Valide") {
                return None;
            }
            let (lon, lat) = point(&r["point_geo"])?;
            let name = text(&r["nom"])?;
            finish(Parking {
                id: text(&r["identifiant"])?,
                kind: kind_of(&name, None),
                name,
                lon,
                lat,
                capacity: count(&r["capacite_maximale"]),
                free: count(&r["places_libres"])?,
                measured_at: instant(&r["horodatage"]),
                status: Status::Ouvert,
            })
        })
        .collect()
}

/// Tours (Indigo) : `status` vaut 0, ou -1 (connexion perdue) et -2 (valeur incohérente), qu'on écarte.
fn decode_tours(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            if number(&r["status"]) != Some(0.0) {
                return None;
            }
            let (lon, lat) = point(&r["geo_point"])?;
            let name = text(&r["libelle_parking"])?;
            finish(Parking {
                id: text(&r["key"])?,
                kind: kind_of(&name, None),
                name,
                lon,
                lat,
                capacity: count(&r["capacite"]),
                free: count(&r["free_spots"])?,
                measured_at: instant(&r["updated_at"]),
                status: Status::Ouvert,
            })
        })
        .collect()
}

/// Heure de Paris sans fuseau (« 2026-11-16 14:35:05 ») vers un instant.
fn paris_time(value: &Value) -> Option<i64> {
    let civil: jiff::civil::DateTime = value.as_str()?.replacen(' ', "T", 1).parse().ok()?;
    Some(civil.in_tz("Europe/Paris").ok()?.timestamp().as_second())
}

/// Aix-Marseille : seuls les parkings dont `tempsreel` est vrai ont des places libres mesurées (les autres affichent la capacité).
fn decode_amp(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            if !r["tempsreel"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("true")) {
                return None;
            }
            let (lon, lat) = point(&r["pointgeo"])?;
            let name = text(&r["nom"])?;
            let commune = text(&r["commune"]).unwrap_or_default();
            let free = count(&r["voitureplacesdisponibles"])?;
            let mut parking = Parking {
                id: format!("{commune}|{name}"),
                kind: kind_of(&name, text(&r["typeparking"]).as_deref()),
                name,
                lon,
                lat,
                capacity: count(&r["voitureplacescapacite"]),
                free,
                measured_at: paris_time(&r["datemajpy"]),
                status: Status::Ouvert,
            };
            // Un même nom existe dans plusieurs communes (« Gambetta » à Marseille et à Aix) : la commune le précise, sauf à Marseille.
            if !commune.is_empty() && !commune.eq_ignore_ascii_case("MARSEILLE") {
                parking.name = format!("{} ({})", parking.name, tidy_name(&commune));
            }
            finish(parking)
        })
        .collect()
}

/// Orléans : `places_disponibles_temps_reel` vaut « oui » ou « non » ; les valeurs sont des textes.
fn decode_orleans(records: &[Value]) -> Vec<Parking> {
    records
        .iter()
        .filter_map(|r| {
            if !r["places_disponibles_temps_reel"].as_str().is_some_and(|t| t.eq_ignore_ascii_case("oui")) {
                return None;
            }
            let lon = number(&r["xlong"])?;
            let lat = number(&r["ylat"])?;
            let name = text(&r["nom"])?;
            let status = match r["etat_equipement"].as_str().unwrap_or_default() {
                "en service" => Status::Ouvert,
                _ => Status::Ferme,
            };
            finish(Parking {
                id: name.clone(),
                kind: kind_of(&name, text(&r["type_parking"]).as_deref()),
                name,
                lon,
                lat,
                capacity: count(&r["nb_places"]),
                free: count(&r["nb_places_disponibles"])?,
                measured_at: instant(&r["horodatage_maj_places_disponibles"]),
                status,
            })
        })
        .collect()
}

/// Un site de Grenoble (description fixe).
#[derive(Clone, Debug, PartialEq)]
struct GrenobleSite {
    id: String,
    name: String,
    lon: f64,
    lat: f64,
    capacity: Option<u32>,
    relais: bool,
}

/// Mobilités M, sites : GeoJSON des parkings (`nb_places`, `nb_pr` places de parc relais).
fn decode_grenoble_sites(collection: &Value) -> Vec<GrenobleSite> {
    collection["features"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let p = &f["properties"];
            let coordinates = f["geometry"]["coordinates"].as_array()?;
            Some(GrenobleSite {
                id: text(&p["id"])?,
                name: text(&p["nom"])?,
                lon: number(coordinates.first()?)?,
                lat: number(coordinates.get(1)?)?,
                capacity: count(&p["nb_places"]),
                relais: count(&p["nb_pr"]).unwrap_or(0) > 0,
            })
        })
        .collect()
}

/// Mobilités M, places libres : `{identifiant: {time (ms), nb_places_libres (nul si pas de compteur)}}`.
fn decode_grenoble(sites: &[GrenobleSite], free: &Value) -> Vec<Parking> {
    sites
        .iter()
        .filter_map(|site| {
            let entry = &free[site.id.as_str()];
            let free = count(&entry["nb_places_libres"])?;
            finish(Parking {
                id: site.id.clone(),
                name: site.name.clone(),
                lon: site.lon,
                lat: site.lat,
                capacity: site.capacity,
                free,
                measured_at: number(&entry["time"]).map(|ms| (ms / 1000.0) as i64),
                kind: if site.relais { Kind::Relais } else { Kind::Parking },
                status: Status::Ouvert,
            })
        })
        .collect()
}

// --- Relevé réseau ---

/// Les réponses de certains portails arrivent compressées en gzip même sans l'avoir demandé.
fn body_text(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        GzDecoder::new(bytes).read_to_end(&mut out)?;
        Ok(out)
    } else {
        Ok(bytes.to_vec())
    }
}

async fn get_json(http: &reqwest::Client, url: &str) -> Result<Value> {
    let response = http.get(url).timeout(Duration::from_secs(30)).send().await?.error_for_status()?;
    let bytes = response.bytes().await?;
    Ok(serde_json::from_slice(&body_text(&bytes)?)?)
}

/// Toutes les lignes d'un jeu Opendatasoft, page par page (100 lignes au plus par page).
async fn ods_records(http: &reqwest::Client, host: &str, dataset: &str, select: &str, filter: Option<&str>) -> Result<Vec<Value>> {
    let mut records = Vec::new();
    for page in 0..10 {
        let mut url = format!("https://{host}/api/explore/v2.1/catalog/datasets/{dataset}/records?limit={PAGE}&offset={}&select={select}", page * PAGE);
        if let Some(filter) = filter {
            url.push_str("&where=");
            url.push_str(filter);
        }
        let body = get_json(http, &url).await?;
        let results = body["results"].as_array().context("réponse Opendatasoft inattendue")?;
        records.extend(results.iter().cloned());
        let total = body["total_count"].as_u64().unwrap_or(0) as usize;
        if results.len() < PAGE || records.len() >= total {
            return Ok(records);
        }
    }
    bail!("trop de pages")
}

/// Heure du dernier traitement du jeu par le portail (les jeux sans heure de relevé par ligne : les compteurs sont recopiés chaque minute).
async fn ods_processed_at(http: &reqwest::Client, host: &str, dataset: &str) -> Option<i64> {
    let meta = get_json(http, &format!("https://{host}/api/explore/v2.1/catalog/datasets/{dataset}")).await.ok()?;
    instant(&meta["metas"]["default"]["data_processed"])
}

/// Les sites de Grenoble (une cinquantaine de lignes) et leur âge : rechargés quelques fois par jour seulement.
static GRENOBLE_SITES: Mutex<Option<(Instant, Vec<GrenobleSite>)>> = Mutex::new(None);

async fn fetch(http: &reqwest::Client, source: &Source) -> Result<Vec<Parking>> {
    match &source.fetch {
        Fetch::Ods { host, dataset, select, filter, decode, stamped_by_dataset } => {
            let records = ods_records(http, host, dataset, select, *filter).await?;
            let mut parkings = decode(&records);
            if *stamped_by_dataset {
                let at = ods_processed_at(http, host, dataset).await;
                for parking in &mut parkings {
                    parking.measured_at = at;
                }
            }
            Ok(parkings)
        }
        Fetch::Grenoble => {
            let outdated = GRENOBLE_SITES.lock().expect("verrou des sites de Grenoble").as_ref().is_none_or(|(at, _)| at.elapsed() > GRENOBLE_SITES_EVERY);
            if outdated {
                let sites = decode_grenoble_sites(&get_json(http, "https://data.mobilites-m.fr/api/findType/json?types=parking").await?);
                if !sites.is_empty() {
                    *GRENOBLE_SITES.lock().expect("verrou des sites de Grenoble") = Some((Instant::now(), sites));
                }
            }
            let free = get_json(http, "https://data.mobilites-m.fr/api/dyn/parking/json").await?;
            let sites = GRENOBLE_SITES.lock().expect("verrou des sites de Grenoble").as_ref().map(|(_, sites)| sites.clone()).unwrap_or_default();
            Ok(decode_grenoble(&sites, &free))
        }
    }
}

// --- Réponse de l'API et historique ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceOut<'a> {
    area: &'a str,
    name: &'a str,
    licence: &'a str,
    link: &'a str,
    /// Instant du dernier relevé réussi de la source.
    updated_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParkingOut<'a> {
    /// Identifiant stable (source et identifiant dans la source), pour l'historique.
    id: String,
    source: usize,
    name: &'a str,
    lon: f64,
    lat: f64,
    capacity: Option<u32>,
    free: u32,
    measured_at: Option<i64>,
    kind: Kind,
    status: Status,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParkingsOut<'a> {
    updated_at: i64,
    sources: Vec<SourceOut<'a>>,
    parkings: Vec<ParkingOut<'a>>,
}

/// L'état d'une source : sa dernière liste et la date du dernier relevé réussi.
#[derive(Default)]
struct SourceState {
    parkings: Vec<Parking>,
    ok_at: Option<Instant>,
    ok_unix: Option<i64>,
    next_at: Option<Instant>,
}

static BODY: RwLock<Option<Bytes>> = RwLock::new(None);
/// Places libres des dernières 24 heures : (instant en secondes, places libres), par parking.
static HISTORY: Mutex<Option<HashMap<String, VecDeque<(u32, u16)>>>> = Mutex::new(None);

fn build_body(states: &[SourceState], now: Timestamp) -> Result<Vec<u8>> {
    let mut sources = Vec::new();
    let mut parkings = Vec::new();
    for (index, (source, state)) in SOURCES.iter().zip(states).enumerate() {
        let alive = state.ok_at.is_some_and(|at| at.elapsed() < DROP_AFTER);
        sources.push(SourceOut { area: source.area, name: source.name, licence: source.licence, link: source.link, updated_at: if alive { state.ok_unix } else { None } });
        if !alive {
            continue;
        }
        for p in &state.parkings {
            parkings.push(ParkingOut {
                id: format!("{index}:{}", p.id),
                source: index,
                name: &p.name,
                lon: (p.lon * 1e5).round() / 1e5,
                lat: (p.lat * 1e5).round() / 1e5,
                capacity: p.capacity,
                free: p.free,
                measured_at: p.measured_at,
                kind: p.kind,
                status: p.status,
            });
        }
    }
    Ok(serde_json::to_vec(&ParkingsOut { updated_at: now.as_second(), sources, parkings })?)
}

/// Ajoute les places libres du moment à l'historique et oublie ce qui a plus de 24 heures.
fn record_history(index: usize, parkings: &[Parking], now: i64) {
    let mut guard = HISTORY.lock().expect("verrou de l'historique des parkings");
    let history = guard.get_or_insert_with(HashMap::new);
    for p in parkings {
        // Un compteur figé depuis plus d'une demi-heure ne dit rien du présent.
        if p.measured_at.is_some_and(|at| now - at > 1800) || matches!(p.status, Status::Ferme | Status::Abonnes) {
            continue;
        }
        let series = history.entry(format!("{index}:{}", p.id)).or_default();
        // Un seul relevé par tranche de 4 minutes, même si l'exploitant n'a pas mis à jour.
        if series.back().is_some_and(|(t, _)| now - (*t as i64) < 240) {
            continue;
        }
        series.push_back((now as u32, p.free.min(u16::MAX as u32) as u16));
        while series.front().is_some_and(|(t, _)| now - (*t as i64) > HISTORY_S) {
            series.pop_front();
        }
    }
    // Les parkings disparus de la source sortent de l'historique une fois leurs relevés périmés.
    history.retain(|_, series| series.back().is_some_and(|(t, _)| now - (*t as i64) <= HISTORY_S));
}

/// Relève chaque source à son tour (5 minutes), reconstruit la réponse de l'API et garde l'historique.
pub async fn poll_forever(http: reqwest::Client) {
    let mut states: Vec<SourceState> = SOURCES.iter().map(|_| SourceState::default()).collect();
    loop {
        let due: Vec<usize> = (0..SOURCES.len()).filter(|i| states[*i].next_at.is_none_or(|at| Instant::now() >= at)).collect();
        if !due.is_empty() {
            let mut tasks = JoinSet::new();
            for index in due {
                let http = http.clone();
                tasks.spawn(async move { (index, fetch(&http, &SOURCES[index]).await) });
            }
            while let Some(joined) = tasks.join_next().await {
                let Ok((index, result)) = joined else { continue };
                let state = &mut states[index];
                state.next_at = Some(Instant::now() + EVERY);
                match result {
                    Ok(parkings) => {
                        let now = Timestamp::now().as_second();
                        info!(source = SOURCES[index].area, parkings = parkings.len(), "parkings : source relevée");
                        record_history(index, &parkings, now);
                        state.parkings = parkings;
                        state.ok_at = Some(Instant::now());
                        state.ok_unix = Some(now);
                    }
                    Err(error) => warn!(source = SOURCES[index].name, "parkings : source indisponible : {error:#}"),
                }
            }
            match build_body(&states, Timestamp::now()) {
                Ok(body) => *BODY.write().expect("verrou des parkings") = Some(Bytes::from(body)),
                Err(error) => warn!("parkings : réponse non construite : {error:#}"),
            }
        }
        tokio::time::sleep(TICK).await;
    }
}

/// La réponse de `/api/parkings`.
pub fn response() -> Response {
    let body = BODY.read().expect("verrou des parkings").clone();
    match body {
        Some(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "parkings : première collecte en cours").into_response(),
    }
}

#[derive(Deserialize)]
pub struct CurveQuery {
    id: String,
}

#[derive(Serialize)]
struct CurveOut<'a> {
    id: &'a str,
    /// Paires [instant, places libres], de la plus ancienne à la plus récente.
    points: Vec<(u32, u16)>,
}

/// La réponse de `/api/parkings/courbe?id=…` : les places libres des dernières 24 heures (depuis le démarrage du serveur).
pub async fn curve(Query(query): Query<CurveQuery>) -> Response {
    let points = HISTORY
        .lock()
        .expect("verrou de l'historique des parkings")
        .as_ref()
        .and_then(|history| history.get(&query.id))
        .map(|series| series.iter().copied().collect::<Vec<_>>())
        .unwrap_or_default();
    match serde_json::to_vec(&CurveOut { id: &query.id, points }) {
        Ok(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(file: &str) -> Vec<Value> {
        let body: Value = serde_json::from_str(file).expect("extrait JSON");
        body["results"].as_array().expect("results").clone()
    }

    #[test]
    fn rennes_citedia() {
        let parkings = decode_rennes(&records(include_str!("testdata/parkings_rennes.json")));
        assert!(parkings.len() >= 2);
        let first = &parkings[0];
        assert_eq!(first.status, Status::Ouvert);
        assert!(first.capacity.is_some_and(|c| c > first.free));
        assert!((-2.0..-1.0).contains(&first.lon) && (48.0..48.3).contains(&first.lat));
        assert!(parkings.iter().any(|p| p.name == "Gare Sud"), "les tirets des noms deviennent des espaces");
    }

    #[test]
    fn rennes_star_parcs_relais() {
        let parkings = decode_star(&records(include_str!("testdata/parkings_star.json")));
        assert!(!parkings.is_empty());
        assert!(parkings.iter().all(|p| p.kind == Kind::Relais && p.measured_at.is_some()));
        assert_eq!(parkings[0].capacity, Some(757));
        assert_eq!(parkings[0].free, 215);
    }

    #[test]
    fn nantes_seuil_complet_et_statuts() {
        let parkings = decode_nantes(&records(include_str!("testdata/parkings_nantes.json")));
        let find = |name: &str| parkings.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("{name} absent"));
        // Casse corrigée, seuil de l'exploitant (« COMPLET » à 10 places ou moins) appliqué.
        assert_eq!(find("Feydeau").status, Status::Ouvert);
        assert_eq!((find("Decre - Bouffay").free, find("Decre - Bouffay").capacity), (184, Some(394)));
        assert_eq!(find("Chu 2").status, Status::Ouvert);
        assert_eq!(find("Baco 2").status, Status::Abonnes);
        assert_eq!(find("P+R Recteur Schmitt").status, Status::Ferme);
        assert_eq!(find("P+R Recteur Schmitt").kind, Kind::Relais);
        assert!(parkings.iter().all(|p| p.name != "Les Nefs"), "comptage hors service écarté");
    }

    #[test]
    fn strasbourg_etats() {
        let parkings = decode_strasbourg(&records(include_str!("testdata/parkings_strasbourg.json")));
        assert!(parkings.iter().any(|p| p.name == "Parking Zénith" && p.status == Status::Ferme));
        assert!(parkings.iter().all(|p| p.name != "Parking Kleber Homme de fer"), "comptage indisponible écarté");
        let wodli = parkings.iter().find(|p| p.name == "Parking Gare Wodli").expect("Wodli");
        assert_eq!(wodli.capacity, Some(955));
        assert!(wodli.free > 0 && wodli.free < 955);
    }

    #[test]
    fn bordeaux_etats() {
        let parkings = decode_bordeaux(&records(include_str!("testdata/parkings_bordeaux.json")));
        let brandenburg = parkings.iter().find(|p| p.name == "Parc Relais Brandenburg").expect("Brandenburg");
        assert_eq!((brandenburg.status, brandenburg.free, brandenburg.kind), (Status::Complet, 0, Kind::Relais));
        assert!(brandenburg.measured_at.is_some());
        assert!(parkings.iter().any(|p| p.name == "Parc Relais Hippodrome" && p.free == 60 && p.capacity == Some(250)));
        // Les doubles espaces de la source sont résorbés.
        assert!(parkings.iter().all(|p| !p.name.contains("  ")));
    }

    #[test]
    fn clermont_ecarte_les_compteurs_invalides() {
        let parkings = decode_clermont(&records(include_str!("testdata/parkings_clermont.json")));
        assert!(parkings.iter().any(|p| p.name == "Gambetta (Surface)" && p.free == 57 && p.capacity == Some(265)));
        assert!(parkings.iter().all(|p| !p.name.starts_with("Henri Dunant")));
    }

    #[test]
    fn tours_ecarte_les_erreurs_de_connexion() {
        let parkings = decode_tours(&records(include_str!("testdata/parkings_tours.json")));
        assert!(parkings.iter().any(|p| p.name == "Parc Halles Vieux Tours" && p.free == 494));
        assert!(parkings.iter().all(|p| p.name != "Parc Heure Tranquille"), "status -1 écarté");
    }

    #[test]
    fn aix_marseille_temps_reel_seulement() {
        let parkings = decode_amp(&records(include_str!("testdata/parkings_amp.json")));
        assert!(!parkings.is_empty());
        assert!(parkings.iter().any(|p| p.name == "Cours Julien" && p.free == 209 && p.capacity == Some(250)));
        // Saint-Jérôme est un parc relais ; « Hauts de Brunet » n'a pas de temps réel.
        assert!(parkings.iter().any(|p| p.name == "Saint-Jérôme" && p.kind == Kind::Relais));
        assert!(parkings.iter().all(|p| !p.name.starts_with("Hauts de Brunet")));
        // 14:45:05 à Paris en novembre (UTC+1) : 13:45:05 UTC.
        let cours = parkings.iter().find(|p| p.name == "Cours Julien").expect("Cours Julien");
        assert_eq!(cours.measured_at, Some("2026-11-16T13:45:05Z".parse::<Timestamp>().expect("date").as_second()));
    }

    #[test]
    fn orleans_temps_reel_seulement() {
        let parkings = decode_orleans(&records(include_str!("testdata/parkings_orleans.json")));
        assert!(parkings.iter().any(|p| p.name == "Cathédrale" && p.free == 179 && p.capacity == Some(343) && p.kind == Kind::Parking));
        assert!(parkings.iter().any(|p| p.name == "Zénith" && p.kind == Kind::Relais));
        assert!(parkings.iter().all(|p| p.name != "La Jonchère"), "sans temps réel");
        assert!(parkings.iter().any(|p| p.status == Status::Ferme), "fermé pour travaux");
    }

    #[test]
    fn grenoble_sites_et_places_libres() {
        let sites = decode_grenoble_sites(&serde_json::from_str(include_str!("testdata/parkings_grenoble_sites.json")).expect("sites"));
        assert!(sites.len() >= 3);
        let free: Value = serde_json::from_str(include_str!("testdata/parkings_grenoble_dyn.json")).expect("places libres");
        let parkings = decode_grenoble(&sites, &free);
        // Les sites sans compteur (valeur nulle) n'apparaissent pas.
        assert!(!parkings.is_empty() && parkings.len() < sites.len());
        let echirolles = parkings.iter().find(|p| p.id == "38151-P-001").expect("Échirolles");
        assert_eq!((echirolles.free, echirolles.capacity, echirolles.kind), (68, Some(100), Kind::Relais));
        assert_eq!(echirolles.measured_at, Some(1_794_836_820));
        assert_eq!(echirolles.name, "Echirolles - Gare");
        assert!(echirolles.measured_at.is_some_and(|t| t > 1_700_000_000));
    }

    #[test]
    fn casse_des_noms() {
        assert_eq!(tidy_name("CITE INT DES CONGRES"), "Cite Int des Congres");
        assert_eq!(tidy_name("GARE SUD-LIMITE 1H"), "Gare Sud-Limite 1h");
        assert_eq!(tidy_name("Parc Relais  Hippodrome"), "Parc Relais Hippodrome");
        assert_eq!(tidy_name("P+R Neustrie 1"), "P+R Neustrie 1");
        assert_eq!(tidy_name("L'AIRE"), "L'Aire");
    }

    #[test]
    fn complet_et_incoherences() {
        let base = Parking { id: "1".into(), name: "Test".into(), lon: 2.0, lat: 48.0, capacity: Some(100), free: 0, measured_at: None, kind: Kind::Parking, status: Status::Ouvert };
        assert_eq!(finish(base.clone()).expect("parking").status, Status::Complet);
        assert_eq!(finish(Parking { free: 150, ..base.clone() }).expect("parking").capacity, None);
        assert!(finish(Parking { lon: 40.0, ..base }).is_none());
    }

    #[test]
    fn gzip_reconnu() {
        use flate2::{Compression, write::GzEncoder};
        use std::io::Write;
        let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
        gz.write_all(b"{\"a\":1}").expect("écriture");
        assert_eq!(body_text(&gz.finish().expect("fin")).expect("décodé"), b"{\"a\":1}");
        assert_eq!(body_text(b"{}").expect("tel quel"), b"{}");
    }

    #[test]
    fn historique_borne_et_espace() {
        let parking = Parking { id: "h1".into(), name: "H".into(), lon: 2.0, lat: 48.0, capacity: Some(10), free: 4, measured_at: None, kind: Kind::Parking, status: Status::Ouvert };
        let start = 1_800_000_000;
        for step in 0..320 {
            record_history(99, std::slice::from_ref(&parking), start + step * 300);
        }
        // Deux relevés trop rapprochés n'en font qu'un.
        record_history(99, std::slice::from_ref(&parking), start + 319 * 300 + 10);
        let guard = HISTORY.lock().expect("verrou");
        let series = &guard.as_ref().expect("historique")["99:h1"];
        assert_eq!(series.len(), 289, "24 h à 5 min, bornes comprises");
        assert!(series.back().expect("dernier").0 as i64 - series.front().expect("premier").0 as i64 <= HISTORY_S);
    }

    /// Mesure réelle : relève toutes les sources, affiche le nombre de parkings de chacune et écrit la réponse de l'API
    /// dans le fichier de `PARKINGS_SORTIE` s'il est défini. Demande le réseau :
    /// `PARKINGS_SORTIE=/tmp/parkings.json cargo test parkings_en_direct -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "interroge les portails des villes"]
    async fn parkings_en_direct() {
        let http = reqwest::Client::builder().user_agent(concat!("carte-vivante/", env!("CARGO_PKG_VERSION"))).build().expect("client");
        let mut states: Vec<SourceState> = SOURCES.iter().map(|_| SourceState::default()).collect();
        for (index, source) in SOURCES.iter().enumerate() {
            match fetch(&http, source).await {
                Ok(parkings) => {
                    println!("{:<18} {:>3} parkings, dont {} complets : {}", source.area, parkings.len(), parkings.iter().filter(|p| p.status == Status::Complet).count(), source.name);
                    states[index] = SourceState { parkings, ok_at: Some(Instant::now()), ok_unix: Some(Timestamp::now().as_second()), next_at: None };
                }
                Err(error) => println!("{:<18} ERREUR {error:#}", source.area),
            }
        }
        let body = build_body(&states, Timestamp::now()).expect("réponse");
        println!("réponse : {} octets", body.len());
        if let Ok(path) = std::env::var("PARKINGS_SORTIE") {
            std::fs::write(path, body).expect("écriture");
        }
    }
}
