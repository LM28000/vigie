//! Pollens : l'indice pollen de chaque commune de métropole, pour aujourd'hui et les deux jours
//! suivants, avec un sous-indice par taxon (aulne, bouleau, olivier, graminées, armoise, ambroisie).
//!
//! Source : Atmo Data (`admindata.atmo-france.org`), flux 122 « Indice pollen » : l'indice officiel
//! de la Fédération Atmo France, prévu chaque jour par les associations agréées de surveillance de la
//! qualité de l'air (AASQA) pour toutes les communes. Données ouvertes ; mention « Atmo France / AASQA ».
//! Même compte que la qualité de l'air (`ATMO_USERNAME`, `ATMO_PASSWORD`), même jeton (voir `air.rs`).
//!
//! Ce que le flux a de particulier, vérifié sur des réponses réelles :
//! - il n'a AUCUNE géométrie (le champ vaut `null`) : les communes sont placées d'après le centre de
//!   la commune (`data/communes_centres.tsv`, tiré de geo.api.gouv.fr, Licence Ouverte), par code INSEE ;
//! - il pèse 22 Mo par jour d'échéance (35 000 communes) : on le relève un jour et une association à la fois (2 à 4 Mo), et seulement
//!   quand le catalogue (`/api/feeds`, 7 Ko) dit qu'il a été mis à jour ou que le jour a changé ;
//! - hors saison, tout vaut « très faible » (niveau 1) avec des concentrations nulles : on garde cette
//!   différence (`o` plus bas), pour dire « aucun pollen » plutôt que « niveau très faible » ;
//! - l'historique annoncé (« 1 an glissant ») n'existe pas : seuls aujourd'hui, demain et après-demain.
//!
//! La réponse est en colonnes, une chaîne de 7 caractères par commune et par jour : indice global puis
//! un sous-indice par taxon, dans l'ordre de `TAXA`. Un caractère est :
//! - `1` à `6` : très faible, faible, modéré, élevé, très élevé, extrêmement élevé (échelle officielle) ;
//! - `o` : niveau 1 avec une concentration nulle (aucun pollen de ce taxon) ;
//! - `-` : non évalué (indisponible, ou jour non publié).

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::air::{BASE_URL, Collector, encode_segment};
use crate::state::AppState;

const FEED_LAYER: u32 = 122;
/// Aujourd'hui, demain et après-demain.
const MAX_DAYS: usize = 3;
/// Le catalogue ne pèse que quelques Ko : on le consulte souvent, le flux (22 Mo par jour) rarement.
const CHECK_EVERY: Duration = Duration::from_secs(30 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// Sans réponse du catalogue, on ne relève pas le flux plus d'une fois par ce délai (si le jour n'a pas changé).
const BLIND_REFRESH: Duration = Duration::from_secs(6 * 3600);
/// Centres des communes de métropole et de Corse : « code \t longitude \t latitude », trié par code.
const CENTRES: &str = include_str!("data/communes_centres.tsv");
/// Caractères d'une commune pour un jour : l'indice global et un sous-indice par taxon.
const WIDTH: usize = 7;

// --- Ce que l'API Atmo renvoie (ce dont on se sert) --------------------------------------------

#[derive(Deserialize)]
struct Collection<T> {
    features: Vec<Feature<T>>,
}

#[derive(Deserialize)]
struct Feature<T> {
    properties: T,
}

#[derive(Deserialize)]
struct Row {
    code_zone: Option<String>,
    lib_zone: Option<String>,
    source: Option<String>,
    date_maj: Option<String>,
    code_qual: Option<f64>,
    code_aul: Option<f64>,
    code_boul: Option<f64>,
    code_oliv: Option<f64>,
    code_gram: Option<f64>,
    code_arm: Option<f64>,
    code_ambr: Option<f64>,
    conc_aul: Option<f64>,
    conc_boul: Option<f64>,
    conc_oliv: Option<f64>,
    conc_gram: Option<f64>,
    conc_arm: Option<f64>,
    conc_ambr: Option<f64>,
}

#[derive(Deserialize)]
struct FeedInfo {
    layers: Vec<FeedLayer>,
    last_update: Option<FeedUpdate>,
}

#[derive(Deserialize)]
struct FeedLayer {
    id: u32,
}

#[derive(Deserialize)]
struct FeedUpdate {
    date: String,
}

// --- Ce que sert l'API ---------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Default)]
struct Zones {
    /// Code INSEE de la commune (son département : les deux premiers caractères).
    code: Vec<String>,
    name: Vec<String>,
    lon: Vec<f64>,
    lat: Vec<f64>,
    /// Indice de l'association dans `sources`.
    src: Vec<u16>,
    /// 7 caractères par jour de `days` : indice global, aulne, bouleau, olivier, graminées, armoise, ambroisie.
    v: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Out {
    /// Instant de la collecte (secondes UTC).
    updated_at: i64,
    /// Heure de publication la plus récente (secondes UTC), si elle est connue.
    #[serde(skip_serializing_if = "Option::is_none")]
    issued_at: Option<i64>,
    /// Jours couverts, « AAAA-MM-JJ » (heure de Paris), du plus ancien au plus récent.
    days: Vec<String>,
    sources: Vec<String>,
    zones: Zones,
}

// --- Mise en forme -----------------------------------------------------------------------------

/// Un caractère de niveau : voir l'en-tête du module.
fn level_char(code: Option<f64>, conc: Option<f64>) -> char {
    match code {
        Some(c) if (2.0..=6.0).contains(&c) => char::from(b'0' + c as u8),
        Some(c) if c == 1.0 => {
            if conc == Some(0.0) {
                'o'
            } else {
                '1'
            }
        }
        _ => '-',
    }
}

/// Les 7 caractères d'une ligne. L'indice global est « aucun pollen » quand aucun taxon n'en a.
fn row_chars(row: &Row) -> String {
    let taxa = [
        level_char(row.code_aul, row.conc_aul),
        level_char(row.code_boul, row.conc_boul),
        level_char(row.code_oliv, row.conc_oliv),
        level_char(row.code_gram, row.conc_gram),
        level_char(row.code_arm, row.conc_arm),
        level_char(row.code_ambr, row.conc_ambr),
    ];
    let global = match row.code_qual {
        Some(c) if c == 1.0 && taxa.iter().all(|t| *t == 'o') => 'o',
        other => level_char(other, None),
    };
    std::iter::once(global).chain(taxa).collect()
}

/// Centres des communes : (code, longitude, latitude), triés par code.
fn centres() -> Vec<(&'static str, f64, f64)> {
    CENTRES
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|line| {
            let mut parts = line.split('\t');
            Some((parts.next()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .collect()
}

/// Construit la réponse jour après jour : on ne garde jamais plus d'un jour de lignes brutes en mémoire.
struct Builder {
    centres: Vec<(&'static str, f64, f64)>,
    /// Pour chaque centre, la position de la commune dans `zones` (`u32::MAX` : pas encore vue).
    slot: Vec<u32>,
    sources: Vec<String>,
    zones: Zones,
    days: Vec<String>,
    issued_at: Option<i64>,
}

impl Builder {
    fn new() -> Self {
        let centres = centres();
        Builder { slot: vec![u32::MAX; centres.len()], centres, sources: Vec::new(), zones: Zones::default(), days: Vec::new(), issued_at: None }
    }

    /// Ajoute des lignes du prochain jour d'échéance (à valider par `commit_day`). Les communes sans centre
    /// connu (anciens codes de communes fusionnées) sont écartées.
    fn add_rows(&mut self, rows: Vec<Row>) {
        let index = self.days.len();
        for row in &rows {
            let Some(code) = row.code_zone.as_deref() else { continue };
            let Ok(centre) = self.centres.binary_search_by(|c| c.0.cmp(code)) else { continue };
            let slot = match self.slot[centre] {
                u32::MAX => {
                    let source = row.source.clone().unwrap_or_default().trim().to_string();
                    let src = match self.sources.iter().position(|s| *s == source) {
                        Some(i) => i,
                        None => {
                            self.sources.push(source);
                            self.sources.len() - 1
                        }
                    };
                    let (_, lon, lat) = self.centres[centre];
                    self.zones.code.push(code.to_string());
                    self.zones.name.push(row.lib_zone.clone().unwrap_or_default());
                    self.zones.lon.push(lon);
                    self.zones.lat.push(lat);
                    self.zones.src.push(src as u16);
                    self.zones.v.push("-".repeat(WIDTH * MAX_DAYS));
                    self.slot[centre] = (self.zones.v.len() - 1) as u32;
                    self.slot[centre]
                }
                known => known,
            } as usize;
            self.zones.v[slot].replace_range(index * WIDTH..(index + 1) * WIDTH, &row_chars(row));
            if let Some(at) = row.date_maj.as_deref().and_then(|t| t.parse::<Timestamp>().ok()) {
                self.issued_at = self.issued_at.max(Some(at.as_second()));
            }
        }
    }

    /// Le jour dont on vient d'ajouter les lignes est publié : il entre dans la réponse.
    fn commit_day(&mut self, day: &str) {
        self.days.push(day.to_string());
    }

    fn finish(mut self, now: i64) -> Out {
        for v in &mut self.zones.v {
            v.truncate(WIDTH * self.days.len());
        }
        Out { updated_at: now, issued_at: self.issued_at, days: self.days, sources: self.sources, zones: self.zones }
    }
}

/// Lignes d'un corps de réponse du flux.
fn parse_rows(body: &[u8]) -> Result<Vec<Row>> {
    let collection: Collection<Row> = serde_json::from_slice(body).context("indice pollen illisible")?;
    Ok(collection.features.into_iter().map(|f| f.properties).collect())
}

/// Reconstruit la réponse d'après les corps du flux, un par jour d'échéance (pour les tests).
#[cfg(test)]
fn build(days: &[(&str, &[u8])], now: i64) -> Result<Out> {
    let mut builder = Builder::new();
    for (day, body) in days {
        builder.add_rows(parse_rows(body)?);
        builder.commit_day(day);
    }
    Ok(builder.finish(now))
}

// --- Collecte ----------------------------------------------------------------------------------

/// Codes des associations (champ `aasqa`) par lot de requête : un jour pèse 22 Mo en une fois, 2 à 4 Mo par lot.
/// Les lots sont de taille voisine (5 000 à 7 000 communes) ; une dernière requête, « tout sauf ces codes »,
/// rattrape une association qui apparaîtrait un jour (elle ne ramène rien aujourd'hui).
const BATCHES: &[&[&str]] = &[&["44"], &["75", "11"], &["32", "24"], &["84", "93", "94"], &["27", "28"], &["76", "52", "53"]];

/// Adresse du flux pour un jour d'échéance et un lot d'associations (`None` : toutes les autres).
fn day_url(day: Date, batch: Option<&[&str]>) -> String {
    let known: Vec<&str> = BATCHES.iter().flat_map(|b| b.iter().copied()).collect();
    let aasqa = match batch {
        Some(codes) => serde_json::json!({ "operator": "IN", "value": codes }),
        None => serde_json::json!({ "operator": "NOT IN", "value": known }),
    };
    let filter = serde_json::json!({ "date_ech": { "operator": "=", "value": day.to_string() }, "aasqa": aasqa });
    format!("{BASE_URL}/api/data/{FEED_LAYER}/{}", encode_segment(&filter.to_string()))
}

/// Date de dernière mise à jour du flux, d'après le catalogue ; `None` s'il ne le dit pas.
async fn feed_stamp(collector: &mut Collector) -> Result<Option<String>> {
    let body = collector.get(&format!("{BASE_URL}/api/feeds")).await?;
    let feeds: Vec<FeedInfo> = serde_json::from_slice(&body).context("catalogue Atmo Data illisible")?;
    Ok(feeds.into_iter().find(|f| f.layers.iter().any(|l| l.id == FEED_LAYER)).and_then(|f| f.last_update).map(|u| u.date))
}

async fn collect(collector: &mut Collector) -> Result<Vec<u8>> {
    let today = Timestamp::now().to_zoned(TimeZone::get("Europe/Paris")?).date();
    let mut builder = Builder::new();
    for offset in 0..MAX_DAYS as i64 {
        let day = today.checked_add(jiff::Span::new().days(offset))?;
        let mut published = false;
        // Un lot à la fois : jamais plus de quelques Mo de réponse brute en mémoire.
        for batch in BATCHES.iter().map(|b| Some(*b)).chain([None]) {
            let rows = parse_rows(&collector.get(&day_url(day, batch)).await?)?;
            published |= !rows.is_empty();
            builder.add_rows(rows);
        }
        // Un jour pas encore publié : les suivants ne le sont pas non plus.
        if !published {
            break;
        }
        builder.commit_day(&day.to_string());
    }
    let out = builder.finish(Timestamp::now().as_second());
    if out.zones.name.is_empty() {
        bail!("aucune commune dans l'indice pollen");
    }
    Ok(serde_json::to_vec(&out)?)
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let (Some(username), Some(password)) = (var("ATMO_USERNAME"), var("ATMO_PASSWORD")) else {
        info!("pollens : pas d'identifiants ATMO_USERNAME/ATMO_PASSWORD, couche désactivée");
        state.set_pollen_disabled("pas d'identifiants Atmo Data configurés sur le serveur");
        return;
    };
    let mut collector = Collector::new(http, username, password);
    // Dernier relevé réussi : date de mise à jour du flux, jour de Paris, et instant.
    let mut last: Option<(Option<String>, Date, Instant)> = None;
    loop {
        let today = Timestamp::now().to_zoned(TimeZone::get("Europe/Paris").expect("fuseau de Paris")).date();
        let stamp = feed_stamp(&mut collector).await.unwrap_or_else(|error| {
            warn!("pollens : catalogue indisponible : {error:#}");
            None
        });
        let fresh = last.as_ref().is_some_and(|(seen, day, at)| match &stamp {
            Some(_) => *day == today && *seen == stamp,
            None => *day == today && at.elapsed() < BLIND_REFRESH,
        });
        let wait = if fresh {
            CHECK_EVERY
        } else {
            match collect(&mut collector).await {
                Ok(body) => {
                    info!(octets = body.len(), "pollens : indice mis à jour");
                    state.set_pollen(body);
                    last = Some((stamp, today, Instant::now()));
                    CHECK_EVERY
                }
                Err(error) => {
                    warn!("pollens : données indisponibles : {error:#}");
                    RETRY_AFTER
                }
            }
        };
        tokio::time::sleep(wait).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lignes réelles du flux 122 relevées le 19 novembre 2026 (hors saison : tout est « très faible »,
    /// concentrations nulles) pour Saint-Clair-sur-Epte, Bordeaux, Rennes, Toulouse, Nantes, Ruffieu
    /// (ancien code, plus de centre connu) et Ajaccio, aujourd'hui, demain et après-demain.
    const FIXTURE: &str = include_str!("testdata/pollen_extrait.json");

    /// Le même extrait, dont on modifie des valeurs pour couvrir toute l'échelle (la saison des pollens n'est pas là).
    fn season() -> String {
        let mut json: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        for feature in json["features"].as_array_mut().unwrap() {
            let p = &mut feature["properties"];
            if p["code_zone"] == "33063" && p["date_ech"] == "2026-11-20" {
                // Bordeaux, demain : bouleau extrêmement élevé, graminées modérées avec des grains.
                p["code_boul"] = 6.into();
                p["conc_boul"] = 480.0.into();
                p["code_gram"] = 3.into();
                p["conc_gram"] = 40.0.into();
                p["code_qual"] = 6.into();
            }
            if p["code_zone"] == "35238" && p["date_ech"] == "2026-11-19" {
                // Rennes, aujourd'hui : un peu d'aulne, très faible mais présent.
                p["conc_aul"] = 2.0.into();
                p["code_ambr"] = serde_json::Value::Null;
            }
        }
        json.to_string()
    }

    fn of_day(json: &str, day: &str) -> Vec<u8> {
        let mut value: serde_json::Value = serde_json::from_str(json).unwrap();
        value["features"].as_array_mut().unwrap().retain(|f| f["properties"]["date_ech"] == day);
        value.to_string().into_bytes()
    }

    fn out(json: &str) -> Out {
        let days = ["2026-11-19", "2026-11-20", "2026-11-21"].map(|d| (d, of_day(json, d)));
        build(&days.iter().map(|(d, b)| (*d, b.as_slice())).collect::<Vec<_>>(), 0).unwrap()
    }

    fn zone<'a>(out: &'a Out, name: &str) -> &'a str {
        &out.zones.v[out.zones.name.iter().position(|n| n == name).unwrap()]
    }

    #[test]
    fn lit_les_trois_jours_et_place_les_communes_par_leur_code() {
        let out = out(FIXTURE);
        assert_eq!(out.days, ["2026-11-19", "2026-11-20", "2026-11-21"]);
        let i = out.zones.name.iter().position(|n| n == "Bordeaux").unwrap();
        assert_eq!(out.zones.code[i], "33063");
        assert!((out.zones.lon[i] + 0.58).abs() < 0.1 && (out.zones.lat[i] - 44.84).abs() < 0.1, "{:?}", (out.zones.lon[i], out.zones.lat[i]));
        assert_eq!(out.sources[out.zones.src[i] as usize], "Atmo Nouvelle-Aquitaine");
        // Les associations qui ne servent pas la même source : chacune a son nom.
        assert!(out.sources.iter().any(|s| s == "Atmo France") && out.sources.iter().any(|s| s == "Air Breizh"));
    }

    #[test]
    fn ecarte_les_communes_sans_centre() {
        let out = out(FIXTURE);
        assert!(!out.zones.name.iter().any(|n| n == "Ruffieu"));
        assert_eq!(out.zones.name.len(), 6);
    }

    #[test]
    fn hors_saison_dit_aucun_pollen() {
        let out = out(FIXTURE);
        // Niveau 1 et concentrations nulles : « o » partout, global compris.
        assert_eq!(zone(&out, "Bordeaux"), "ooooooo".repeat(3));
    }

    #[test]
    fn garde_l_echelle_officielle_et_les_valeurs_absentes() {
        let out = out(&season());
        // Demain à Bordeaux : global 6, aulne o, bouleau 6, olivier o, graminées 3, armoise o, ambroisie o.
        assert_eq!(&zone(&out, "Bordeaux")[7..14], "6o6o3oo");
        // Aujourd'hui à Rennes : de l'aulne en très faible (1), l'ambroisie non évaluée ; global 1 (pas tous « o »).
        assert_eq!(&zone(&out, "Rennes")[0..7], "11oooo-");
    }

    #[test]
    fn jour_non_publie_donne_des_tirets_ou_est_retire() {
        // Avec deux jours seulement, la réponse n'en a que deux.
        let days = [("2026-11-19", of_day(FIXTURE, "2026-11-19")), ("2026-11-20", of_day(FIXTURE, "2026-11-20"))];
        let two = build(&days.iter().map(|(d, b)| (*d, b.as_slice())).collect::<Vec<_>>(), 0).unwrap();
        assert_eq!(two.days.len(), 2);
        assert!(two.zones.v.iter().all(|v| v.len() == 14));
        // Une commune absente d'un jour : des tirets pour ce jour.
        let mut partial = of_day(FIXTURE, "2026-11-20");
        let mut value: serde_json::Value = serde_json::from_slice(&partial).unwrap();
        value["features"].as_array_mut().unwrap().retain(|f| f["properties"]["code_zone"] != "31555");
        partial = value.to_string().into_bytes();
        let out = build(&[("2026-11-19", &of_day(FIXTURE, "2026-11-19")), ("2026-11-20", &partial)], 0).unwrap();
        assert_eq!(&zone(&out, "Toulouse")[7..], "-------");
    }

    /// Relevé réel, pour mesurer la taille de la réponse et la mémoire (`/usr/bin/time -l` donne le pic) :
    /// `ATMO_USERNAME=… ATMO_PASSWORD=… cargo test pollen::tests::en_direct -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "réseau et identifiants Atmo Data"]
    async fn en_direct() {
        let (user, password) = (std::env::var("ATMO_USERNAME").unwrap(), std::env::var("ATMO_PASSWORD").unwrap());
        let mut collector = Collector::new(reqwest::Client::new(), user, password);
        println!("catalogue : {:?}", feed_stamp(&mut collector).await.unwrap());
        let body = collect(&mut collector).await.unwrap();
        println!("réponse : {} octets", body.len());
        std::fs::write(std::env::var("POLLEN_OUT").unwrap_or_else(|_| "/dev/null".into()), &body).unwrap();
    }

    #[test]
    fn retient_la_publication_la_plus_recente() {
        // Les associations publient à des heures différentes : la plus tardive l'emporte (au moins 16 h 18 à Paris).
        let at = out(FIXTURE).issued_at.unwrap();
        assert!(at >= "2026-11-19T15:18:04Z".parse::<Timestamp>().unwrap().as_second());
        assert!(at < "2026-11-20T00:00:00Z".parse::<Timestamp>().unwrap().as_second());
    }

    #[test]
    fn serialise_en_colonnes_de_meme_longueur() {
        let json = serde_json::to_value(out(FIXTURE)).unwrap();
        let zones = &json["zones"];
        let n = zones["name"].as_array().unwrap().len();
        for column in ["code", "lon", "lat", "src", "v"] {
            assert_eq!(zones[column].as_array().unwrap().len(), n, "{column}");
        }
        assert_eq!(json["updatedAt"], 0);
    }

    #[test]
    fn les_centres_sont_tries_pour_la_recherche_dichotomique() {
        let centres = centres();
        assert!(centres.len() > 34_000);
        assert!(centres.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn encode_le_filtre_dans_l_adresse() {
        let day = "2026-11-19".parse().unwrap();
        assert_eq!(
            day_url(day, Some(&["93", "94"])),
            "https://admindata.atmo-france.org/api/data/122/%7B%22aasqa%22%3A%7B%22operator%22%3A%22IN%22%2C%22value%22%3A%5B%2293%22%2C%2294%22%5D%7D%2C%22date_ech%22%3A%7B%22operator%22%3A%22%3D%22%2C%22value%22%3A%222026-11-19%22%7D%7D"
        );
        // Le lot de rattrapage exclut tous les codes connus, et eux seuls.
        let rest = day_url(day, None);
        assert!(rest.contains("NOT%20IN") && rest.contains("%2294%22") && rest.contains("%2211%22"));
        assert_eq!(BATCHES.iter().map(|b| b.len()).sum::<usize>(), 13);
    }

    #[test]
    fn lit_la_date_de_mise_a_jour_du_catalogue() {
        let catalogue = r#"[{"name":"Indices","layers":[{"id":112}],"last_update":{"date":"2026-11-19 20:05:01.000000"}},
            {"name":"Indice pollen","layers":[{"id":122,"name":"x"}],"last_update":{"date":"2026-11-19 16:21:01.000000"}}]"#;
        let feeds: Vec<FeedInfo> = serde_json::from_str(catalogue).unwrap();
        let stamp = feeds.into_iter().find(|f| f.layers.iter().any(|l| l.id == FEED_LAYER)).and_then(|f| f.last_update).map(|u| u.date);
        assert_eq!(stamp.as_deref(), Some("2026-11-19 16:21:01.000000"));
    }
}
