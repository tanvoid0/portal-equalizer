//! Spotify Web API - the only route that can actually *play* a suggestion.
//!
//! SMTC controls the session that already exists; it cannot put anything into
//! it. So "play something similar" needs the app's own API, which means a user
//! authorisation, which for a desktop app means Authorization Code with PKCE:
//! there is nowhere on a user's machine to keep a client secret.
//!
//! Two jobs beyond playback:
//!
//! * `search` resolves a model's suggestion to a real catalogue entry, which is
//!   what stops an invented B-side reaching the queue.
//! * the refresh token outlives the process, so connecting is a once-ever step.
//!   It is DPAPI-sealed rather than written flat: it is a long-lived credential
//!   to someone's account, sitting in a file anything on this machine can read.
//!
//! Dev Mode apps have been Premium-only since Spotify's February 2026 change,
//! and search there returns at most 10 results. Both are the caller's problem;
//! this module only reports what the API says.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API: &str = "https://api.spotify.com/v1";
/// Playing needs to know what is playing and to change it. Nothing else is
/// asked for, so nothing else can be done with the token if it leaks.
const SCOPES: &str = "user-read-playback-state user-modify-playback-state";
/// Spotify matches redirect URIs exactly, so the port cannot be picked at run
/// time - it has to be the one registered in the dashboard. 18410 is the Agent
/// Platform's, hence the next one up.
const PORT: u16 = 18411;
/// How long the browser has to come back before the listener gives up.
const AUTH_WAIT: Duration = Duration::from_secs(180);
const TIMEOUT: Duration = Duration::from_secs(20);
/// Refresh a little early: a token that expires mid-request is a failed queue.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{PORT}/callback")
}

/* ---------------------------------------------------------------- storage */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Stored {
    client_id: String,
    /// DPAPI ciphertext, base64. Empty means "not connected".
    refresh_sealed: String,
}

fn store_path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("PortalEqualizer").join("spotify.json")
}

fn read_store() -> Stored {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_store(s: &Stored) -> Result<(), String> {
    let p = store_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_string_pretty(s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/* -------------------------------------------------------------- live token */

struct Live {
    access: String,
    expires: Instant,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

fn cached() -> Option<String> {
    let live = LIVE.lock().unwrap();
    live.as_ref()
        .filter(|l| l.expires > Instant::now() + EXPIRY_MARGIN)
        .map(|l| l.access.clone())
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

/// A live access token, refreshing if the cached one is gone or stale.
async fn access_token() -> Result<String, String> {
    if let Some(t) = cached() {
        return Ok(t);
    }
    let stored = read_store();
    let refresh = crypto::unseal(&stored.refresh_sealed)
        .ok_or("Spotify is not connected. Connect it in settings.")?;
    let tokens = post_token(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
        ("client_id", stored.client_id.as_str()),
    ])
    .await?;
    // A refresh response may or may not carry a new refresh token; when it
    // does the old one is spent, so it has to be written back.
    if let Some(new) = tokens.refresh_token.clone().filter(|r| !r.is_empty()) {
        let mut s = read_store();
        s.refresh_sealed = crypto::seal(&new)?;
        write_store(&s)?;
    }
    Ok(remember(tokens))
}

fn remember(t: Tokens) -> String {
    let ttl = Duration::from_secs(t.expires_in.unwrap_or(3600));
    *LIVE.lock().unwrap() = Some(Live {
        access: t.access_token.clone(),
        expires: Instant::now() + ttl,
    });
    t.access_token
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

async fn post_token(form: &[(&str, &str)]) -> Result<Tokens, String> {
    let res = client()?
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("Could not reach Spotify: {e}"))?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        // A refresh token can be revoked from the account page, and then the
        // only cure is connecting again - so say that rather than the raw JSON.
        if status.as_u16() == 400 {
            forget();
            return Err("Spotify rejected the saved login. Connect it again.".into());
        }
        return Err(format!("Spotify returned {status}: {}", clip(&body)));
    }
    serde_json::from_str(&body).map_err(|e| format!("Unexpected token response: {e}"))
}

fn forget() {
    *LIVE.lock().unwrap() = None;
    let mut s = read_store();
    s.refresh_sealed.clear();
    let _ = write_store(&s);
}

fn clip(s: &str) -> String {
    s.chars().take(200).collect()
}

/* ------------------------------------------------------------ api requests */

async fn api(method: reqwest::Method, path: &str) -> Result<reqwest::Response, String> {
    let token = access_token().await?;
    client()?
        .request(method, format!("{API}{path}"))
        .bearer_auth(token)
        // The player writes take their arguments in the query string, and
        // Spotify still wants a length for a body-less POST/PUT.
        .header("Content-Length", "0")
        .send()
        .await
        .map_err(|e| format!("Could not reach Spotify: {e}"))
}

/// Turn a response into something a user can act on. The interesting case is
/// 404 - it does not mean "no such endpoint", it means Spotify has no device to
/// play on, which is the single most common way this fails.
fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    match status.as_u16() {
        401 => "Spotify rejected the login. Connect it again in settings.".into(),
        403 => "Spotify refused: playback control needs an active Premium subscription.".into(),
        404 => "No active Spotify device. Play something in Spotify first, then try again.".into(),
        429 => "Spotify is rate-limiting us. Wait a moment.".into(),
        _ => format!("Spotify returned {status}: {}", clip(body)),
    }
}

/* -------------------------------------------------------------- PKCE flow */

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Wait on the loopback redirect and hand back the query string.
///
/// Polled rather than blocking on `accept` so an abandoned sign-in cannot leave
/// a thread parked on the port for the life of the process.
fn await_callback(deadline: Instant) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", PORT))
        .map_err(|e| format!("Could not listen on 127.0.0.1:{PORT}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut sock, _)) => {
                sock.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let query = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|p| p.split_once('?').map(|(_, q)| q.to_string()));
                let page = if query.is_some() {
                    "Portal Equalizer is connected to Spotify. You can close this tab."
                } else {
                    "Waiting for the Spotify redirect."
                };
                let _ = sock.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                        page.len(),
                        page
                    )
                    .as_bytes(),
                );
                if let Some(q) = query {
                    return Ok(q);
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Timed out waiting for Spotify. Nothing was changed.".into())
}

fn param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

/// Just enough of a decoder for the values Spotify sends back.
fn percent_decode(s: &str) -> String {
    let bytes = s.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Percent-encode a query value. Shared with `musicbrainz`.
pub fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/* --------------------------------------------------------------- commands */

#[derive(Serialize)]
pub struct Status {
    pub connected: bool,
    pub client_id: String,
    /// Shown in settings so it can be pasted into the Spotify dashboard, which
    /// matches it character for character.
    pub redirect_uri: String,
    /// Display name of the connected account, when we have asked.
    pub name: String,
    /// "premium" or "free". Anything but premium cannot control playback.
    pub product: String,
}

fn status_of(name: String, product: String) -> Status {
    let s = read_store();
    Status {
        connected: !s.refresh_sealed.is_empty(),
        client_id: s.client_id,
        redirect_uri: redirect_uri(),
        name,
        product,
    }
}

/// Cheap: what is on disk, without touching the network.
#[tauri::command]
pub fn spotify_status() -> Status {
    status_of(String::new(), String::new())
}

/// Who we are connected as - also the connection test in settings.
#[tauri::command]
pub async fn spotify_me() -> Result<Status, String> {
    let res = api(reqwest::Method::GET, "/me").await?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(status_of(
        v["display_name"].as_str().unwrap_or_default().to_string(),
        v["product"].as_str().unwrap_or_default().to_string(),
    ))
}

/// Full sign-in: open the browser, wait on the loopback redirect, swap the code
/// for tokens and seal the refresh token.
#[tauri::command]
pub async fn spotify_connect(client_id: String) -> Result<Status, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("Paste the client ID from your Spotify app first.".into());
    }
    let verifier = crypto::random_token()?;
    let state = crypto::random_token()?;

    let url = format!(
        "{AUTH_URL}?client_id={}&response_type=code&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}&scope={}",
        urlencode(&client_id),
        urlencode(&redirect_uri()),
        urlencode(&challenge(&verifier)),
        urlencode(&state),
        urlencode(SCOPES),
    );

    let deadline = Instant::now() + AUTH_WAIT;
    // Bind before the browser opens, or a fast redirect finds nothing there.
    let waiting = tauri::async_runtime::spawn_blocking(move || await_callback(deadline));
    crate::shell_open(&url)?;

    let query = waiting
        .await
        .map_err(|e| format!("Sign-in thread failed: {e}"))??;

    if let Some(err) = param(&query, "error") {
        return Err(format!("Spotify sign-in was refused: {err}"));
    }
    // The state check is what stops anything else on this machine firing its
    // own redirect at the listener and planting a different account.
    if param(&query, "state").as_deref() != Some(state.as_str()) {
        return Err("Sign-in did not come back from the page we opened.".into());
    }
    let code = param(&query, "code").ok_or("Spotify sent no authorisation code.")?;

    let redirect = redirect_uri();
    let tokens = post_token(&[
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("client_id", client_id.as_str()),
        ("code_verifier", verifier.as_str()),
    ])
    .await?;

    let refresh = tokens
        .refresh_token
        .clone()
        .filter(|r| !r.is_empty())
        .ok_or("Spotify returned no refresh token.")?;
    write_store(&Stored {
        client_id,
        refresh_sealed: crypto::seal(&refresh)?,
    })?;
    remember(tokens);

    spotify_me().await
}

#[tauri::command]
pub fn spotify_disconnect() {
    forget();
}

#[derive(Serialize)]
pub struct Track {
    pub uri: String,
    pub title: String,
    pub artist: String,
    pub album: String,
}

/// One search. Dev Mode caps `limit` at 10, so the caller gets a short list and
/// decides for itself whether any of it is the track it asked for.
#[tauri::command]
pub async fn spotify_search(query: String, limit: Option<u8>) -> Result<Vec<Track>, String> {
    let limit = limit.unwrap_or(5).clamp(1, 10);
    let path = format!("/search?q={}&type=track&limit={limit}", urlencode(&query));
    let res = api(reqwest::Method::GET, &path).await?;
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v["tracks"]["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|t| {
                    Some(Track {
                        uri: t["uri"].as_str()?.to_string(),
                        title: t["name"].as_str().unwrap_or_default().to_string(),
                        artist: t["artists"][0]["name"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                        album: t["album"]["name"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

async fn player(method: reqwest::Method, path: &str) -> Result<(), String> {
    let res = api(method, path).await?;
    let status = res.status();
    if status.is_success() {
        return Ok(());
    }
    let body = res.text().await.unwrap_or_default();
    Err(api_error(status, &body))
}

/// Put a track after whatever is playing. Premium only, and there has to be a
/// device already awake for Spotify to queue onto.
#[tauri::command]
pub async fn spotify_queue(uri: String) -> Result<(), String> {
    player(
        reqwest::Method::POST,
        &format!("/me/player/queue?uri={}", urlencode(&uri)),
    )
    .await
}

/// Skip straight to it. Queue-then-next rather than `PUT /me/player/play`
/// because play with a bare `uris` list replaces the context outright, and
/// whatever album or playlist was running does not come back afterwards.
#[tauri::command]
pub async fn spotify_play(uri: String) -> Result<(), String> {
    spotify_queue(uri).await?;
    player(reqwest::Method::POST, "/me/player/next").await
}

/* ----------------------------------------------------------------- crypto */

/// Randomness and at-rest sealing, both from Windows' own providers - the
/// alternative is a crate for each and neither would do anything the platform
/// call does not.
mod crypto {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use base64::Engine as _;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        BCryptGenRandom, CryptProtectData, CryptUnprotectData, BCRYPT_ALG_HANDLE,
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, CRYPT_INTEGER_BLOB,
    };

    /// 32 bytes from the system CSPRNG, base64url'd - a valid PKCE verifier
    /// (43 chars, inside the 43-128 the spec allows) and a fine `state`.
    pub fn random_token() -> Result<String, String> {
        let mut bytes = [0u8; 32];
        unsafe {
            BCryptGenRandom(
                BCRYPT_ALG_HANDLE::default(),
                &mut bytes,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        }
            .ok()
            .map_err(|e| format!("Could not generate a login secret: {e}"))?;
        Ok(URL_SAFE_NO_PAD.encode(bytes))
    }

    fn blob(data: &mut [u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_mut_ptr(),
        }
    }

    /// Copy the output blob out and give its memory back.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(out.pbData as *mut _));
        v
    }

    /// DPAPI, scoped to this Windows user: the file stays readable, the token
    /// in it does not - not from another account here, not on another machine.
    pub fn seal(secret: &str) -> Result<String, String> {
        let mut input = secret.as_bytes().to_vec();
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&blob(&mut input), PCWSTR::null(), None, None, None, 0, &mut out)
                .map_err(|e| format!("Could not protect the Spotify token: {e}"))?;
            Ok(STANDARD.encode(take(out)))
        }
    }

    pub fn unseal(sealed: &str) -> Option<String> {
        if sealed.is_empty() {
            return None;
        }
        let mut input = STANDARD.decode(sealed).ok()?;
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&blob(&mut input), None, None, None, None, 0, &mut out).ok()?;
            String::from_utf8(take(out)).ok()
        }
    }
}
