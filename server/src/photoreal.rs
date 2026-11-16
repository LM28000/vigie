//! Vue photoréaliste : accès aux Google Photorealistic 3D Tiles par Cesium ion.
//!
//! Le jeton Cesium ion (`CESIUM_ION_TOKEN`) reste sur le serveur. Le navigateur demande `GET /api/photoreal/endpoint` ;
//! le serveur interroge `GET https://api.cesium.com/v1/assets/2275207/endpoint` (en-tête `Authorization: Bearer`) et ne
//! renvoie que ce dont le navigateur a besoin : l'adresse du jeu de tuiles (avec la clé de session que fournit ion, faite
//! pour aller au navigateur) et les mentions à afficher. Les tuiles elles-mêmes ne passent jamais par ici et ne sont pas
//! mises en cache : les conditions de Google l'interdisent, le navigateur les charge directement chez Google.
//!
//! La réponse de l'endpoint est gardée `CACHE` secondes, pour que dix visiteurs n'ouvrent pas dix sessions : une session
//! racine de Google est comptée à chaque appel de l'endpoint. Sans jeton : `503` avec une explication, que le site lit
//! pour griser le réglage.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn};

/// Google Photorealistic 3D Tiles, dans Cesium ion.
const ASSET: u32 = 2_275_207;
/// Durée de garde de la réponse de l'endpoint (une session racine par demi-heure et par instance, au plus).
const CACHE: Duration = Duration::from_secs(30 * 60);
/// Après un échec, on ne réinterroge pas ion avant ce délai (évite de marteler un service en panne).
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
struct IonEndpoint {
    #[serde(rename = "externalType")]
    external_type: Option<String>,
    #[serde(default)]
    attributions: Vec<Attribution>,
    options: Option<IonOptions>,
}

#[derive(Deserialize)]
struct IonOptions {
    url: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
struct Attribution {
    html: String,
    #[serde(default)]
    collapsible: bool,
}

/// Ce que reçoit le navigateur.
#[derive(Serialize)]
struct Endpoint {
    /// Adresse du `root.json` des tuiles, avec la clé de session d'ion.
    url: String,
    attributions: Vec<Attribution>,
    /// Durée pendant laquelle le navigateur peut garder cette réponse, en secondes.
    #[serde(rename = "validSeconds")]
    valid_seconds: u64,
}

enum Cached {
    Ok { body: String, at: Instant },
    Failed { at: Instant },
}

static STATE: Mutex<Option<Cached>> = Mutex::const_new(None);
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Le jeton, s'il est fourni. Il ne quitte jamais ce module.
fn ion_token() -> Option<String> {
    std::env::var("CESIUM_ION_TOKEN").ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

pub fn router(http: reqwest::Client) -> Router {
    let _ = CLIENT.set(http);
    if ion_token().is_none() {
        info!("vue photoréaliste : CESIUM_ION_TOKEN absent, réglage indisponible");
    }
    Router::new().route("/api/photoreal/endpoint", get(endpoint))
}

fn json(body: String, max_age: u64) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("application/json")),
            (header::CACHE_CONTROL, HeaderValue::from_str(&format!("private, max-age={max_age}")).expect("en-tête valide")),
        ],
        body,
    )
        .into_response()
}

async fn endpoint() -> Response {
    let Some(token) = ion_token() else {
        let body = r#"{"actif":false,"raison":"CESIUM_ION_TOKEN absent sur le serveur"}"#;
        return (StatusCode::SERVICE_UNAVAILABLE, [(header::CONTENT_TYPE, "application/json")], body).into_response();
    };
    // Un seul appel à ion à la fois : les demandes simultanées attendent et partagent le résultat.
    let mut state = STATE.lock().await;
    match state.as_ref() {
        Some(Cached::Ok { body, at }) if at.elapsed() < CACHE => {
            let left = (CACHE - at.elapsed()).as_secs().min(300);
            return json(body.clone(), left);
        }
        Some(Cached::Failed { at }) if at.elapsed() < RETRY_AFTER_ERROR => return unavailable(),
        _ => {}
    }
    let client = CLIENT.get().expect("client HTTP initialisé par router()");
    match fetch(client, &token).await {
        Ok(body) => {
            *state = Some(Cached::Ok { body: body.clone(), at: Instant::now() });
            json(body, 300)
        }
        Err(erreur) => {
            // Le message ne contient jamais le jeton : `fetch` ne renvoie que l'état HTTP ou la nature de l'erreur.
            warn!(%erreur, "vue photoréaliste : endpoint Cesium ion indisponible");
            *state = Some(Cached::Failed { at: Instant::now() });
            unavailable()
        }
    }
}

fn unavailable() -> Response {
    let body = r#"{"actif":false,"raison":"Cesium ion ne répond pas"}"#;
    (StatusCode::BAD_GATEWAY, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

async fn fetch(client: &reqwest::Client, token: &str) -> Result<String, String> {
    let response = client
        .get(format!("https://api.cesium.com/v1/assets/{ASSET}/endpoint"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("requête : {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("état HTTP {}", response.status()));
    }
    let text = response.text().await.map_err(|e| format!("lecture : {}", e.without_url()))?;
    transform(&text)
}

/// Extrait de la réponse d'ion l'adresse des tuiles et les mentions.
fn transform(text: &str) -> Result<String, String> {
    let ion: IonEndpoint = serde_json::from_str(text).map_err(|_| "réponse d'ion illisible".to_string())?;
    if ion.external_type.as_deref() != Some("3DTILES") {
        return Err("l'asset n'est pas un jeu de tuiles 3D externe".into());
    }
    let url = ion.options.and_then(|o| o.url).ok_or("pas d'adresse de tuiles dans la réponse")?;
    // Seul Google sert ces tuiles : on n'envoie pas au navigateur une adresse venue d'ailleurs.
    if !url.starts_with("https://tile.googleapis.com/") {
        return Err("adresse de tuiles inattendue".into());
    }
    let endpoint = Endpoint { url, attributions: ion.attributions, valid_seconds: CACHE.as_secs() };
    serde_json::to_string(&endpoint).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"externalType":"3DTILES","type":"3DTILES",
      "attributions":[{"html":"<span>Cesium ion</span>","collapsible":false},{"html":"<img alt=\"Google\">","collapsible":false}],
      "options":{"url":"https://tile.googleapis.com/v1/3dtiles/root.json?key=FAUSSE"}}"#;

    #[test]
    fn extrait_l_adresse_et_les_mentions() {
        let out: serde_json::Value = serde_json::from_str(&transform(SAMPLE).unwrap()).unwrap();
        assert_eq!(out["url"], "https://tile.googleapis.com/v1/3dtiles/root.json?key=FAUSSE");
        assert_eq!(out["attributions"].as_array().unwrap().len(), 2);
        assert_eq!(out["validSeconds"], 1800);
    }

    #[test]
    fn refuse_une_adresse_etrangere() {
        let evil = SAMPLE.replace("tile.googleapis.com", "example.org");
        assert!(transform(&evil).is_err());
    }

    #[test]
    fn refuse_un_autre_type() {
        assert!(transform(&SAMPLE.replace("\"externalType\":\"3DTILES\"", "\"externalType\":\"GEOJSON\"")).is_err());
        assert!(transform("pas du json").is_err());
    }
}
