//! Per-app audio routing: "Spotify -> Z607", "Discord -> headset".
//!
//! Windows exposes this only through `IAudioPolicyConfigFactory`, a WinRT class
//! with no public header - the same one Settings > System > Sound > Volume mixer
//! drives. It is activated by class *name* rather than CLSID, and the method we
//! want sits behind twenty-two unrelated vtable slots. Provenance for the layout
//! is in `docs/per-app-routing.md`.
//!
//! The assignment persists per *executable path*, not per PID: catch a process
//! once and Windows re-applies the rule on every later launch by itself. Nothing
//! here has to keep re-asserting, which is why a 1 s poll is enough.

use crate::audio::Flow;
use serde::Serialize;
use std::ffi::c_void;
use windows::core::{HRESULT, HSTRING};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{eCapture, eConsole, eMultimedia, eRender, EDataFlow, ERole};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::WinRT::RoGetActivationFactory;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

/// Runtime class name. There is no CLSID for this - it must be activated
/// through `RoGetActivationFactory`, not `CoCreateInstance`.
const CLASS_NAME: &str = "Windows.Media.Internal.AudioPolicyConfig";

/// Prefix the endpoint id has to be wrapped in before the API accepts it.
const MMDEVAPI_TOKEN: &str = r"\\?\SWD#MMDEVAPI#";
const DEVINTERFACE_AUDIO_RENDER: &str = "{e6327cad-dcec-4949-ae8a-991e976a79d2}";
const DEVINTERFACE_AUDIO_CAPTURE: &str = "{2eef81be-33fa-4800-9670-1cd474972c3f}";

/// Where Windows persists the assignments. Read-only for us: the key names are
/// a hash we have no business reproducing, and the audio engine caches. Writes
/// go through the COM call.
const POLICY_STORE: &str =
    r"Software\Microsoft\Internet Explorer\LowRegistry\Audio\PolicyConfig\PropertyStore";

// ---------------------------------------------------------------------------
// The interface.
//
// It derives from IInspectable, not IUnknown. Rather than fight the macro over
// that, we inherit IUnknown and declare IInspectable's own three methods as the
// first padding slots - the vtable is identical either way, and we never call
// them. Then nineteen volume/ringer/chat methods that have nothing to do with
// routing, and only then the one we want. Every padding slot exists purely to
// land SetPersistedDefaultAudioEndpoint on the right offset.
// ---------------------------------------------------------------------------

#[windows::core::interface("ab3d4648-e242-459f-b02f-541c70306324")]
unsafe trait IAudioPolicyConfigFactory: windows::core::IUnknown {
    unsafe fn get_iids(&self) -> HRESULT;
    unsafe fn get_runtime_class_name(&self) -> HRESULT;
    unsafe fn get_trust_level(&self) -> HRESULT;
    unsafe fn add_ctx_volume_change(&self) -> HRESULT;
    unsafe fn remove_ctx_volume_changed(&self) -> HRESULT;
    unsafe fn add_ringer_vibrate_state_changed(&self) -> HRESULT;
    unsafe fn remove_ringer_vibrate_state_change(&self) -> HRESULT;
    unsafe fn set_volume_group_gain_for_id(&self) -> HRESULT;
    unsafe fn get_volume_group_gain_for_id(&self) -> HRESULT;
    unsafe fn get_active_volume_group_for_endpoint_id(&self) -> HRESULT;
    unsafe fn get_volume_groups_for_endpoint(&self) -> HRESULT;
    unsafe fn get_current_volume_context(&self) -> HRESULT;
    unsafe fn set_volume_group_mute_for_id(&self) -> HRESULT;
    unsafe fn get_volume_group_mute_for_id(&self) -> HRESULT;
    unsafe fn set_ringer_vibrate_state(&self) -> HRESULT;
    unsafe fn get_ringer_vibrate_state(&self) -> HRESULT;
    unsafe fn set_preferred_chat_application(&self) -> HRESULT;
    unsafe fn reset_preferred_chat_application(&self) -> HRESULT;
    unsafe fn get_preferred_chat_application(&self) -> HRESULT;
    unsafe fn get_current_chat_applications(&self) -> HRESULT;
    unsafe fn add_chat_context_changed(&self) -> HRESULT;
    unsafe fn remove_chat_context_changed(&self) -> HRESULT;
    /// `device_id` is an HSTRING handle. Null resets the process to the system
    /// default - that is the "clear rule" path, there is no separate call.
    unsafe fn set_persisted_default_audio_endpoint(
        &self,
        process_id: u32,
        flow: EDataFlow,
        role: ERole,
        device_id: *mut c_void,
    ) -> HRESULT;
}

/// Wrap an MMDevice endpoint id into the device-interface path the API wants.
/// The plain endpoint id is rejected.
fn device_interface_path(device_id: &str, flow: Flow) -> String {
    let iface = match flow {
        Flow::Render => DEVINTERFACE_AUDIO_RENDER,
        Flow::Capture => DEVINTERFACE_AUDIO_CAPTURE,
    };
    format!("{MMDEVAPI_TOKEN}{device_id}#{iface}")
}

fn factory() -> Result<IAudioPolicyConfigFactory, String> {
    crate::audio::com_init();
    unsafe { RoGetActivationFactory(&HSTRING::from(CLASS_NAME)) }
        .map_err(|e| format!("IAudioPolicyConfigFactory unavailable: {e}"))
}

/// Can this build of Windows route at all? Worth answering on its own before
/// assuming a failure to route is our fault. Activation only - it calls nothing,
/// so it changes nothing.
pub fn available() -> Result<(), String> {
    factory().map(|_| ())
}

/// Route one running process to `device_id`, or back to the system default when
/// it is `None`.
pub fn set_app_endpoint(pid: u32, flow: Flow, device_id: Option<&str>) -> Result<(), String> {
    let cfg = factory()?;
    let path = device_id.map(|id| device_interface_path(id, flow));
    let hs = match &path {
        Some(p) => HSTRING::from(p),
        // A null handle is what "use the system default" means here.
        None => HSTRING::new(),
    };
    let data_flow = match flow {
        Flow::Render => eRender,
        Flow::Capture => eCapture,
    };
    unsafe {
        // HSTRING is repr(transparent) over the handle and the vtable takes it
        // by value; copy the handle out rather than moving `hs` into the call,
        // so it is still freed when it drops.
        let handle: *mut c_void = std::mem::transmute_copy(&hs);
        // Both roles, every time. EarTrumpet does the same - setting only one
        // leaves half of an app's streams on the old endpoint.
        for role in [eMultimedia, eConsole] {
            let hr = cfg.set_persisted_default_audio_endpoint(pid, data_flow, role, handle);
            if hr.is_err() {
                return Err(format!(
                    "Could not route pid {pid} ({role:?}): {hr:?} - elevated processes reject this"
                ));
            }
        }
    }
    Ok(())
}

/// Every running process as (pid, lowercased exe file name).
///
/// ponytail: the whole process table, not just the ones holding an audio
/// session. One snapshot per second costs microseconds, and it lets a rule be
/// set for an app before it has ever made a sound. Swap to
/// IAudioSessionManager2 if the list ever needs to be only-things-audible.
pub fn processes() -> Vec<(u32, String)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let n = e
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(e.szExeFile.len());
                let name = String::from_utf16_lossy(&e.szExeFile[..n]).to_lowercase();
                if !name.is_empty() {
                    out.push((e.th32ProcessID, name));
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// A routing rule Windows currently holds, whoever set it - us, or the Volume
/// mixer page. Ground truth for "did that write land".
#[derive(Debug, Clone, Serialize)]
pub struct KnownRule {
    /// Lowercased exe file name, e.g. "spotify.exe".
    pub exe: String,
    /// Endpoint id, lowercased. Empty when the entry points at a raw bus path
    /// rather than an MMDEVAPI one, leaving no device to match it to.
    pub device_id: String,
    pub flow: Flow,
}

/// Split one PropertyStore value into (exe file name, endpoint id).
///
/// The value reads `<device path>|<NT path to the exe>%b<audio session guid>`.
///
/// Two shapes turn up in the device half. Rules we write carry the
/// `swd#mmdevapi#{0.0.0.00000000}.{guid}#{interface}` form we passed in, and the
/// endpoint id falls straight out of it. Rules Windows wrote itself carry the
/// underlying PnP path instead - `usb#vid_3206&pid_0861&mi_00#{kscategory}\
/// global/00010003` - which names an adapter and a pin, not an endpoint, and
/// mapping one back to an MMDevice id is guesswork. Those get an empty id: the
/// app is still worth showing, because a rule is why it ignores the priority
/// list, but we cannot say which device it points at.
///
/// An app half of bare `#` is not a per-app rule at all - it is Windows
/// recording a system-wide default - so it is dropped.
fn parse_entry(value: &str) -> Option<(String, String)> {
    let (device, app) = value.split_once('|')?;
    let path = app.split("%b").next().unwrap_or(app);
    let exe = path.rsplit(['\\', '/']).next()?.trim().to_lowercase();
    if !exe.ends_with(".exe") {
        return None;
    }
    let id = device
        .to_lowercase()
        .split_once("mmdevapi#")
        .and_then(|(_, rest)| rest.split('#').next().map(str::to_string))
        .unwrap_or_default();
    Some((exe, id))
}

/// Every rule Windows is holding, read straight out of its own store.
pub fn known_rules() -> Vec<KnownRule> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(store) = hkcu.open_subkey(POLICY_STORE) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in store.enum_keys().flatten() {
        // The key name is a hash with a flow suffix: _0 render, _1 capture.
        let flow = if name.ends_with("_1") {
            Flow::Capture
        } else {
            Flow::Render
        };
        let Ok(sub) = store.open_subkey(&name) else {
            continue;
        };
        let Ok(value) = sub.get_value::<String, _>("") else {
            continue;
        };
        if let Some((exe, device_id)) = parse_entry(&value) {
            out.push(KnownRule {
                exe,
                device_id,
                flow,
            });
        }
    }
    out.sort_by(|a, b| a.exe.cmp(&b.exe).then(a.device_id.cmp(&b.device_id)));
    out.dedup_by(|a, b| a.exe == b.exe && a.flow == b.flow && a.device_id == b.device_id);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_the_endpoint_id() {
        assert_eq!(
            device_interface_path("{0.0.0.00000000}.{5d686a6f}", Flow::Render),
            r"\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{5d686a6f}#{e6327cad-dcec-4949-ae8a-991e976a79d2}"
        );
        assert!(device_interface_path("x", Flow::Capture).ends_with(DEVINTERFACE_AUDIO_CAPTURE));
    }

    #[test]
    fn reads_an_mmdevapi_entry() {
        let v = concat!(
            r"{2}.\\?\swd#mmdevapi#{0.0.0.00000000}.{5d686a6f-1}",
            r"#{e6327cad-dcec-4949-ae8a-991e976a79d2}",
            r"|\Device\HarddiskVolume3\Users\me\Spotify.exe%b{00000000-0000-0000-0000-000000000000}"
        );
        assert_eq!(
            parse_entry(v),
            Some((
                "spotify.exe".to_string(),
                "{0.0.0.00000000}.{5d686a6f-1}".to_string()
            ))
        );
    }

    #[test]
    fn reads_an_entry_windows_wrote_itself() {
        // A real one off this machine: a PnP path, not an MMDEVAPI one, so
        // there is no endpoint id to recover. The app still counts as pinned.
        let v = concat!(
            r"{2}.\\?\bthenum#{0000110b-0000-1000-8000-00805f9b34fb}_vid&00010094_pid&0004",
            r"#{6994ad04-93ef-11d0-a3cc-00a0c9223196}\src/00010001",
            r"|\Device\HarddiskVolume3\Program Files\WindowsApps\SpotifyAB.SpotifyMusic",
            r"_1.294.583.0_x64__zpdnekdrzrea0\Spotify.exe%b{0}"
        );
        assert_eq!(parse_entry(v), Some(("spotify.exe".into(), String::new())));
    }

    #[test]
    fn ignores_values_that_are_not_per_app_rules() {
        assert!(parse_entry("").is_none());
        assert!(parse_entry("no pipe here").is_none());
        assert!(parse_entry(r"{2}.\\?\swd#mmdevapi#x|").is_none());
        // `#` in the app half means a system-wide default, not an app rule.
        let v = concat!(
            r"{2}.\\?\usb#vid_0b05&pid_1b9b&mi_00#{6994ad04-93ef-11d0-a3cc-00a0c9223196}",
            r"\waveout2/00010000|#%b{A9EF3FD9-4240-455E-A4D5-F2B3301887B2}"
        );
        assert!(parse_entry(v).is_none());
    }
}
