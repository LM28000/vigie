//! Actualité locale : les titres de la presse régionale et du service public, placés sur la commune dont ils parlent.
//!
//! # Ce que le serveur lit, et ce qu'il garde
//!
//! Des fils RSS publics (la liste est dans `actualite/flux.json` : France 3 Régions, ICI, quotidiens régionaux). **Il ne garde
//! et ne sert que le titre, l'adresse de l'article, le nom du fil et l'heure de publication** : ni chapô, ni texte, ni image, ni
//! auteur, ni page d'article (jamais téléchargée). Le navigateur ouvre l'article chez l'éditeur.
//!
//! # Politesse
//!
//! - le `User-Agent` est celui du projet (`carte-vivante/<version>`), sans donnée personnelle ;
//! - le `robots.txt` de chaque hôte est lu (une fois par jour) et respecté : un fil qu'il interdit n'est pas lu ;
//! - chaque fil est relevé au plus **toutes les 15 minutes**, avec `If-None-Match` / `If-Modified-Since` ;
//! - au plus une requête toutes les 10 secondes, tous hôtes confondus (le `Crawl-delay` de 10 s de Nice-Matin est respecté de fait).
//!
//! # Mémoire
//!
//! Les titres des 3 derniers jours (au plus 15 000), compacts : quelques Mo. La liste des communes (geo.api.gouv.fr, ~35 000
//! communes) en prend une dizaine. Les titres sont écrits sur le disque (`data/actualite/titres.json`) pour survivre à un
//! redémarrage ; la liste des communes est relue du disque (`communes.json`) et rafraîchie tous les 30 jours.
//!
//! # Réglages
//!
//! `ACTUALITE=non` désactive le collecteur. La localisation est expliquée dans `actualite/lieux.rs`.

mod flux;
mod lieux;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use flux::{Feed, Robots};
use lieux::{Gazetteer, Method, Place};

/// Un fil est relevé au plus toutes les 15 minutes.
const EVERY: Duration = Duration::from_secs(15 * 60);
/// Au plus une requête toutes les 10 secondes, tous hôtes confondus.
const PAUSE: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_FEED_BYTES: usize = 3_000_000;
const ROBOTS_EVERY: Duration = Duration::from_secs(24 * 3600);
/// Durée de conservation des titres : trois jours.
const RETAIN_S: i64 = 3 * 24 * 3600;
const MAX_ITEMS: usize = 15_000;
const COMMUNES_URL: &str = "https://geo.api.gouv.fr/communes?fields=nom,code,codeDepartement,centre,population&format=json&geometry=centre";
const COMMUNES_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

// --- État ----------------------------------------------------------------------------------------------------------------------

struct Item {
    t: i64,
    feed: u16,
    place: Place,
    title: Box<str>,
    url: Box<str>,
}

#[derive(Default, Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
struct Stats {
    /// Articles nouveaux vus depuis le démarrage.
    seen: u64,
    commune_url: u64,
    commune_title: u64,
    dept_url: u64,
    dept_title: u64,
    unlocated: u64,
}

#[derive(Default)]
struct Store {
    items: Vec<Item>,
    /// Articles déjà traités (gardés ou non) : adresse sans paramètres → heure.
    seen: HashMap<u64, i64>,
    stats: Stats,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));
static BODY: RwLock<Option<Bytes>> = RwLock::new(None);
static GAZETTEER: OnceLock<Arc<Gazetteer>> = OnceLock::new();
static FEEDS: OnceLock<Vec<Feed>> = OnceLock::new();

fn hash_of(text: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// L'identité d'un article : son adresse sans paramètres (ICI y met des marques de suivi).
fn canonical(url: &str) -> u64 {
    hash_of(url.split(['?', '#']).next().unwrap_or(url))
}

fn title_key(title: &str) -> u64 {
    hash_of(&format!("titre:{}", title.to_lowercase()))
}

fn store() -> std::sync::MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Range les articles d'un fil. Renvoie le nombre de titres nouveaux placés.
fn ingest(gazetteer: &Gazetteer, feed_index: usize, feed: &Feed, depts: &[u16], entries: Vec<flux::Entry>, now: i64) -> usize {
    let mut store = store();
    let mut added = 0;
    for entry in entries {
        let t = entry.published.unwrap_or(now).min(now);
        if now - t > RETAIN_S {
            continue;
        }
        let id = canonical(&entry.url);
        if store.seen.contains_key(&id) {
            continue;
        }
        store.seen.insert(id, t);
        // Le même titre repris par plusieurs journaux d'un même groupe (dépêches nationales) ne compte qu'une fois.
        let same_title = title_key(&entry.title);
        if store.seen.insert(same_title, t).is_some() {
            continue;
        }
        store.stats.seen += 1;
        match gazetteer.locate(&entry.title, &entry.url, &feed.geo, depts) {
            Some((place, method)) => {
                match method {
                    Method::UrlCommune => store.stats.commune_url += 1,
                    Method::TitleCommune => store.stats.commune_title += 1,
                    Method::UrlDept => store.stats.dept_url += 1,
                    Method::TitleDept => store.stats.dept_title += 1,
                }
                store.items.push(Item { t, feed: feed_index as u16, place, title: entry.title.into(), url: entry.url.into() });
                added += 1;
            }
            None => store.stats.unlocated += 1,
        }
    }
    added
}

fn prune(now: i64) {
    let mut store = store();
    store.items.retain(|i| now - i.t <= RETAIN_S);
    if store.items.len() > MAX_ITEMS {
        store.items.sort_by_key(|i| std::cmp::Reverse(i.t));
        store.items.truncate(MAX_ITEMS);
    }
    store.seen.retain(|_, t| now - *t <= RETAIN_S);
}

// --- Ce que sert l'API ---------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
struct SourceOut<'a> {
    /// L'éditeur ou le réseau.
    group: &'a str,
    name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceOut<'a> {
    /// Code INSEE de la commune, ou `d:` et le code du département.
    id: String,
    name: &'a str,
    lon: f32,
    lat: f32,
    /// Code du département (celui du lieu si c'est un département).
    dept: &'a str,
    /// Vrai : le titre est rattaché au département, pas à un point précis.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    is_dept: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Out<'a> {
    generated_at: i64,
    sources: Vec<SourceOut<'a>>,
    places: Vec<PlaceOut<'a>>,
    /// `[heure, fil, lieu, titre, adresse]`, du plus récent au plus ancien.
    items: Vec<(i64, u16, u32, &'a str, &'a str)>,
    stats: Stats,
}

fn place_out<'a>(gazetteer: &'a Gazetteer, place: Place) -> PlaceOut<'a> {
    match place {
        Place::Commune(c) => {
            let commune = &gazetteer.communes[c as usize];
            let dept = &gazetteer.depts[usize::from(commune.dept)];
            PlaceOut { id: commune.insee.to_string(), name: &commune.name, lon: commune.lon, lat: commune.lat, dept: dept.code, is_dept: false }
        }
        Place::Dept(d) => {
            let dept = &gazetteer.depts[usize::from(d)];
            PlaceOut { id: format!("d:{}", dept.code), name: dept.name, lon: dept.lon, lat: dept.lat, dept: dept.code, is_dept: true }
        }
    }
}

fn rebuild(now: i64) {
    let (Some(gazetteer), Some(feeds)) = (GAZETTEER.get(), FEEDS.get()) else { return };
    let store = store();
    let mut index: HashMap<Place, u32> = HashMap::new();
    let mut places: Vec<PlaceOut> = Vec::new();
    let mut items: Vec<&Item> = store.items.iter().collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.t));
    let rows: Vec<(i64, u16, u32, &str, &str)> = items
        .iter()
        .map(|item| {
            let place = *index.entry(item.place).or_insert_with(|| {
                places.push(place_out(gazetteer, item.place));
                places.len() as u32 - 1
            });
            (item.t, item.feed, place, &*item.title, &*item.url)
        })
        .collect();
    let out = Out {
        generated_at: now,
        sources: feeds.iter().map(|f| SourceOut { group: &f.groupe, name: &f.nom }).collect(),
        places,
        items: rows,
        stats: store.stats,
    };
    match serde_json::to_vec(&out) {
        Ok(body) => *BODY.write().unwrap_or_else(|e| e.into_inner()) = Some(Bytes::from(body)),
        Err(error) => warn!(%error, "actualité : réponse non fabriquée"),
    }
}

/// La réponse de `/api/actualite`.
pub fn response() -> Response {
    let body = BODY.read().unwrap_or_else(|e| e.into_inner()).clone();
    match body {
        Some(body) => ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-cache")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "actualité : première collecte en cours").into_response(),
    }
}

// --- Ce que lisent la veille et la synthèse -----------------------------------------------------------------------------------

/// Un titre récent, posé quelque part (pour les zones surveillées).
pub struct News {
    pub id: String,
    pub title: String,
    pub source: String,
    pub t: i64,
    pub lon: f64,
    pub lat: f64,
    /// Code INSEE de la commune (ou `d:` et le code du département) : c'est ce que le site sélectionne.
    pub place: String,
    pub place_name: String,
}

/// Les titres des `window_s` dernières secondes, du plus récent au plus ancien, au plus `max`. `None` : pas encore de collecte.
pub fn recent(now: i64, window_s: i64, max: usize) -> Option<Vec<News>> {
    let (gazetteer, feeds) = (GAZETTEER.get()?, FEEDS.get()?);
    BODY.read().unwrap_or_else(|e| e.into_inner()).as_ref()?;
    let store = store();
    let mut items: Vec<&Item> = store.items.iter().filter(|i| now - i.t <= window_s).collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.t));
    items.truncate(max);
    Some(
        items
            .into_iter()
            .map(|item| {
                let place = place_out(gazetteer, item.place);
                News {
                    id: format!("actu:{:x}", canonical(&item.url)),
                    title: item.title.to_string(),
                    source: feeds[usize::from(item.feed)].nom.clone(),
                    t: item.t,
                    lon: f64::from(place.lon),
                    lat: f64::from(place.lat),
                    place: place.id,
                    place_name: place.name.to_string(),
                }
            })
            .collect(),
    )
}

// --- Liste des communes --------------------------------------------------------------------------------------------------------

async fn load_gazetteer(http: &reqwest::Client, dir: &Path) -> Result<Gazetteer> {
    let path = dir.join("communes.json");
    let fresh = tokio::fs::metadata(&path).await.ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age < COMMUNES_MAX_AGE);
    if !fresh {
        match download(http, COMMUNES_URL).await {
            Ok(bytes) => {
                tokio::fs::create_dir_all(dir).await.ok();
                let partial = dir.join("communes.json.part");
                tokio::fs::write(&partial, &bytes).await.context("écriture de la liste des communes")?;
                tokio::fs::rename(&partial, &path).await.context("rangement de la liste des communes")?;
                info!(ko = bytes.len() / 1024, "actualité : liste des communes téléchargée (geo.api.gouv.fr)");
            }
            Err(error) if path.exists() => warn!(%error, "actualité : liste des communes non rafraîchie, l'ancienne est gardée"),
            Err(error) => return Err(error),
        }
    }
    let json = tokio::fs::read(&path).await.context("lecture de la liste des communes")?;
    tokio::task::spawn_blocking(move || Gazetteer::from_json(&json)).await.context("tâche de lecture des communes")?
}

async fn download(http: &reqwest::Client, url: &str) -> Result<Bytes> {
    let response = http.get(url).send().await.with_context(|| format!("requête {url}"))?;
    if !response.status().is_success() {
        bail!("{url} : réponse {}", response.status());
    }
    response.bytes().await.with_context(|| format!("lecture {url}"))
}

// --- Relevé des fils -----------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Validators {
    etag: Option<String>,
    modified: Option<String>,
}

/// `Some(texte)` ; `None` : rien de nouveau (304).
async fn fetch_feed(http: &reqwest::Client, feed: &Feed, validators: &mut Validators) -> Result<Option<String>> {
    let mut request = http
        .get(&feed.url)
        .timeout(REQUEST_TIMEOUT)
        .header(header::ACCEPT, "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8");
    if let Some(etag) = &validators.etag {
        request = request.header(header::IF_NONE_MATCH, etag);
    }
    if let Some(modified) = &validators.modified {
        request = request.header(header::IF_MODIFIED_SINCE, modified);
    }
    let response = request.send().await?;
    if response.status() == StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !response.status().is_success() {
        bail!("réponse {}", response.status());
    }
    let header_of = |name| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    validators.etag = header_of(header::ETAG);
    validators.modified = header_of(header::LAST_MODIFIED);
    if response.content_length().is_some_and(|n| n as usize > MAX_FEED_BYTES) {
        bail!("fil trop gros");
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_FEED_BYTES {
        bail!("fil trop gros");
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Le robots.txt d'un hôte, relu une fois par jour. `None` : indisponible pour l'instant (erreur serveur) : on ne lit pas le fil.
async fn robots_for(http: &reqwest::Client, host_url: &str, cache: &mut HashMap<String, (Instant, Robots)>) -> Option<Robots> {
    if let Some((at, robots)) = cache.get(host_url) {
        if at.elapsed() < ROBOTS_EVERY {
            return Some(robots.clone());
        }
    }
    let response = http.get(format!("{host_url}/robots.txt")).timeout(REQUEST_TIMEOUT).send().await;
    tokio::time::sleep(PAUSE).await;
    let robots = match response {
        Ok(r) if r.status().is_success() => Robots::parse(&r.text().await.unwrap_or_default(), concat!("carte-vivante/", env!("CARGO_PKG_VERSION"))),
        // Pas de fichier (404, 403…) : RFC 9309, tout est permis. Un fil que l'éditeur protège autrement répondra 403 de lui-même.
        Ok(r) if r.status().is_client_error() => Robots::allow_all(),
        _ => return cache.get(host_url).map(|(_, r)| r.clone()),
    };
    cache.insert(host_url.to_string(), (Instant::now(), robots.clone()));
    Some(robots)
}

fn origin_and_path(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
    Some((format!("{scheme}://{host}"), format!("/{path}")))
}

// --- Persistance ---------------------------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct Saved {
    t: i64,
    feed: String,
    place: String,
    title: String,
    url: String,
}

fn place_key(gazetteer: &Gazetteer, place: Place) -> String {
    place_out(gazetteer, place).id
}

fn save(path: &Path) -> Result<()> {
    let (Some(gazetteer), Some(feeds)) = (GAZETTEER.get(), FEEDS.get()) else { return Ok(()) };
    let saved: Vec<Saved> = store()
        .items
        .iter()
        .map(|i| Saved { t: i.t, feed: feeds[usize::from(i.feed)].id.clone(), place: place_key(gazetteer, i.place), title: i.title.to_string(), url: i.url.to_string() })
        .collect();
    let partial = path.with_extension("json.part");
    std::fs::write(&partial, serde_json::to_vec(&saved)?)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

fn restore(path: &Path, gazetteer: &Gazetteer, feeds: &[Feed], now: i64) -> usize {
    let Ok(bytes) = std::fs::read(path) else { return 0 };
    let Ok(saved) = serde_json::from_slice::<Vec<Saved>>(&bytes) else { return 0 };
    let by_insee: HashMap<&str, u32> = gazetteer.communes.iter().enumerate().map(|(i, c)| (&*c.insee, i as u32)).collect();
    let mut store = store();
    for s in saved {
        let place = match s.place.strip_prefix("d:") {
            Some(code) => gazetteer.dept_index(code).map(Place::Dept),
            None => by_insee.get(s.place.as_str()).map(|&c| Place::Commune(c)),
        };
        let (Some(place), Some(feed)) = (place, feeds.iter().position(|f| f.id == s.feed)) else { continue };
        if now - s.t > RETAIN_S {
            continue;
        }
        store.seen.insert(canonical(&s.url), s.t);
        store.seen.insert(title_key(&s.title), s.t);
        store.items.push(Item { t: s.t, feed: feed as u16, place, title: s.title.into(), url: s.url.into() });
    }
    store.items.len()
}

// --- La boucle -----------------------------------------------------------------------------------------------------------------

pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf) {
    if std::env::var("ACTUALITE").is_ok_and(|v| matches!(v.to_lowercase().as_str(), "non" | "0" | "false" | "off")) {
        info!("actualité locale : désactivée (ACTUALITE)");
        return;
    }
    let dir = data_dir.join("actualite");
    let feeds = match flux::feeds() {
        Ok(feeds) => feeds,
        Err(error) => {
            warn!(%error, "actualité : liste des fils invalide");
            return;
        }
    };
    let gazetteer = loop {
        match load_gazetteer(&http, &dir).await {
            Ok(g) => break Arc::new(g),
            Err(error) => {
                warn!(error = format!("{error:#}"), "actualité : liste des communes indisponible, nouvel essai dans 10 minutes");
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
        }
    };
    info!(communes = gazetteer.communes.len(), fils = feeds.len(), "actualité : prête");
    let depts: Vec<Vec<u16>> = feeds.iter().map(|f| gazetteer.dept_indices(&f.depts)).collect();
    let _ = GAZETTEER.set(gazetteer.clone());
    let _ = FEEDS.set(feeds.clone());
    let saved_path = dir.join("titres.json");
    let now = Timestamp::now().as_second();
    let restored = restore(&saved_path, &gazetteer, &feeds, now);
    info!(titres = restored, "actualité : titres relus du disque");
    rebuild(now);

    let mut validators: Vec<Validators> = feeds.iter().map(|_| Validators::default()).collect();
    let mut robots: HashMap<String, (Instant, Robots)> = HashMap::new();
    loop {
        let started = Instant::now();
        let (mut read, mut unchanged, mut forbidden, mut failed, mut added) = (0, 0, 0, 0, 0);
        for (index, feed) in feeds.iter().enumerate() {
            let Some((origin, path)) = origin_and_path(&feed.url) else { continue };
            let Some(rules) = robots_for(&http, &origin, &mut robots).await else {
                failed += 1;
                continue;
            };
            if !rules.allows(&path) {
                forbidden += 1;
                warn!(fil = %feed.id, "actualité : le robots.txt interdit ce fil, il n'est pas lu");
                continue;
            }
            match fetch_feed(&http, feed, &mut validators[index]).await {
                Ok(None) => unchanged += 1,
                Ok(Some(text)) => match flux::parse(&text) {
                    Ok(entries) => {
                        read += 1;
                        let now = Timestamp::now().as_second();
                        added += ingest(&gazetteer, index, feed, &depts[index], entries, now);
                        rebuild(now);
                    }
                    Err(error) => {
                        failed += 1;
                        warn!(fil = %feed.id, error = format!("{error:#}"), "actualité : fil illisible");
                    }
                },
                Err(error) => {
                    failed += 1;
                    warn!(fil = %feed.id, error = format!("{error:#}"), "actualité : fil injoignable");
                }
            }
            tokio::time::sleep(PAUSE).await;
        }
        let now = Timestamp::now().as_second();
        prune(now);
        rebuild(now);
        if let Err(error) = save(&saved_path) {
            warn!(error = format!("{error:#}"), "actualité : titres non écrits");
        }
        let (items, stats) = {
            let s = store();
            (s.items.len(), s.stats)
        };
        info!(lus = read, inchanges = unchanged, interdits = forbidden, en_echec = failed, nouveaux = added, titres = items, vus = stats.seen, non_places = stats.unlocated, "actualité : relevé terminé");
        tokio::time::sleep(EVERY.saturating_sub(started.elapsed())).await;
    }
}

/// Mode de test (`--actualite-seule`) : seul le collecteur et sa route, sans horaires SNCF ni autre source.
pub async fn serve_alone(http: reqwest::Client, data_dir: PathBuf, address: std::net::SocketAddr) -> Result<()> {
    tokio::spawn(poll_forever(http, data_dir));
    let app = axum::Router::new().route("/api/actualite", axum::routing::get(|| async { response() }));
    let listener = tokio::net::TcpListener::bind(address).await.with_context(|| format!("écoute sur {address}"))?;
    info!("actualité seule, sur http://{address}");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_without_parameters_is_the_identity_of_an_article() {
        assert_eq!(canonical("https://www.ici.fr/a/b-1?at_medium=lien_RSS&at_locale=20"), canonical("https://www.ici.fr/a/b-1"));
        assert_ne!(canonical("https://www.ici.fr/a/b-1"), canonical("https://www.ici.fr/a/b-2"));
    }

    #[test]
    fn splits_an_origin_and_a_path() {
        assert_eq!(origin_and_path("https://www.ici.fr/rss/nord/a-la-une.xml"), Some(("https://www.ici.fr".into(), "/rss/nord/a-la-une.xml".into())));
        assert_eq!(origin_and_path("https://actu.fr/rss.xml"), Some(("https://actu.fr".into(), "/rss.xml".into())));
    }
}
