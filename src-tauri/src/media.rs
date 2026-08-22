//! Now playing metadata and transport control, from the same Windows session
//! manager (SMTC) that fills the media flyout above the volume overlay.
//!
//! Everything here runs on one dedicated thread in a *multithreaded* apartment.
//! The WinRT calls below are async, we block on them with `.get()`, and that is
//! illegal from an STA - which is what Tauri's command threads become once
//! `audio.rs` has done its MMDevice work on them. So commands are posted to
//! this thread over a channel rather than run on the caller's.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as Props,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Media::MediaPlaybackAutoRepeatMode as Repeat;
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};

/// ponytail: polled, like the device watcher, rather than wired to
/// MediaPropertiesChanged / PlaybackInfoChanged. Reading four properties costs
/// microseconds and this avoids a WinRT delegate per session plus the
/// re-subscribe dance every time the current session changes. Move to the
/// events if 500 ms ever feels late on a track change.
const TICK: Duration = Duration::from_millis(500);

/// Cover art is base64'd into the webview, so refuse an absurd one rather than
/// push a 40 MB string over IPC.
const MAX_ART: u64 = 4 << 20;

#[derive(Serialize, Clone, Default, PartialEq)]
pub struct NowPlaying {
    playing: bool,
    title: String,
    artist: String,
    album: String,
    /// The app the audio belongs to, e.g. "Spotify".
    app: String,
    position_ms: u64,
    duration_ms: u64,
    can_next: bool,
    can_prev: bool,
    can_seek: bool,
    can_shuffle: bool,
    can_repeat: bool,
    shuffle: bool,
    /// "none" | "track" | "list".
    repeat: &'static str,
    /// Identifies the track the cover belongs to. Art arrives separately on
    /// `now_playing_art`, and only when this changes.
    art_key: String,
    /// Every app currently holding a media session, so the player can be
    /// pointed at one instead of following whatever Windows last focused.
    sources: Vec<Source>,
    /// The AUMID of the session these fields describe.
    source_id: String,
    /// True when we are following this app because the user said so, rather
    /// than because Windows currently considers it foremost.
    pinned: bool,
    /// Output volume of the default render endpoint, 0..1, and its mute state.
    /// Not session state, but it is the knob people reach for from a player.
    volume: f32,
    muted: bool,
}

#[derive(Serialize, Clone, Default, PartialEq)]
pub struct Source {
    id: String,
    app: String,
    playing: bool,
}

#[derive(Serialize, Clone)]
struct Art {
    key: String,
    /// `data:` URI, or null when the session has no thumbnail.
    data: Option<String>,
}

pub enum Cmd {
    PlayPause,
    Next,
    Prev,
    /// Milliseconds from the start of the track.
    Seek(i64),
    Shuffle(bool),
    Repeat(u8),
    /// Follow this app's session. Empty string goes back to following Windows.
    Pin(String),
    /// 0..1 on the default output.
    Volume(f32),
    Mute(bool),
}

static TX: OnceLock<Sender<Cmd>> = OnceLock::new();

/// Latest snapshot, for whoever asks late. Events alone are not enough: we only
/// emit on change, and plenty of apps (Chrome, most browsers) push a timeline
/// once and then sit on it, so a window opened afterwards would hear nothing at
/// all until the track changed.
static LATEST: Mutex<Option<Current>> = Mutex::new(None);

#[derive(Serialize, Clone)]
pub struct Current {
    #[serde(flatten)]
    np: NowPlaying,
    /// Cover art `data:` URI, so one call fills the whole player.
    art: Option<String>,
}

#[tauri::command]
pub fn get_now_playing() -> Option<Current> {
    LATEST.lock().unwrap().clone()
}

#[tauri::command]
pub fn media_control(action: String, value: Option<f64>, id: Option<String>) -> Result<(), String> {
    let v = value.unwrap_or(0.0);
    let cmd = match action.as_str() {
        "play_pause" => Cmd::PlayPause,
        "next" => Cmd::Next,
        "prev" => Cmd::Prev,
        "seek" => Cmd::Seek(v as i64),
        "shuffle" => Cmd::Shuffle(v != 0.0),
        "repeat" => Cmd::Repeat(v as u8),
        "pin" => Cmd::Pin(id.unwrap_or_default()),
        "volume" => Cmd::Volume(v as f32),
        "mute" => Cmd::Mute(v != 0.0),
        other => return Err(format!("unknown media action: {other}")),
    };
    TX.get()
        .ok_or("media thread is not running")?
        .send(cmd)
        .map_err(|_| "media thread has gone away".to_string())
}

/// Watch the current session and emit `now_playing` (metadata, on every change)
/// and `now_playing_art` (cover, only when the track changes).
pub fn start(app: AppHandle) {
    let (tx, rx) = channel();
    let _ = TX.set(tx);

    std::thread::spawn(move || {
        unsafe {
            // Blocking on WinRT async needs an MTA. Never make this thread STA.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        let mut manager: Option<Manager> = None;
        let mut last: Option<NowPlaying> = None;
        let mut art_key = String::new();
        let mut art_data: Option<String> = None;
        let mut pinned = String::new();

        loop {
            // Doubles as the poll timer and the command inbox, so a button
            // press is acted on immediately instead of at the next tick.
            let cmd = match rx.recv_timeout(TICK) {
                Ok(c) => Some(c),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };

            // The service can be unavailable just after login; keep asking.
            if manager.is_none() {
                manager = Manager::RequestAsync().and_then(|op| op.get()).ok();
            }

            if let Some(Cmd::Pin(id)) = cmd.as_ref() {
                pinned = id.clone();
            }

            let found = manager.as_ref().and_then(|m| sessions(m, &pinned));
            let Some((session, sources)) = found else {
                if last.take().is_some() {
                    art_key.clear();
                    art_data = None;
                    *LATEST.lock().unwrap() = None;
                    let _ = app.emit("now_playing", None::<NowPlaying>);
                }
                continue;
            };

            if let Some(c) = cmd {
                if let Err(e) = apply(&session, c) {
                    let _ = app.emit("error", &format!("Media control failed: {}", e.message()));
                }
            }

            let Ok((mut np, props)) = snapshot(&session) else {
                continue;
            };
            np.sources = sources;
            np.pinned = pinned == np.source_id && !pinned.is_empty();
            (np.volume, np.muted) = level();

            if np.art_key != art_key {
                art_key.clone_from(&np.art_key);
                art_data = props.Thumbnail().ok().and_then(|t| read_art(&t));
                let _ = app.emit(
                    "now_playing_art",
                    Art {
                        key: art_key.clone(),
                        data: art_data.clone(),
                    },
                );
            }
            if last.as_ref() != Some(&np) {
                *LATEST.lock().unwrap() = Some(Current {
                    np: np.clone(),
                    art: art_data.clone(),
                });
                let _ = app.emit("now_playing", &np);
                last = Some(np);
            }
        }
    });
}

/// Every session, plus the one to drive: the pinned app if it still has one,
/// otherwise whatever Windows currently considers foremost.
fn sessions(m: &Manager, pinned: &str) -> Option<(Session, Vec<Source>)> {
    let all = m.GetSessions().ok()?;
    let mut sources = Vec::new();
    let mut chosen = None;
    for i in 0..all.Size().ok()? {
        let Ok(s) = all.GetAt(i) else { continue };
        let Ok(id) = s.SourceAppUserModelId() else {
            continue;
        };
        let id = id.to_string();
        let playing = s
            .GetPlaybackInfo()
            .and_then(|i| i.PlaybackStatus())
            .map(|st| st == Status::Playing)
            .unwrap_or(false);
        if id == pinned {
            chosen = Some(s);
        }
        sources.push(Source {
            app: app_name(&id),
            id,
            playing,
        });
    }
    let session = chosen.or_else(|| m.GetCurrentSession().ok())?;
    Some((session, sources))
}

/// Master volume of the default output. Acquired per read rather than cached,
/// because the default endpoint moves under us every time the priority list
/// switches devices, and a stale interface silently controls the old one.
fn endpoint() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        devices
            .GetDefaultAudioEndpoint(eRender, eMultimedia)?
            .Activate(CLSCTX_ALL, None)
    }
}

fn level() -> (f32, bool) {
    endpoint()
        .and_then(|v| unsafe { Ok((v.GetMasterVolumeLevelScalar()?, v.GetMute()?.as_bool())) })
        .unwrap_or((0.0, false))
}

fn apply(s: &Session, cmd: Cmd) -> windows::core::Result<()> {
    match cmd {
        Cmd::Pin(_) => {}
        Cmd::Volume(v) => unsafe {
            endpoint()?.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), std::ptr::null())?;
        },
        Cmd::Mute(on) => unsafe {
            endpoint()?.SetMute(on, std::ptr::null())?;
        },
        Cmd::PlayPause => {
            s.TryTogglePlayPauseAsync()?.get()?;
        }
        Cmd::Next => {
            s.TrySkipNextAsync()?.get()?;
        }
        Cmd::Prev => {
            s.TrySkipPreviousAsync()?.get()?;
        }
        // Positions are absolute on the session's own timeline, and that does
        // not have to start at zero (chapters, podcast segments).
        Cmd::Seek(ms) => {
            let start = s.GetTimelineProperties()?.StartTime()?.Duration;
            s.TryChangePlaybackPositionAsync(start + ms * 10_000)?.get()?;
        }
        Cmd::Shuffle(on) => {
            s.TryChangeShuffleActiveAsync(on)?.get()?;
        }
        Cmd::Repeat(mode) => {
            s.TryChangeAutoRepeatModeAsync(repeat_from(mode))?.get()?;
        }
    }
    Ok(())
}

fn snapshot(s: &Session) -> windows::core::Result<(NowPlaying, Props)> {
    let props = s.TryGetMediaPropertiesAsync()?.get()?;
    let info = s.GetPlaybackInfo()?;
    let ctl = info.Controls()?;
    let time = s.GetTimelineProperties()?;
    let start = time.StartTime()?.Duration;
    let playing = info.PlaybackStatus()? == Status::Playing;
    let duration = ms(time.EndTime()?.Duration - start);

    let title = props.Title()?.to_string();
    let artist = props.Artist()?.to_string();
    let album = props.AlbumTitle()?.to_string();
    let source_id = s.SourceAppUserModelId()?.to_string();

    Ok((
        NowPlaying {
            playing,
            art_key: format!("{title}\u{1}{artist}\u{1}{album}"),
            title,
            artist,
            album,
            app: app_name(&source_id),
            source_id,
            // Filled in by the caller, which is the one that enumerated them.
            sources: Vec::new(),
            pinned: false,
            volume: 0.0,
            muted: false,
            position_ms: live_position(
                ms(time.Position()?.Duration - start),
                ms(now() - time.LastUpdatedTime()?.UniversalTime),
                duration,
                playing,
            ),
            duration_ms: duration,
            can_next: ctl.IsNextEnabled().unwrap_or(false),
            can_prev: ctl.IsPreviousEnabled().unwrap_or(false),
            can_seek: ctl.IsPlaybackPositionEnabled().unwrap_or(false),
            can_shuffle: ctl.IsShuffleEnabled().unwrap_or(false),
            can_repeat: ctl.IsRepeatEnabled().unwrap_or(false),
            shuffle: info
                .IsShuffleActive()
                .and_then(|r| r.Value())
                .unwrap_or(false),
            repeat: repeat_name(
                info.AutoRepeatMode()
                    .and_then(|r| r.Value())
                    .unwrap_or(Repeat::None),
            ),
        },
        props,
    ))
}

/// Thumbnails come back as a stream, not as bytes; a `data:` URI is the
/// shortest route into an `<img>` without opening the asset protocol up to
/// arbitrary files.
fn read_art(r: &IRandomAccessStreamReference) -> Option<String> {
    let stream = r.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?.min(MAX_ART) as u32;
    if size == 0 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;

    let mime = stream
        .ContentType()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let mime = if mime.starts_with("image/") {
        mime
    } else {
        "image/jpeg".into()
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(&bytes)))
}

/// `Position` is a stamp taken at `LastUpdatedTime`, not a running clock, and
/// apps differ wildly in how often they refresh it - Chrome will happily leave
/// one sitting for minutes while the video plays on. Age it forward so the
/// number we report is where playback actually is, which is also what the skip
/// buttons then seek relative to.
///
/// A missing or nonsense `LastUpdatedTime` shows up as an age longer than the
/// track itself; leave the stamp alone rather than fling the position to the end.
fn live_position(stamp_ms: u64, age_ms: u64, duration_ms: u64, playing: bool) -> u64 {
    if !playing || age_ms >= duration_ms.max(1) {
        return stamp_ms.min(duration_ms.max(stamp_ms));
    }
    (stamp_ms + age_ms).min(duration_ms)
}

/// Now, as a FILETIME: 100 ns ticks since 1601, the epoch WinRT `DateTime` uses.
fn now() -> i64 {
    const UNIX_EPOCH_IN_FILETIME: i64 = 116_444_736_000_000_000;
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.as_nanos() / 100) as i64 + UNIX_EPOCH_IN_FILETIME)
        .unwrap_or(0)
}

/// WinRT time is 100 ns ticks, and a session that has not started yet can
/// report a position before its own start time.
fn ms(ticks: i64) -> u64 {
    (ticks.max(0) / 10_000) as u64
}

/// Source ids arrive either as "Spotify.exe" or as a packaged AUMID like
/// "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic". Neither is
/// something a person wants to read under a track title.
fn app_name(aumid: &str) -> String {
    let s = aumid.rsplit('!').next().unwrap_or(aumid);
    let s = s.split('_').next().unwrap_or(s);
    let s = s.strip_suffix(".exe").unwrap_or(s);
    s.rsplit('.').next().unwrap_or(s).to_string()
}

fn repeat_name(mode: Repeat) -> &'static str {
    match mode {
        Repeat::Track => "track",
        Repeat::List => "list",
        _ => "none",
    }
}

fn repeat_from(mode: u8) -> Repeat {
    match mode {
        1 => Repeat::Track,
        2 => Repeat::List,
        _ => Repeat::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_names_are_readable() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("chrome.exe"), "chrome");
        assert_eq!(
            app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"),
            "ZuneMusic"
        );
        assert_eq!(app_name(""), "");
    }

    #[test]
    fn negative_positions_clamp_to_zero() {
        assert_eq!(ms(-5_000_000), 0, "position before the timeline start");
        assert_eq!(ms(1_234 * 10_000), 1_234);
    }

    /// Diagnostic against whatever is really playing right now:
    /// `cargo test -- --ignored --nocapture live_session`
    #[test]
    #[ignore = "needs a live media session"]
    fn live_session() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let manager = Manager::RequestAsync().unwrap().get().unwrap();
        let session = manager.GetCurrentSession().expect("nothing is playing");
        let (np, props) = snapshot(&session).unwrap();
        let art = props.Thumbnail().ok().and_then(|t| read_art(&t));
        println!(
            "{} - {} [{}] via {} | {}/{} ms | playing={} shuffle={} repeat={} art={} bytes",
            np.artist,
            np.title,
            np.album,
            np.app,
            np.position_ms,
            np.duration_ms,
            np.playing,
            np.shuffle,
            np.repeat,
            art.map(|a| a.len()).unwrap_or(0),
        );
    }

    #[test]
    fn position_is_aged_forward_from_its_stamp() {
        // Chrome stamped 30 s into a 3 min track and then went quiet for 45 s.
        assert_eq!(live_position(30_000, 45_000, 180_000, true), 75_000);
        // Paused: the stamp is the truth, however old it is.
        assert_eq!(live_position(30_000, 45_000, 180_000, false), 30_000);
        // Never past the end of the track.
        assert_eq!(live_position(170_000, 20_000, 180_000, true), 180_000);
        // Garbage LastUpdatedTime (age dwarfs the track) leaves the stamp be.
        assert_eq!(live_position(30_000, 9_000_000_000, 180_000, true), 30_000);
        // No duration reported at all (live stream): still no wild jump.
        assert_eq!(live_position(30_000, 5_000, 0, true), 30_000);
    }

    #[test]
    fn filetime_now_is_in_this_century() {
        // 2020-01-01 and 2200-01-01 as FILETIME.
        assert!((132_223_104_000_000_000..190_000_000_000_000_000).contains(&now()));
    }

    #[test]
    fn repeat_round_trips_through_the_wire_value() {
        for (n, name) in [(0u8, "none"), (1, "track"), (2, "list")] {
            assert_eq!(repeat_name(repeat_from(n)), name);
        }
        assert_eq!(repeat_name(repeat_from(9)), "none", "unknown mode is off");
    }
}
