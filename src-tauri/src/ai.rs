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
    /// Override. Left empty we send no `model` at all and the platform routes
    /// to whatever its own config says, which is the answer that stays right
    /// when a provider is added or a key runs dry - this app has no business
    /// holding an opinion about which model answers.
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

/// Blank is off, not "try localhost anyway". The field carries one meaning
/// now that a blank *model* carries a different one, and a check that quietly
/// probed 18410 after the address was cleared would report a server the user
/// had just turned off.
fn base(cfg: &AiConfig) -> Result<String, String> {
    let b = cfg.base_url.trim().trim_end_matches('/');
    if b.is_empty() {
        return Err("No AI server set. Add one in Settings → AI.".into());
    }
    Ok(b.into())
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
    // A 403 is not necessarily ours. The platform is a proxy: an upstream
    // provider out of credit answers 403 too, and reading that as "bad token"
    // sends you to the one setting that was never wrong. Say what came back.
    match (status.as_u16(), upstream_message(body)) {
        (_, Some(m)) => format!("Agent Platform returned {status}: {m}"),
        (401 | 403, None) => "Agent Platform rejected the token (401/403).".into(),
        (404, None) => "Not found (404). The base URL should be the host root, not a /v1 path.".into(),
        _ => format!("Agent Platform returned {status}: {}", body.chars().take(300).collect::<String>()),
    }
}

/// The human-readable half of an error body, whichever shape it arrived in:
/// the platform's own `ApiError` (`message`), an upstream OpenAI-style
/// `{"error": {"message": ...}}`, or FastAPI's `detail`.
fn upstream_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    ["/error/message", "/message", "/detail", "/error"]
        .iter()
        .find_map(|p| v.pointer(p)?.as_str())
        .map(|m| m.trim().chars().take(300).collect())
        .filter(|m: &String| !m.is_empty())
}

/// One entry of `GET /v1/models`. The provider is the reason this is a struct
/// and not a string: the platform proxies several, and which one a model came
/// from is what decides whether it will answer - a key that has run out of
/// credit still lists all 783 of its models.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: String,
    /// `owned_by` from the response; empty when the server omits it.
    pub provider: String,
}

/// `GET /v1/models` - also the connection test in the AI settings panel.
#[tauri::command]
pub async fn ai_models(cfg: AiConfig) -> Result<Vec<AiModel>, String> {
    let b = base(&cfg)?;
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
    let mut models = parse_models(&parsed);
    // Provider first, so the picker's groups come out contiguous without the
    // frontend having to sort them again.
    models.sort_by(|a, b| (&a.provider, &a.id).cmp(&(&b.provider, &b.id)));
    if models.is_empty() {
        return Err("Server returned no models.".into());
    }
    Ok(models)
}

fn parse_models(parsed: &Value) -> Vec<AiModel> {
    parsed["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(AiModel {
                        id: m["id"].as_str()?.to_string(),
                        provider: m["owned_by"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The completion request. `temperature` stays ours - it is a property of this
/// request, parse one preset name out of a short reply - but the model is not:
/// a blank one is *omitted*, and the platform reads a missing `model` as "use
/// the configured default". Sent as `""` it would be forwarded upstream.
fn chat_body(model: &str, system: &str, user: &str) -> Value {
    let mut body = serde_json::json!({
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
    });
    let model = model.trim();
    if !model.is_empty() {
        body["model"] = serde_json::json!(model);
    }
    body
}

/// One non-streaming completion. Returns the assistant message verbatim.
#[tauri::command]
pub async fn ai_chat(cfg: AiConfig, system: String, user: String) -> Result<String, String> {
    let b = base(&cfg)?;
    let body = chat_body(&cfg.model, &system, &user);
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

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    /// The bug this replaced: an upstream out of credit answers 403, and the
    /// old arm reported it as a rejected token.
    #[test]
    fn an_upstream_403_reports_the_upstream_reason() {
        let body = r#"{"title":"Forbidden","status":403,"message":"You've run out of funds.","error":{"name":"ForbiddenException","message":"You've run out of funds."}}"#;
        let msg = status_error(StatusCode::FORBIDDEN, body);
        assert!(msg.contains("run out of funds"), "{msg}");
        assert!(!msg.contains("token"), "{msg}");
    }

    /// Blank address is the off switch, and has to fail before any request.
    #[test]
    fn a_blank_base_url_is_off() {
        let off = AiConfig { base_url: "  ".into(), ..AiConfig::default() };
        assert!(base(&off).is_err());
        let on = AiConfig { base_url: "http://host:1/".into(), ..AiConfig::default() };
        assert_eq!(base(&on).unwrap(), "http://host:1", "the trailing slash goes");
    }

    /// The whole point of holding no default: a blank model means the platform
    /// picks, so the field has to be absent rather than empty.
    #[test]
    fn a_blank_model_is_left_out_of_the_body() {
        let body = chat_body("  ", "sys", "usr");
        assert!(body.get("model").is_none(), "{body}");
        assert_eq!(chat_body(" gpt-4 ", "sys", "usr")["model"], "gpt-4");
    }

    /// A bare 401 with nothing to quote still has to name the likely cause.
    #[test]
    fn a_bodiless_401_still_blames_the_token() {
        assert!(status_error(StatusCode::UNAUTHORIZED, "").contains("token"));
        assert!(status_error(StatusCode::NOT_FOUND, "<html>").contains("host root"));
    }

    /// The picker groups on `provider`, so an entry that lost it lands in an
    /// "unknown" bucket rather than being dropped - and a row with no `id` at
    /// all is not a model.
    #[test]
    fn models_keep_their_provider() {
        let parsed = serde_json::json!({"data": [
            {"id": "b", "object": "model", "owned_by": "ollama"},
            {"id": "a", "object": "model", "owned_by": "aimlapi"},
            {"id": "c", "object": "model"},
            {"object": "model", "owned_by": "aimlapi"},
        ]});
        let got = parse_models(&parsed);
        assert_eq!(got.len(), 3, "the id-less row is not a model");
        assert_eq!(got[0].provider, "ollama");
        assert_eq!(got[2].provider, "", "a missing owned_by is empty, not a panic");
    }

    #[test]
    fn every_error_shape_yields_its_message() {
        for body in [
            r#"{"error":{"message":"upstream said no"}}"#,
            r#"{"message":"upstream said no"}"#,
            r#"{"detail":"upstream said no"}"#,
            r#"{"error":"upstream said no"}"#,
        ] {
            assert_eq!(upstream_message(body).as_deref(), Some("upstream said no"), "{body}");
        }
        assert_eq!(upstream_message("not json"), None);
        assert_eq!(upstream_message(r#"{"message":"   "}"#), None);
        assert_eq!(upstream_message(r#"{"message":404}"#), None);
    }
}
