//! MusicBrainz lookup - the no-account half of "does this track exist".
//!
//! A model will happily name a plausible B-side that was never released, and
//! without Spotify connected there is nothing else here that could tell. This
//! is the open database that can: no key, no account, no Premium.
//!
//! It returns the same shape as `spotify::search` so one matcher in the
//! frontend judges both; the URI is empty because there is nothing to play,
//! only something to confirm.

use crate::spotify::{urlencode, Track};
use tauri::async_runtime::Mutex;
use std::time::{Duration, Instant};

const ENDPOINT: &str = "https://musicbrainz.org/ws/2/recording";
/// MusicBrainz asks anonymous clients to identify themselves and blocks the
/// ones that do not.
const AGENT: &str = concat!(
    "PortalEqualizer/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/portal-equalizer )"
);
/// Their published ceiling is one request a second, averaged. Going over gets
/// the IP throttled, so the gate below is not optional politeness.
const MIN_GAP: Duration = Duration::from_millis(1100);
const TIMEOUT: Duration = Duration::from_secs(15);

/// Async so callers queue on the gate rather than hammering past it; held
/// across the request itself, which is what makes the spacing real.
static GATE: Mutex<Option<Instant>> = Mutex::const_new(None);

/// Recordings matching a title and artist, best first.
///
/// A lookup that fails is not the same as a track that does not exist, so
/// transport failures come back as an error and the caller can decline to
/// judge rather than throw away a real suggestion.
#[tauri::command]
pub async fn mb_search(title: String, artist: String) -> Result<Vec<Track>, String> {
    let query = format!(
        "recording:{} AND artist:{}",
        lucene(&title),
        lucene(&artist)
    );
    let url = format!(
        "{ENDPOINT}?query={}&fmt=json&limit=5",
        urlencode(&query)
    );

    let mut gate = GATE.lock().await;
    if let Some(last) = *gate {
        let since = last.elapsed();
        if since < MIN_GAP {
            tokio::time::sleep(MIN_GAP - since).await;
        }
    }

    let res = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(AGENT)
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not reach MusicBrainz: {e}"))?;
    *gate = Some(Instant::now());
    drop(gate);

    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("MusicBrainz returned {status}."));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v["recordings"]
        .as_array()
        .map(|rs| {
            rs.iter()
                .map(|r| Track {
                    uri: String::new(),
                    title: r["title"].as_str().unwrap_or_default().to_string(),
                    artist: r["artist-credit"][0]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    album: r["releases"][0]["title"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Quote a value for a Lucene field query. An unescaped `:` or `"` in a title
/// does not just fail to match, it makes the whole query invalid.
fn lucene(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "").replace('"', ""))
}
