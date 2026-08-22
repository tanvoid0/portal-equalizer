//! Persisted settings. One JSON file next to the app's config dir.

use crate::ai::AiConfig;
use crate::audio::Flow;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// "Spotify always plays to the Z607, whatever the system default is."
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRule {
    /// Lowercased executable file name, e.g. "spotify.exe". Matching on the
    /// full path breaks the moment an app self-updates into a new versioned
    /// folder - Spotify and Discord both do exactly that.
    pub exe: String,
    pub device_id: String,
    pub flow: Flow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DeviceEq {
    pub enabled: bool,
    /// User trim on top of the automatic clip-safe preamp.
    pub preamp: f32,
    /// Name of the preset the gains came from, or "Custom".
    pub preset: String,
    /// One gain per band in `eapo::BANDS`, in dB.
    pub gains: Vec<f32>,
}

impl Default for DeviceEq {
    fn default() -> Self {
        Self {
            enabled: true,
            preamp: 0.0,
            preset: "Flat".into(),
            gains: vec![0.0; 10],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Every known device id, most-wanted first. Outputs and inputs share one
    /// list because they can never compete: the winner is picked per flow, so
    /// a microphone can sit between two speakers without affecting either.
    #[serde(alias = "render_priority")]
    pub priority: Vec<String>,
    pub auto_switch: bool,
    /// Device ids the user has switched off: never auto-switched to, never
    /// given an Equalizer APO block, and hidden from the list by default.
    pub ignored: Vec<String>,
    /// device id -> its EQ.
    pub device_presets: HashMap<String, DeviceEq>,
    /// device id -> hand-corrected Equalizer APO `Device:` matcher, when the
    /// name we derive does not match what APO sees.
    pub eapo_match: HashMap<String, String>,
    /// Per-app routing. An app named here ignores the priority list entirely.
    pub app_rules: Vec<AppRule>,
    /// Agent Platform connection for AI preset suggestions. Off by default.
    pub ai: AiConfig,
    /// Show endpoints that are unplugged, disabled or absent. Off leaves the
    /// list holding only what you could actually play to right now.
    pub show_inactive: bool,
    /// Show software endpoints - Steam, Oculus, virtual cables.
    pub show_virtual: bool,
    /// "simple" shows a short curated catalogue, "advanced" shows all of it.
    pub preset_mode: String,
    /// Closing the window hides it to the tray instead of quitting. The app has
    /// to keep running for auto-switching and app rules to work at all.
    pub close_to_tray: bool,
    /// Start with no window, tray only - for launching at login.
    pub start_minimised: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            priority: Vec::new(),
            auto_switch: true,
            ignored: Vec::new(),
            device_presets: HashMap::new(),
            eapo_match: HashMap::new(),
            app_rules: Vec::new(),
            ai: AiConfig::default(),
            show_inactive: true,
            show_virtual: true,
            preset_mode: "advanced".into(),
            close_to_tray: true,
            start_minimised: false,
        }
    }
}

fn path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("PortalEqualizer").join("settings.json")
}

pub fn load() -> Settings {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(s: &Settings) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, serde_json::to_string_pretty(s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
