mod ai;
mod analyze;
mod approuting;
mod autostart;
mod audio;
mod eapo;
mod engine;
mod media;
mod musicbrainz;
mod rank;
mod spectrum;
mod spotify;
mod store;

use audio::{Device, Flow};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use store::Settings;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

struct AppState {
    settings: Mutex<Settings>,
}

#[derive(Serialize)]
struct EapoStatus {
    installed: bool,
    config_path: Option<String>,
    /// False means the config folder needs write permission granted to this user.
    writable: bool,
    /// Endpoints Equalizer APO is actually hooked into. EQ on anything else is silent.
    hooked_devices: usize,
    /// Whether this build carries the installer, or only a link to it.
    installer_bundled: bool,
    /// Whether there is an endpoint registry snapshot to restore from.
    has_backup: bool,
}

#[tauri::command]
fn list_devices() -> Vec<Device> {
    audio::list()
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// Persist settings and immediately regenerate the Equalizer APO config so the
/// change is audible before the call returns.
#[tauri::command]
fn save_settings(state: State<AppState>, settings: Settings) -> Result<String, String> {
    store::save(&settings)?;
    let devices = audio::list();
    let config = eapo::generate(&devices, &settings);
    *state.settings.lock().unwrap() = settings;
    let path = eapo::write(&config)?;
    Ok(path.display().to_string())
}

/// Propose a sensible priority order so the user does not have to drag thirty
/// endpoints into place by hand.
/// Hand a URL to the shell, for the "play something similar" picks.
///
/// The URL is built from a model reply, so the scheme is allowlisted:
/// `FileProtocolHandler` launches whatever a scheme is registered to, `file:`
/// included. `rundll32` is used rather than `cmd /C start` so nothing goes
/// through a shell parser on the way.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    shell_open(&url)
}

pub(crate) fn shell_open(url: &str) -> Result<(), String> {
    const ALLOWED: [&str; 3] = ["https://", "http://", "spotify:"];
    if !ALLOWED.iter().any(|s| url.starts_with(s)) {
        return Err(format!("Refusing to open {}", url.chars().take(40).collect::<String>()));
    }
    std::process::Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the link: {e}"))
}

#[tauri::command]
fn smart_organise() -> Vec<String> {
    rank::smart_order(&audio::list())
}

#[tauri::command]
fn set_default_device(id: String) -> Result<(), String> {
    audio::set_default(&id)
}

/// Every per-app rule Windows currently holds - ours and any set through its own
/// Volume mixer page. Reading its store rather than our settings is the only way
/// to show rules we did not write, and the only way to see that a write landed.
#[tauri::command]
fn list_app_rules() -> Vec<approuting::KnownRule> {
    approuting::known_rules()
}

/// Running executables, deduplicated - rules key on the file name, not the PID.
#[tauri::command]
fn list_processes() -> Vec<String> {
    let mut names: Vec<String> = approuting::processes().into_iter().map(|(_, e)| e).collect();
    names.sort();
    names.dedup();
    names
}

/// Drop a rule. Adding one goes through `save_settings` like every other setting
/// and the watcher applies it within the second; removing one cannot, because by
/// then there is no rule left to tell the watcher what to undo.
#[tauri::command]
fn clear_app_rule(exe: String, flow: Flow) -> Result<(), String> {
    let exe = exe.to_lowercase();
    let mut last = Ok(());
    for (pid, _) in approuting::processes().into_iter().filter(|(_, e)| *e == exe) {
        if let Err(e) = approuting::set_app_endpoint(pid, flow, None) {
            last = Err(e);
        }
    }
    last
}

/// Read from the registry rather than our settings, so a switch turned off in
/// Task Manager's Startup tab shows as off here too.
#[tauri::command]
fn autostart_enabled() -> bool {
    autostart::enabled()
}

#[tauri::command]
fn set_autostart(on: bool) -> Result<(), String> {
    autostart::set(on)
}

#[tauri::command]
fn eapo_status(app: AppHandle) -> EapoStatus {
    let path = eapo::config_path();
    let writable = path
        .as_ref()
        .and_then(|p| p.parent().map(probe_writable))
        .unwrap_or(false);
    EapoStatus {
        installed: path.is_some(),
        config_path: path.map(|p| p.display().to_string()),
        writable,
        hooked_devices: audio::list().iter().filter(|d| d.eapo).count(),
        installer_bundled: engine::bundled_installer(&app).is_some(),
        has_backup: engine::backup_exists(),
    }
}

/// Snapshot the endpoint registry, then hand off to Equalizer APO's installer.
#[tauri::command]
fn install_engine(app: AppHandle) -> Result<String, String> {
    engine::install(&app)
}

/// Equalizer APO's own device picker, for hooking an endpoint after the fact.
#[tauri::command]
fn open_configurator() -> Result<(), String> {
    engine::open_configurator()
}

/// Unhook every endpoint and restore the pre-install registry snapshot. The
/// escape hatch for an endpoint that went silent, not a normal uninstall.
#[tauri::command]
fn restore_audio_endpoints() -> Result<(), String> {
    engine::restore()
}

/// Equalizer APO lives under Program Files, so whether we can write its config
/// depends on the ACL its installer left behind. Find out by trying, once.
fn probe_writable(dir: &std::path::Path) -> bool {
    let probe = dir.join(".portal-write-probe");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Pick the highest-priority device that is actually present right now, skipping
/// the ones the user has switched off.
fn preferred<'a>(
    priority: &[String],
    ignored: &[String],
    devices: &'a [Device],
    flow: Flow,
) -> Option<&'a Device> {
    priority
        .iter()
        .filter(|id| !ignored.contains(id))
        .find_map(|id| {
            devices
                .iter()
                .find(|d| d.id == *id && d.flow == flow && d.present())
        })
}

/// Background watcher: notices hotplugs, enforces the priority list, keeps the
/// UI's device list fresh and re-points the spectrum at whatever is now default.
///
/// ponytail: 1 s poll instead of an IMMNotificationClient COM callback. Enumerating
/// ~30 endpoints costs microseconds and this avoids hand-rolling a COM sink with
/// its apartment-threading rules. Swap to the callback if 1 s ever feels slow.
fn watch(app: AppHandle, engine: spectrum::Engine) {
    std::thread::spawn(move || {
        let mut last_default_render = String::new();
        // (pid, device id) pairs already routed. Keyed on the device too, so
        // pointing an existing rule somewhere else re-applies it, and a recycled
        // PID belonging to a different rule is not mistaken for a done one.
        let mut routed: HashSet<(u32, String)> = HashSet::new();
        loop {
            let devices = audio::list();
            let settings = {
                let state = app.state::<AppState>();
                let s = state.settings.lock().unwrap();
                s.clone()
            };

            if settings.auto_switch {
                for flow in [Flow::Render, Flow::Capture] {
                    if let Some(want) = preferred(&settings.priority, &settings.ignored, &devices, flow) {
                        if !want.is_default {
                            match audio::set_default(&want.id) {
                                Ok(()) => {
                                    let _ = app.emit("switched", &want.clone());
                                }
                                Err(e) => {
                                    let _ = app.emit("error", &e);
                                }
                            }
                        }
                    }
                }
            }

            // Per-app rules. Windows remembers them by executable path, so each
            // process only has to be caught once - after that it re-applies the
            // rule itself on every later launch.
            if !settings.app_rules.is_empty() {
                let procs = approuting::processes();
                for rule in &settings.app_rules {
                    for (pid, _) in procs.iter().filter(|(_, exe)| *exe == rule.exe) {
                        let key = (*pid, rule.device_id.clone());
                        if !routed.insert(key) {
                            continue;
                        }
                        // Marked as done either way: an elevated process rejects
                        // the call permanently, and retrying it every second
                        // would be a toast per second.
                        if let Err(e) =
                            approuting::set_app_endpoint(*pid, rule.flow, Some(&rule.device_id))
                        {
                            let _ = app.emit("error", &format!("{}: {e}", rule.exe));
                        }
                    }
                }
            }

            // Loopback capture is bound to one endpoint; reopen it when the
            // default moves, or the bars would keep watching the old device.
            let current = devices
                .iter()
                .find(|d| d.flow == Flow::Render && d.is_default)
                .map(|d| d.id.clone())
                .unwrap_or_default();
            if current != last_default_render {
                last_default_render = current;
                engine.restart();
            }

            let _ = app.emit("devices", &devices);
            std::thread::sleep(Duration::from_millis(1000));
        }
    });
}

/// The running version, for the settings page to show next to the update check.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The new version if the release feed offers one, `None` if we are current.
///
/// Only a packaged build can update itself, so in `tauri dev` this reports the
/// updater as unavailable rather than pretending to be up to date.
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| u.version))
}

/// Download, install and restart into the new version.
///
/// Checks again rather than holding the handle from `check_update` across the
/// user's decision, so a stale check cannot install something else.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No update available")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = store::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            settings: Mutex::new(settings),
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            get_settings,
            save_settings,
            set_default_device,
            smart_organise,
            open_url,
            eapo_status,
            autostart_enabled,
            set_autostart,
            list_app_rules,
            list_processes,
            clear_app_rule,
            media::media_control,
            media::get_now_playing,
            ai::ai_chat,
            ai::ai_models,
            spotify::spotify_status,
            spotify::spotify_connect,
            spotify::spotify_disconnect,
            spotify::spotify_me,
            spotify::spotify_search,
            spotify::spotify_queue,
            spotify::spotify_play,
            musicbrainz::mb_search,
            app_version,
            check_update,
            install_update,
            install_engine,
            open_configurator,
            restore_audio_endpoints,
        ])
        // The window is the app's face, not the app: auto-switching, app rules
        // and the spectrum all need the process alive. Closing hides it unless
        // the user has asked for the other behaviour.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let tray = window
                    .app_handle()
                    .state::<AppState>()
                    .settings
                    .lock()
                    .unwrap()
                    .close_to_tray;
                if tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Write the config once at startup so the saved EQ is live even if
            // the window is never opened.
            {
                let state = app.state::<AppState>();
                let s = state.settings.lock().unwrap().clone();
                let _ = eapo::write(&eapo::generate(&audio::list(), &s));
            }

            let show = MenuItem::with_id(app, "show", "Show Portal Equalizer", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Portal Equalizer")
                .menu(&menu)
                .show_menu_on_left_click(false)
                // A hidden window and a menu that needs a right-click is a dead
                // end for anyone who left-clicks the tray icon expecting it back.
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // The window is declared hidden so that starting minimised does not
            // flash it on screen; every other launch shows it here instead.
            {
                let minimised = app.state::<AppState>().settings.lock().unwrap().start_minimised;
                if !minimised {
                    show_window(app.handle());
                }
            }

            let engine = spectrum::start(handle.clone());
            media::start(handle.clone());
            watch(handle, engine);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str, state: &'static str, flow: Flow) -> Device {
        Device {
            id: id.into(),
            name: "Headphones".into(),
            adapter: "Test".into(),
            flow,
            state,
            is_default: false,
            eapo: true,
            channels: 2,
            sample_rate: 48000,
            form_factor: 0,
            virtual_device: false,
            bluetooth: false,
            hands_free: false,
        }
    }

    #[test]
    fn priority_skips_absent_devices() {
        let devices = vec![
            dev("headset", "unplugged", Flow::Render),
            dev("z607", "active", Flow::Render),
            dev("monitor", "active", Flow::Render),
        ];
        let priority = vec!["headset".to_string(), "z607".into(), "monitor".into()];
        assert_eq!(
            preferred(&priority, &[], &devices, Flow::Render).unwrap().id,
            "z607",
            "top choice is unplugged, so the next present one wins"
        );
    }

    #[test]
    fn priority_does_not_cross_render_and_capture() {
        let devices = vec![dev("mic", "active", Flow::Capture)];
        let priority = vec!["mic".to_string()];
        assert!(preferred(&priority, &[], &devices, Flow::Render).is_none());
    }

    #[test]
    fn ignored_devices_never_win() {
        let devices = vec![
            dev("z607", "active", Flow::Render),
            dev("monitor", "active", Flow::Render),
        ];
        let priority = vec!["z607".to_string(), "monitor".into()];
        assert_eq!(
            preferred(&priority, &["z607".to_string()], &devices, Flow::Render)
                .unwrap()
                .id,
            "monitor",
            "the top choice is switched off, so the next one wins"
        );
    }

    #[test]
    fn nothing_present_means_no_switch() {
        let devices = vec![dev("a", "notpresent", Flow::Render)];
        assert!(preferred(&["a".to_string()], &[], &devices, Flow::Render).is_none());
    }
}

// --- exposed for examples/probe.rs only ---
#[doc(hidden)]
pub fn probe_devices() -> Vec<Device> {
    audio::list()
}
#[doc(hidden)]
pub fn probe_config() -> String {
    eapo::generate(&audio::list(), &store::load())
}
#[doc(hidden)]
pub fn probe_smart_order(d: &[Device]) -> Vec<String> {
    rank::smart_order(d)
}
#[doc(hidden)]
pub fn probe_app_routing() -> Result<(), String> {
    approuting::available()
}
#[doc(hidden)]
pub fn probe_app_rules() -> Vec<(String, String, String)> {
    approuting::known_rules()
        .into_iter()
        .map(|r| (r.exe, format!("{:?}", r.flow), r.device_id))
        .collect()
}
#[doc(hidden)]
pub fn probe_eapo_dir() -> Option<(String, bool)> {
    eapo::config_path().map(|p| {
        let w = p.parent().map(probe_writable).unwrap_or(false);
        (p.display().to_string(), w)
    })
}
