//! Webcams publiques : trois sources, toutes publiées volontairement par leurs propriétaires.
//!
//! - **Windy Webcams API v3** (<https://api.windy.com/webcams/docs>), avec la clé `WINDY_WEBCAMS_KEY`
//!   (lue ici, jamais envoyée au navigateur ; sans elle, la source est désactivée et `/api/webcams/windy`
//!   le dit). Conditions du niveau gratuit : les liens d'image expirent au bout de 10 minutes, on n'en
//!   garde donc **aucun** dans le catalogue ; le catalogue (identifiant, position, titre, lien Windy)
//!   est relevé toutes les 12 h par rectangles (la limite gratuite est de 1 050 résultats par filtre :
//!   un rectangle plus peuplé est coupé en quatre), et le lien d'une image n'est demandé qu'au moment
//!   où quelqu'un ouvre la fiche (`/api/webcams/windy/image/{id}`, qui redirige vers l'image), gardé
//!   8 minutes au plus, avec un plafond de requêtes par minute. Seules les petites tailles sont
//!   utilisées (`preview`, 400 px, sinon `thumbnail`).
//! - **Caméras Criter de la Métropole de Lyon** (data.gouv.fr, Licence Ouverte 2.0) : 15 caméras de
//!   circulation dont l'image est renouvelée chaque minute ; la liste (positions, noms, heure de
//!   l'image) est relue chaque minute sur le WFS de data.grandlyon.com, le navigateur charge
//!   l'image directement sur `download.data.grandlyon.com`.
//! - **Webcams ouvertes** : les jeux « Webcam - Orléans Métropole » et « Localisation des webcams - littoral
//!   Anglet » (data.gouv.fr, Licence Ouverte 2.0) donnent la position et la page de la webcam (Skaping,
//!   Viewsurf), pas d'image : la fiche renvoie vers cette page. Les listes sont statiques, relues toutes les
//!   6 h (huit requêtes par jour au plus pour les deux jeux).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::extract::Path as UrlPath;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use jiff::Timestamp;
use serde::Deserialize;
use tracing::{info, warn};

const WINDY_API: &str = "https://api.windy.com/webcams/api/v3/webcams";
/// Les six rectangles de la France métropolitaine (sud, ouest, nord, est), comme `rails.rs`.
const TILES: [(f64, f64, f64, f64); 6] = [
    (41.3, -5.2, 46.2, 0.0),
    (41.3, 0.0, 46.2, 4.8),
    (41.3, 4.8, 46.2, 9.6),
    (46.2, -5.2, 51.15, 0.0),
    (46.2, 0.0, 51.15, 4.8),
    (46.2, 4.8, 51.15, 9.6),
];
/// Niveau gratuit : `offset` jusqu'à 1 000 et `limit` jusqu'à 50.
const PAGE: usize = 50;
const MAX_RESULTS: usize = 1_050;
const CATALOG_EVERY: Duration = Duration::from_secs(12 * 3600);
const CATALOG_RETRY: Duration = Duration::from_secs(30 * 60);
/// Pause entre deux requêtes du relevé du catalogue.
const CATALOG_PAUSE: Duration = Duration::from_millis(1_500);
/// Garde-fou : au plus ce nombre de requêtes pour un relevé complet.
const CATALOG_MAX_REQUESTS: u32 = 400;
/// Un lien d'image expire à 10 minutes : on le garde 8 minutes au plus.
const LINK_LIFETIME: Duration = Duration::from_secs(8 * 60);
/// Plafond de requêtes à Windy pour des liens d'image, par minute (tous visiteurs confondus).
const LINKS_PER_MINUTE: usize = 40;

const CRITER_URL: &str = "https://data.grandlyon.com/geoserver/metropole-de-lyon/ows?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=metropole-de-lyon:pvo_patrimoine_voirie.pvocameracriter&outputFormat=application/json&SRSNAME=EPSG:4326";
const CRITER_EVERY: Duration = Duration::from_secs(60);
const CRITER_IMAGE_HOST: &str = "download.data.grandlyon.com";

const ORLEANS_URL: &str = "https://data.orleans-metropole.fr/api/explore/v2.1/catalog/datasets/om-webcam-dispositif/exports/json";
const ANGLET_URL: &str = "https://anglet-opendatapaysbasque.opendatasoft.com/api/explore/v2.1/catalog/datasets/20240325-webcam_64024-21640024200014_anglet/exports/json";
/// Listes statiques : relues quatre fois par jour au plus.
const OPEN_EVERY: Duration = Duration::from_secs(6 * 3600);
const OPEN_RETRY: Duration = Duration::from_secs(30 * 60);

// ---------------------------------------------------------------------------------------------
// État partagé
// ---------------------------------------------------------------------------------------------

struct Catalog {
    body: Bytes,
    ids: HashSet<u64>,
}

static CATALOG: RwLock<Option<Catalog>> = RwLock::new(None);
static CRITER: RwLock<Option<Bytes>> = RwLock::new(None);
static OPEN: RwLock<Option<Bytes>> = RwLock::new(None);
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
/// Liens d'image de Windy : identifiant → (lien, instant de la demande). Jamais plus de 8 minutes.
static LINKS: Mutex<Option<HashMap<u64, (String, Instant)>>> = Mutex::new(None);
/// Instants des dernières demandes de liens à Windy (plafond par minute).
static CALLS: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());
/// Une seule demande de lien à la fois (et pas de doublon quand dix visiteurs ouvrent la même fiche).
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// La clé de Windy, si elle est fournie. Elle ne quitte jamais ce module.
fn windy_key() -> Option<String> {
    std::env::var("WINDY_WEBCAMS_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}

/// Lance les deux collecteurs.
pub fn spawn(http: reqwest::Client, data_dir: PathBuf) {
    let _ = CLIENT.set(http.clone());
    tokio::spawn(windy_catalog_forever(http.clone(), data_dir));
    tokio::spawn(criter_forever(http.clone()));
    tokio::spawn(open_forever(http));
}

/// `GET /api/webcams/windy` : `{ "actif", "updatedAt", "webcams": [[id, lon, lat, titre, ville, lien Windy], …] }`.
pub fn windy_response() -> Response {
    if windy_key().is_none() {
        let body = r#"{"actif":false,"raison":"clé WINDY_WEBCAMS_KEY absente sur le serveur","updatedAt":0,"webcams":[]}"#;
        return ([(header::CONTENT_TYPE, "application/json")], body).into_response();
    }
    match CATALOG.read().expect("verrou du catalogue Windy").as_ref() {
        Some(catalog) => ([(header::CONTENT_TYPE, "application/json")], catalog.body.clone()).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "webcams Windy : premier relevé en cours").into_response(),
    }
}

/// `GET /api/webcams/criter` : `{ "updatedAt", "cameras": [[id, lon, lat, nom, lieu, observation, image, heure de l'image], …] }`.
pub fn criter_response() -> Response {
    match CRITER.read().expect("verrou de Criter").clone() {
        Some(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "caméras Criter : première lecture en cours").into_response(),
    }
}

/// `GET /api/webcams/ouvertes` : `{ "updatedAt", "webcams": [[id, lon, lat, nom, commune, page, source], …] }`.
pub fn open_response() -> Response {
    match OPEN.read().expect("verrou des webcams ouvertes").clone() {
        Some(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "webcams ouvertes : première lecture en cours").into_response(),
    }
}

// ---------------------------------------------------------------------------------------------
// Windy : décodage
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct WebcamList {
    #[serde(default)]
    total: usize,
    #[serde(default)]
    webcams: Vec<WebcamDto>,
}

#[derive(Deserialize)]
struct WebcamDto {
    #[serde(rename = "webcamId")]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    location: Option<LocationDto>,
    urls: Option<UrlsDto>,
    images: Option<ImagesDto>,
}

#[derive(Deserialize)]
struct LocationDto {
    latitude: f64,
    longitude: f64,
    #[serde(default)]
    city: String,
}

#[derive(Deserialize)]
struct UrlsDto {
    #[serde(default)]
    detail: String,
}

#[derive(Deserialize)]
struct ImagesDto {
    current: Option<CurrentImages>,
}

#[derive(Deserialize)]
struct CurrentImages {
    preview: Option<String>,
    thumbnail: Option<String>,
}

/// Une webcam du catalogue.
#[derive(Debug, Clone, PartialEq)]
pub struct Cam {
    pub id: u64,
    pub lon: f64,
    pub lat: f64,
    pub title: String,
    pub city: String,
    /// Page de la webcam sur Windy (`urls.detail`).
    pub detail: String,
}

/// Une page de la liste : le nombre total de résultats du filtre, et les webcams actives.
pub fn parse_list(bytes: &[u8]) -> Result<(usize, Vec<Cam>)> {
    let list: WebcamList = serde_json::from_slice(bytes).context("liste Windy illisible")?;
    let cams = list
        .webcams
        .into_iter()
        .filter(|w| w.status.is_empty() || w.status == "active")
        .filter_map(|w| {
            let location = w.location?;
            // La page de la webcam vient de l'API ; à défaut, son adresse publique.
            let detail = w.urls.map(|u| u.detail).filter(|d| d.starts_with("https://")).unwrap_or_else(|| format!("https://webcams.windy.com/webcams/{}", w.id));
            Some(Cam {
                id: w.id,
                lon: (location.longitude * 1e5).round() / 1e5,
                lat: (location.latitude * 1e5).round() / 1e5,
                title: truncate(&w.title, 90),
                city: truncate(&location.city, 50),
                detail,
            })
        })
        .collect();
    Ok((list.total, cams))
}

/// Lien de l'image d'une webcam : la petite taille (`preview`, 400 px), sinon la miniature.
/// Seule une adresse https de windy.com est acceptée (le serveur redirige le navigateur vers elle).
pub fn parse_image_link(bytes: &[u8]) -> Result<String> {
    let dto: WebcamDto = serde_json::from_slice(bytes).context("webcam Windy illisible")?;
    let current = dto.images.and_then(|i| i.current).context("pas d'image dans la réponse")?;
    let link = current.preview.or(current.thumbnail).context("ni preview ni thumbnail")?;
    if !is_windy_https(&link) {
        bail!("lien d'image hors de windy.com");
    }
    Ok(link)
}

fn is_windy_https(link: &str) -> bool {
    link.strip_prefix("https://").and_then(|rest| rest.split(['/', '?', '#']).next()).is_some_and(|host| host == "windy.com" || host.ends_with(".windy.com"))
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max { text } else { format!("{}…", text.chars().take(max).collect::<String>().trim_end()) }
}

/// La réponse JSON du catalogue.
pub fn catalog_json(cams: &[Cam], updated_at: i64) -> Vec<u8> {
    let rows: Vec<serde_json::Value> = cams.iter().map(|c| serde_json::json!([c.id, c.lon, c.lat, c.title, c.city, c.detail])).collect();
    serde_json::to_vec(&serde_json::json!({ "actif": true, "updatedAt": updated_at, "webcams": rows })).expect("JSON du catalogue Windy")
}

// ---------------------------------------------------------------------------------------------
// Windy : catalogue
// ---------------------------------------------------------------------------------------------

/// Cible d'une requête à Windy : jamais d'erreur qui mentionne la clé (elle n'est que dans l'en-tête).
async fn windy_get(http: &reqwest::Client, key: &str, url: &str) -> Result<Vec<u8>> {
    let response = http.get(url).header("x-windy-api-key", key).timeout(Duration::from_secs(30)).send().await.context("Windy injoignable")?;
    let status = response.status();
    if !status.is_success() {
        bail!("Windy a répondu {status}");
    }
    Ok(response.bytes().await?.to_vec())
}

fn list_url((south, west, north, east): (f64, f64, f64, f64), offset: usize) -> String {
    // bbox : nord, est, sud, ouest.
    format!("{WINDY_API}?bbox={north},{east},{south},{west}&countries=FR&include=location,urls&lang=fr&limit={PAGE}&offset={offset}")
}

/// Relève toutes les webcams d'un rectangle ; trop peuplé pour la limite gratuite, il est coupé en quatre.
async fn crawl(http: &reqwest::Client, key: &str, tile: (f64, f64, f64, f64), depth: u8, found: &mut HashMap<u64, Cam>, requests: &mut u32) -> Result<()> {
    let mut fetch = async |offset: usize| -> Result<(usize, Vec<Cam>)> {
        *requests += 1;
        if *requests > CATALOG_MAX_REQUESTS {
            bail!("plus de {CATALOG_MAX_REQUESTS} requêtes pour un relevé : arrêt");
        }
        tokio::time::sleep(CATALOG_PAUSE).await;
        parse_list(&windy_get(http, key, &list_url(tile, offset)).await?)
    };
    let (total, first) = fetch(0).await?;
    if total > MAX_RESULTS && depth < 5 {
        let (south, west, north, east) = tile;
        let (mid_lat, mid_lon) = ((south + north) / 2.0, (west + east) / 2.0);
        for sub in [(south, west, mid_lat, mid_lon), (south, mid_lon, mid_lat, east), (mid_lat, west, north, mid_lon), (mid_lat, mid_lon, north, east)] {
            Box::pin(crawl(http, key, sub, depth + 1, found, requests)).await?;
        }
        return Ok(());
    }
    for cam in first {
        found.insert(cam.id, cam);
    }
    let mut offset = PAGE;
    while offset < total.min(MAX_RESULTS) {
        for cam in fetch(offset).await?.1 {
            found.insert(cam.id, cam);
        }
        offset += PAGE;
    }
    Ok(())
}

async fn windy_catalog_forever(http: reqwest::Client, data_dir: PathBuf) {
    let Some(key) = windy_key() else {
        info!("webcams Windy : WINDY_WEBCAMS_KEY absente, source désactivée");
        return;
    };
    let cache = data_dir.join("webcams").join("windy-catalogue.json");
    loop {
        let age = cache_age(&cache).await;
        if CATALOG.read().expect("verrou du catalogue Windy").is_none()
            && let Ok(body) = tokio::fs::read(&cache).await
        {
            match install_catalog(body) {
                Ok(count) => info!(webcams = count, "webcams Windy : catalogue chargé du cache"),
                Err(error) => warn!("webcams Windy : cache illisible : {error:#}"),
            }
        }
        if age.is_some_and(|a| a < CATALOG_EVERY) && CATALOG.read().expect("verrou du catalogue Windy").is_some() {
            tokio::time::sleep(CATALOG_EVERY - age.unwrap_or_default()).await;
            continue;
        }
        match releve(&http, &key, &cache).await {
            Ok(count) => info!(webcams = count, "webcams Windy : catalogue relevé"),
            Err(error) => {
                warn!("webcams Windy : relevé impossible : {error:#}");
                tokio::time::sleep(CATALOG_RETRY).await;
            }
        }
    }
}

async fn releve(http: &reqwest::Client, key: &str, cache: &Path) -> Result<usize> {
    let mut found: HashMap<u64, Cam> = HashMap::new();
    let mut requests = 0;
    for tile in TILES {
        crawl(http, key, tile, 0, &mut found, &mut requests).await?;
    }
    let mut cams: Vec<Cam> = found.into_values().collect();
    cams.sort_by_key(|c| c.id);
    info!(requetes = requests, webcams = cams.len(), "webcams Windy : relevé terminé");
    let body = catalog_json(&cams, Timestamp::now().as_second());
    if let Some(dir) = cache.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = cache.with_extension("json.part");
    tokio::fs::write(&tmp, &body).await?;
    tokio::fs::rename(&tmp, cache).await?;
    install_catalog(body)
}

fn install_catalog(body: Vec<u8>) -> Result<usize> {
    #[derive(Deserialize)]
    struct Stored {
        webcams: Vec<(u64, serde::de::IgnoredAny, serde::de::IgnoredAny, serde::de::IgnoredAny, serde::de::IgnoredAny, serde::de::IgnoredAny)>,
    }
    let stored: Stored = serde_json::from_slice(&body)?;
    let ids: HashSet<u64> = stored.webcams.iter().map(|w| w.0).collect();
    let count = ids.len();
    *CATALOG.write().expect("verrou du catalogue Windy") = Some(Catalog { body: Bytes::from(body), ids });
    Ok(count)
}

async fn cache_age(cache: &Path) -> Option<Duration> {
    tokio::fs::metadata(cache).await.ok()?.modified().ok()?.elapsed().ok()
}

// ---------------------------------------------------------------------------------------------
// Windy : lien d'une image à la demande
// ---------------------------------------------------------------------------------------------

/// `GET /api/webcams/windy/image/{id}` : redirige vers l'image actuelle de la webcam. Le lien (valable 10 minutes)
/// est demandé à Windy au besoin, gardé 8 minutes au plus ; jamais de lien dans le catalogue.
pub async fn windy_image(UrlPath(id): UrlPath<u64>) -> Response {
    let Some(key) = windy_key() else { return (StatusCode::NOT_FOUND, "source Windy désactivée").into_response() };
    let known = CATALOG.read().expect("verrou du catalogue Windy").as_ref().is_some_and(|c| c.ids.contains(&id));
    if !known {
        return (StatusCode::NOT_FOUND, "webcam inconnue").into_response();
    }
    match image_link(id, &key).await {
        Ok(link) => {
            let mut response = (StatusCode::FOUND, [(header::CACHE_CONTROL, "no-store")]).into_response();
            match HeaderValue::from_str(&link) {
                Ok(value) => {
                    response.headers_mut().insert(header::LOCATION, value);
                    response
                }
                Err(_) => (StatusCode::BAD_GATEWAY, "lien d'image invalide").into_response(),
            }
        }
        Err(ImageError::Busy) => (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30")], "trop de demandes d'images, réessayez dans un instant").into_response(),
        Err(ImageError::Upstream(error)) => {
            warn!(webcam = id, "webcams Windy : lien d'image impossible : {error:#}");
            (StatusCode::BAD_GATEWAY, "Windy n'a pas donné l'image").into_response()
        }
    }
}

enum ImageError {
    Busy,
    Upstream(anyhow::Error),
}

fn cached_link(id: u64) -> Option<String> {
    let mut links = LINKS.lock().expect("verrou des liens Windy");
    let map = links.get_or_insert_with(HashMap::new);
    // Rien ne dépasse 8 minutes : on balaie les liens périmés à chaque lecture.
    map.retain(|_, (_, at)| at.elapsed() < LINK_LIFETIME);
    map.get(&id).map(|(link, _)| link.clone())
}

async fn image_link(id: u64, key: &str) -> Result<String, ImageError> {
    if let Some(link) = cached_link(id) {
        return Ok(link);
    }
    let _turn = GATE.lock().await;
    // Une autre demande de la même webcam a pu aboutir pendant l'attente.
    if let Some(link) = cached_link(id) {
        return Ok(link);
    }
    {
        let mut calls = CALLS.lock().expect("verrou des demandes Windy");
        calls.retain(|at| at.elapsed() < Duration::from_secs(60));
        if calls.len() >= LINKS_PER_MINUTE {
            return Err(ImageError::Busy);
        }
        calls.push_back(Instant::now());
    }
    let http = CLIENT.get().ok_or_else(|| ImageError::Upstream(anyhow::anyhow!("client HTTP non prêt")))?;
    let bytes = windy_get(http, key, &format!("{WINDY_API}/{id}?include=images&lang=fr")).await.map_err(ImageError::Upstream)?;
    let link = parse_image_link(&bytes).map_err(ImageError::Upstream)?;
    LINKS.lock().expect("verrou des liens Windy").get_or_insert_with(HashMap::new).insert(id, (link.clone(), Instant::now()));
    Ok(link)
}

// ---------------------------------------------------------------------------------------------
// Criter (Métropole de Lyon)
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct FeatureCollection {
    features: Vec<Feature>,
}

#[derive(Deserialize)]
struct Feature {
    geometry: Option<Geometry>,
    properties: Properties,
}

#[derive(Deserialize)]
struct Geometry {
    coordinates: Vec<f64>,
}

#[derive(Deserialize)]
struct Properties {
    #[serde(default)]
    nom: String,
    #[serde(default)]
    libellelong: String,
    identifiant: Option<u64>,
    #[serde(default)]
    observation: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    last_update: String,
}

/// Lit la réponse WFS de la Métropole de Lyon et en tire la réponse de l'API. Les lignes sont triées par identifiant ;
/// une image dont l'adresse n'est pas sur `download.data.grandlyon.com` est écartée.
pub fn convert_criter(bytes: &[u8], updated_at: i64) -> Result<Vec<u8>> {
    let collection: FeatureCollection = serde_json::from_slice(bytes).context("réponse WFS illisible")?;
    let mut rows = Vec::new();
    for feature in collection.features {
        let (Some(geometry), Some(id)) = (feature.geometry, feature.properties.identifiant) else { continue };
        let [lon, lat, ..] = geometry.coordinates[..] else { continue };
        let p = feature.properties;
        let host_ok = p.url.strip_prefix("https://").and_then(|rest| rest.split('/').next()) == Some(CRITER_IMAGE_HOST);
        if !host_ok {
            continue;
        }
        // Heure de l'image : « 2026-11-15T16:06:30+01:00 », 0 si illisible.
        let image_time = p.last_update.parse::<Timestamp>().map(|t| t.as_second()).unwrap_or(0);
        rows.push((id, (lon * 1e6).round() / 1e6, (lat * 1e6).round() / 1e6, truncate(&p.nom, 60), truncate(&p.libellelong, 80), truncate(&p.observation, 80), p.url, image_time));
    }
    if rows.is_empty() {
        bail!("aucune caméra Criter dans la réponse");
    }
    rows.sort_by_key(|r| r.0);
    Ok(serde_json::to_vec(&serde_json::json!({ "updatedAt": updated_at, "cameras": rows }))?)
}

async fn criter_forever(http: reqwest::Client) {
    let mut first = true;
    loop {
        match criter_once(&http).await {
            Ok(count) if first => {
                info!(cameras = count, "caméras Criter : première lecture");
                first = false;
            }
            Ok(_) => {}
            Err(error) => warn!("caméras Criter indisponibles : {error:#}"),
        }
        tokio::time::sleep(CRITER_EVERY).await;
    }
}

async fn criter_once(http: &reqwest::Client) -> Result<usize> {
    let response = http.get(CRITER_URL).timeout(Duration::from_secs(30)).send().await?.error_for_status()?;
    let bytes = response.bytes().await?;
    let body = convert_criter(&bytes, Timestamp::now().as_second())?;
    let count = serde_json::from_slice::<serde_json::Value>(&body)?["cameras"].as_array().map_or(0, Vec::len);
    *CRITER.write().expect("verrou de Criter") = Some(Bytes::from(body));
    Ok(count)
}

// ---------------------------------------------------------------------------------------------
// Webcams ouvertes (Orléans Métropole, Anglet)
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Point {
    lon: f64,
    lat: f64,
}

#[derive(Deserialize)]
struct OrleansRow {
    #[serde(default)]
    id_webcam: String,
    #[serde(default)]
    nom_webcam: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    url_webcam: String,
    geo_point_webcam: Option<Point>,
    #[serde(default)]
    commune_equipement: String,
}

#[derive(Deserialize)]
struct AngletRow {
    #[serde(default)]
    ogc_fid: String,
    #[serde(default)]
    nom: String,
    #[serde(default)]
    lien: String,
    geo_point_2d: Option<Point>,
}

/// Une webcam ouverte : sa position et la page où la voir (pas d'image).
#[derive(Debug, Clone, PartialEq)]
pub struct OpenCam {
    pub id: u64,
    pub lon: f64,
    pub lat: f64,
    pub name: String,
    pub town: String,
    pub page: String,
    pub source: &'static str,
}

fn open_name(name: &str) -> String {
    let name = name.trim();
    truncate(name.strip_prefix("Webcam - ").or_else(|| name.strip_prefix("Webcam ")).unwrap_or(name), 80)
}

/// Seule une page https est gardée (le navigateur l'ouvre dans un nouvel onglet).
fn https_page(url: &str) -> bool {
    url.starts_with("https://") && !url.contains(char::is_whitespace)
}

/// Webcams touristiques d'Orléans Métropole qui ont une position et une page. Les webcams « d'affluence » des déchèteries
/// (sans position, pages disparues) sont écartées. Identifiants : 2000 + rang dans l'ordre des identifiants du jeu.
pub fn parse_orleans(bytes: &[u8]) -> Result<Vec<OpenCam>> {
    let mut rows: Vec<OrleansRow> = serde_json::from_slice(bytes).context("webcams d'Orléans illisibles")?;
    rows.sort_by(|a, b| a.id_webcam.cmp(&b.id_webcam));
    Ok(rows
        .into_iter()
        .enumerate()
        .filter(|(_, r)| r.kind == "webcam touristique" && https_page(&r.url_webcam))
        .filter_map(|(i, r)| {
            let point = r.geo_point_webcam?;
            Some(OpenCam {
                id: 2000 + i as u64,
                lon: (point.lon * 1e5).round() / 1e5,
                lat: (point.lat * 1e5).round() / 1e5,
                name: open_name(&r.nom_webcam),
                town: truncate(&r.commune_equipement, 50),
                page: r.url_webcam,
                source: "Orléans Métropole",
            })
        })
        .collect())
}

/// Webcams du littoral d'Anglet (pages Viewsurf). Identifiants : 1000 + `ogc_fid`.
pub fn parse_anglet(bytes: &[u8]) -> Result<Vec<OpenCam>> {
    let rows: Vec<AngletRow> = serde_json::from_slice(bytes).context("webcams d'Anglet illisibles")?;
    Ok(rows
        .into_iter()
        .filter(|r| https_page(&r.lien))
        .filter_map(|r| {
            let point = r.geo_point_2d?;
            Some(OpenCam {
                id: 1000 + r.ogc_fid.parse::<u64>().ok()?,
                lon: (point.lon * 1e5).round() / 1e5,
                lat: (point.lat * 1e5).round() / 1e5,
                name: open_name(&r.nom),
                town: "Anglet".to_string(),
                page: r.lien,
                source: "Commune d'Anglet",
            })
        })
        .collect())
}

/// La réponse JSON : les webcams triées par identifiant.
pub fn open_json(mut cams: Vec<OpenCam>, updated_at: i64) -> Result<Vec<u8>> {
    if cams.is_empty() {
        bail!("aucune webcam ouverte dans les réponses");
    }
    cams.sort_by_key(|c| c.id);
    let rows: Vec<serde_json::Value> = cams.iter().map(|c| serde_json::json!([c.id, c.lon, c.lat, c.name, c.town, c.page, c.source])).collect();
    Ok(serde_json::to_vec(&serde_json::json!({ "updatedAt": updated_at, "webcams": rows }))?)
}

async fn open_once(http: &reqwest::Client) -> Result<usize> {
    let mut cams = Vec::new();
    let mut failed = None;
    // Chaque jeu à son tour : un jeu en panne ne retire pas l'autre.
    for (url, parse) in [(ORLEANS_URL, parse_orleans as fn(&[u8]) -> Result<Vec<OpenCam>>), (ANGLET_URL, parse_anglet)] {
        let result = async {
            let bytes = http.get(url).timeout(Duration::from_secs(30)).send().await?.error_for_status()?.bytes().await?;
            parse(&bytes)
        }
        .await;
        match result {
            Ok(found) => cams.extend(found),
            Err(error) => failed = Some(error),
        }
    }
    if let Some(error) = failed {
        // Une liste partielle ne remplace pas une liste complète déjà en mémoire.
        if OPEN.read().expect("verrou des webcams ouvertes").is_some() {
            return Err(error);
        }
        warn!("webcams ouvertes : un jeu manque : {error:#}");
    }
    let body = open_json(cams, Timestamp::now().as_second())?;
    let count = serde_json::from_slice::<serde_json::Value>(&body)?["webcams"].as_array().map_or(0, Vec::len);
    *OPEN.write().expect("verrou des webcams ouvertes") = Some(Bytes::from(body));
    Ok(count)
}

async fn open_forever(http: reqwest::Client) {
    loop {
        match open_once(&http).await {
            Ok(count) => {
                info!(webcams = count, "webcams ouvertes : lues");
                tokio::time::sleep(OPEN_EVERY).await;
            }
            Err(error) => {
                warn!("webcams ouvertes indisponibles : {error:#}");
                tokio::time::sleep(OPEN_RETRY).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Réponse de `GET /webcams/api/v3/webcams?include=location,urls` : la forme décrite par la documentation de
    /// Windy (WebcamsResponseDto : `total`, `webcams[]` avec `webcamId`, `title`, `status`, `location`, `urls`).
    const WINDY_LIST: &str = include_str!("testdata/windy_liste.json");
    /// Réponse de `GET /webcams/api/v3/webcams/{id}?include=images`.
    const WINDY_WEBCAM: &str = include_str!("testdata/windy_webcam.json");
    /// Trois caméras de la réponse réelle du WFS de la Métropole de Lyon, le 15 novembre 2026.
    const CRITER: &str = include_str!("testdata/criter_extrait.json");

    #[test]
    fn liste_windy_total_et_webcams_actives() {
        let (total, cams) = parse_list(WINDY_LIST.as_bytes()).unwrap();
        assert_eq!(total, 1283);
        // Trois webcams dans l'exemple : une désactivée (écartée), une sans position (écartée).
        assert_eq!(cams.len(), 1);
        let cam = &cams[0];
        assert_eq!(cam.id, 1179853135);
        assert_eq!(cam.title, "Lyon: Place Bellecour");
        assert_eq!(cam.city, "Lyon");
        assert!((cam.lon - 4.83259).abs() < 1e-9 && (cam.lat - 45.75788).abs() < 1e-9);
        assert_eq!(cam.detail, "https://webcams.windy.com/webcams/1179853135");
    }

    #[test]
    fn catalogue_sans_lien_dimage() {
        let (_, cams) = parse_list(WINDY_LIST.as_bytes()).unwrap();
        let json = String::from_utf8(catalog_json(&cams, 42)).unwrap();
        // Ni lien d'image ni jeton : le lien expire à 10 minutes, il n'est jamais gardé dans le catalogue.
        assert!(!json.contains("images") && !json.contains("token") && !json.contains("jpg"));
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["actif"], true);
        assert_eq!(value["webcams"][0][0], 1179853135u64);
        assert_eq!(install_catalog(json.into_bytes()).unwrap(), 1);
    }

    #[test]
    fn lien_dimage_petite_taille() {
        let link = parse_image_link(WINDY_WEBCAM.as_bytes()).unwrap();
        // `preview` (400 px) est préféré à `thumbnail` ; jamais une taille plus grande.
        assert!(link.contains("preview") && link.starts_with("https://imgproxy.windy.com/"));
    }

    #[test]
    fn lien_dimage_hors_de_windy_refuse() {
        let json = r#"{"webcamId":1,"title":"x","status":"active","images":{"current":{"preview":"https://exemple.org/a.jpg"}}}"#;
        assert!(parse_image_link(json.as_bytes()).is_err());
        let json = r#"{"webcamId":1,"title":"x","status":"active","images":{"current":{"preview":"http://imgproxy.windy.com/a.jpg"}}}"#;
        assert!(parse_image_link(json.as_bytes()).is_err());
        let json = r#"{"webcamId":1,"title":"x","status":"active","images":{"current":{"preview":"https://windy.com.exemple.org/a.jpg"}}}"#;
        assert!(parse_image_link(json.as_bytes()).is_err());
        // Miniature à défaut de preview.
        let json = r#"{"webcamId":1,"title":"x","status":"active","images":{"current":{"thumbnail":"https://imgproxy.windy.com/t.jpg"}}}"#;
        assert_eq!(parse_image_link(json.as_bytes()).unwrap(), "https://imgproxy.windy.com/t.jpg");
        assert!(parse_image_link(br#"{"webcamId":1,"title":"x","status":"active"}"#).is_err());
    }

    #[test]
    fn adresse_de_la_liste_par_rectangle() {
        let url = list_url((45.9, 6.1, 46.5, 7.0), 100);
        assert!(url.contains("bbox=46.5,7,45.9,6.1") && url.contains("offset=100") && url.contains("limit=50") && url.contains("countries=FR"));
        // La clé n'est jamais dans l'adresse (elle est dans l'en-tête `x-windy-api-key`).
        assert!(!url.to_lowercase().contains("key"));
    }

    #[test]
    fn criter_lecture_du_wfs() {
        let body = convert_criter(CRITER.as_bytes(), 1_700_000_000).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let cameras = json["cameras"].as_array().unwrap();
        // Trois caméras dans l'extrait, dont une dont l'image n'est pas hébergée par la Métropole (écartée).
        assert_eq!(cameras.len(), 2);
        assert_eq!(cameras[0][0], 219);
        assert_eq!(cameras[0][3], "Lyon - Perrache");
        assert_eq!(cameras[0][4], "Tunnel sous Fourvière");
        assert!((cameras[0][1].as_f64().unwrap() - 4.819782).abs() < 1e-6);
        assert_eq!(cameras[0][6], "https://download.data.grandlyon.com/files/rdata/pvo_patrimoine_voirie.pvocameracriter/CWL5801.JPG");
        // 2026-11-15T16:06:30+01:00 = 15:06:30 UTC.
        assert_eq!(cameras[0][7], "2026-11-15T15:06:30Z".parse::<Timestamp>().unwrap().as_second());
        assert_eq!(cameras[1][0], 220);
        assert!(convert_criter(br#"{"features":[]}"#, 0).is_err());
    }

    #[test]
    fn webcams_dorleans_touristiques_avec_position() {
        let cams = parse_orleans(include_str!("testdata/webcams_orleans_extrait.json").as_bytes()).unwrap();
        // Trois lignes : une webcam de déchèterie (sans position, écartée) et deux webcams touristiques.
        assert_eq!(cams.len(), 2);
        let beffroi = cams.iter().find(|c| c.name == "Beffroi").unwrap();
        assert_eq!(beffroi.page, "https://www.skaping.com/orleans/beffroi");
        assert_eq!(beffroi.source, "Orléans Métropole");
        assert!((beffroi.lon - 1.90606).abs() < 1e-9 && (beffroi.lat - 47.90034).abs() < 1e-9);
        assert_eq!(beffroi.town, "Orléans");
        assert!(cams.iter().all(|c| c.id >= 2000));
    }

    #[test]
    fn webcams_danglet_pages_viewsurf() {
        let cams = parse_anglet(include_str!("testdata/webcams_anglet_extrait.json").as_bytes()).unwrap();
        assert_eq!(cams.len(), 3);
        assert_eq!(cams[0].id, 1004);
        assert_eq!(cams[0].name, "Panoramique Sables d’Or – Marinella – Corsaires");
        assert!(cams[0].page.starts_with("https://pv.viewsurf.com/"));
        assert_eq!(cams[0].town, "Anglet");
        // Une page qui n'est pas en https n'est pas gardée.
        let json = r#"[{"ogc_fid":"9","nom":"x","lien":"http://exemple.org","geo_point_2d":{"lon":1.0,"lat":2.0}}]"#;
        assert!(parse_anglet(json.as_bytes()).unwrap().is_empty());
    }

    #[test]
    fn webcams_ouvertes_reponse_triee() {
        let mut cams = parse_orleans(include_str!("testdata/webcams_orleans_extrait.json").as_bytes()).unwrap();
        cams.extend(parse_anglet(include_str!("testdata/webcams_anglet_extrait.json").as_bytes()).unwrap());
        let json: serde_json::Value = serde_json::from_slice(&open_json(cams, 7).unwrap()).unwrap();
        let rows = json["webcams"].as_array().unwrap();
        assert_eq!(rows.len(), 5);
        assert!(rows.windows(2).all(|w| w[0][0].as_u64() < w[1][0].as_u64()));
        assert_eq!(rows[0][6], "Commune d'Anglet");
        assert!(open_json(Vec::new(), 0).is_err());
    }
}
