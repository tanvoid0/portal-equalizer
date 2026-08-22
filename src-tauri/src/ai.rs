//! Transport to an OpenAI-compatible chat endpoint - by default the local
//! Agent Platform (`http://127.0.0.1:18410`, `/v1/*` on the same process).
//!
//! Deliberately dumb: it moves strings. Prompt building and answer parsing live
//! in the frontend next to the preset table, so there is one copy of the preset
//! catalogue rather than two that drift.
//!
//! The call is made here rather than with `fetch` in the webview for one
//! reason: a browser request would need the platform to be started with
//! `AGENT_PLATFORM_CORS_ORIGINS` set for the Tauri origin. Server-side has no
//! such problem.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const DEFAULT_BASE: &str = "http://127.0.0.1:18410";
/// Local models can be slow on a cold load; bounded so the UI never hangs.
const TIMEOUT: Duration = Duration::from_secs(45);
/// Identifies us in the platform's request log.
const CLIENT_ID: &str = "portal-equalizer";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AiConfig {
    /// Host root, not a `/v1` path.
    pub base_url: String,
    pub model: String,
    /// Bearer credential. Prefer a workspace-scoped platform token (`agp_…`)
    /// over the master key. Empty falls back to `$AGENT_PLATFORM_TOKEN`, and
    /// with neither we send no header at all - which is what a default local
    /// install expects.
    pub token: String,
    /// Re-ask on its own when what is playing changes character.
    pub auto: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE.into(),
            model: String::new(),
            token: String::new(),
            auto: false,
        }
    }
}

fn base(cfg: &AiConfig) -> String {
    let b = cfg.base_url.trim().trim_end_matches('/');
    if b.is_empty() { DEFAULT_BASE.into() } else { b.into() }
}

fn token(cfg: &AiConfig) -> Option<String> {
    let from_cfg = cfg.token.trim();
    if !from_cfg.is_empty() {
        return Some(from_cfg.to_string());
    }
    std::env::var("AGENT_PLATFORM_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn request(cfg: &AiConfig, b: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    let b = b.header("X-Agent-Platform-Client", CLIENT_ID);
    match token(cfg) {
        Some(t) => b.bearer_auth(t),
        None => b,
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Turn transport and status failures into something a user can act on.
fn transport_error(base: &str, e: reqwest::Error) -> String {
    if e.is_connect() {
        format!("Could not reach {base}. Is Agent Platform running?")
    } else if e.is_timeout() {
        format!("{base} did not answer in time.")
    } else {
        format!("Request to {base} failed: {e}")
    }
}

fn status_error(status: reqwest::StatusCode, body: &str) -> String {
    match status.as_u16() {
        401 | 403 => "Agent Platform rejected the token (401/403).".into(),
        404 => "Not found (404). The base URL should be the host root, not a /v1 path.".into(),
        _ => format!("Agent Platform returned {status}: {}", body.chars().take(300).collect::<String>()),
    }
}

/// `GET /v1/models` - also the connection test in the AI settings panel.
#[tauri::command]
pub async fn ai_models(cfg: AiConfig) -> Result<Vec<String>, String> {
    let b = base(&cfg);
    let res = request(&cfg, client()?.get(format!("{b}/v1/models")))
        .send()
        .await
        .map_err(|e| transport_error(&b, e))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(status_error(status, &body));
    }
    let parsed: Value = serde_json::from_str(&body).map_err(|e| format!("Unexpected /v1/models response: {e}"))?;
    let mut ids: Vec<String> = parsed["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    ids.sort();
    if ids.is_empty() {
        return Err("Server returned no models.".into());
    }
    Ok(ids)
}

/// One non-streaming completion. Returns the assistant message verbatim.
#[tauri::command]
pub async fn ai_chat(cfg: AiConfig, system: String, user: String) -> Result<String, String> {
    if cfg.model.trim().is_empty() {
        return Err("Pick a model first.".into());
    }
    let b = base(&cfg);
    let body = serde_json::json!({
        "model": cfg.model.trim(),
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let res = request(&cfg, client()?.post(format!("{b}/v1/chat/completions")))
        .json(&body)
        .send()
        .await
        .map_err(|e| transport_error(&b, e))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(status_error(status, &text));
    }
    let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("Unexpected chat response: {e}"))?;
    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Model returned no content.".into())
}
