//! Windows audio endpoint enumeration and default-device control.
//!
//! COM (MMDeviceEnumerator) gives us the authoritative device list, state and
//! current default. Everything else - channel count, Equalizer APO presence -
//! is cheaper to read straight out of the MMDevices registry hive than to coax
//! out of a property store, so we do that.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use windows::core::{GUID, HSTRING, PCWSTR};
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eMultimedia, eRender, ERole, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE, DEVICE_STATE_DISABLED,
    DEVICE_STATE_NOTPRESENT, DEVICE_STATE_UNPLUGGED,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    STGM_READ,
};
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
use winreg::enums::HKEY_LOCAL_MACHINE;
use winreg::RegKey;

/// Equalizer APO's two APO CLSIDs, as registered in HKLM\SOFTWARE\Classes\CLSID.
/// If either appears in a device's FxProperties, EQ actually reaches that device.
const EAPO_PRE_MIX: &str = "{EACD2258-FCAC-4FF4-B36D-419E924A6D79}";
const EAPO_POST_MIX: &str = "{EC1CC9CE-FAED-4822-828A-82A81A6F018F}";

/// FxProperties values that can hold an APO CLSID (pre-mix, post-mix, mode).
const FX_CLSID_KEYS: [&str; 3] = [
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5",
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},6",
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},7",
];

/// PKEY_AudioEngine_DeviceFormat - a WAVEFORMATEX blob.
const PROP_DEVICE_FORMAT: &str = "{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0";
/// PKEY_AudioEndpoint_FormFactor - the EndpointFormFactor enum.
const PROP_FORM_FACTOR: &str = "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},0";
/// PKEY_Device_DeviceInstanceId, e.g. `{1}.USB\VID_046D&...` or `{1}.ROOT\MEDIA\0001`.
/// The bus prefix is the only trustworthy way to tell real hardware from a
/// software endpoint - names like "Boom Audio" look exactly like real speakers.
const PROP_INSTANCE_ID: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},2";

/// EndpointFormFactor values we care about.
pub mod form {
    pub const SPEAKERS: u32 = 1;
    pub const LINE_LEVEL: u32 = 2;
    pub const HEADPHONES: u32 = 3;
    pub const MICROPHONE: u32 = 4;
    pub const HEADSET: u32 = 5;
    pub const SPDIF: u32 = 8;
    /// HDMI / DisplayPort - a monitor or TV.
    pub const DISPLAY: u32 = 9;
}

/// PKEY_Device_DeviceDesc, e.g. "Headphones".
const FMTID_DEVICE: u128 = 0xa45c254e_df1c_4efd_8020_67d146a850e0;
/// PKEY_DeviceInterface_FriendlyName, e.g. "Logi Z607".
const FMTID_INTERFACE: u128 = 0xb3f8fa53_0004_438e_9003_51a46e139bfc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flow {
    Render,
    Capture,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    /// MMDevice endpoint id, e.g. `{0.0.0.00000000}.{229908d3-...}`. Stable across reboots.
    pub id: String,
    /// The jack/endpoint name, e.g. "Headphones". Equalizer APO calls this the device name.
    pub name: String,
    /// The adapter name, e.g. "Logi Z607". Equalizer APO calls this the connection name.
    pub adapter: String,
    pub flow: Flow,
    /// "active" | "unplugged" | "disabled" | "notpresent"
    pub state: &'static str,
    pub is_default: bool,
    /// Equalizer APO is installed on this endpoint, so EQ will actually be heard.
    pub eapo: bool,
    pub channels: u16,
    pub sample_rate: u32,
    /// EndpointFormFactor - see the `form` module.
    pub form_factor: u32,
    /// A software endpoint (Steam streaming, Oculus, virtual cables) rather
    /// than real hardware. Never a sensible automatic choice.
    pub virtual_device: bool,
    /// Bluetooth A2DP - stereo music profile.
    pub bluetooth: bool,
    /// Bluetooth Hands-Free (HFP) - mono, 16 kHz, and selecting it drags the
    /// whole link out of A2DP, so the headphones sound like a phone call.
    pub hands_free: bool,
}

impl Device {
    pub fn present(&self) -> bool {
        self.state == "active"
    }

    /// The pattern for an Equalizer APO `Device:` line.
    ///
    /// APO matches every space-separated word of the pattern as a substring of
    /// `"<connection> <device> <guid>"`, and treats `;` as *alternatives*, not
    /// as a field separator. Matching on names is therefore both ambiguous and
    /// dangerous - "Headphones" alone silently captures every headphone
    /// endpoint on the machine. The endpoint GUID is in that same string and is
    /// unique, so we target it directly. Braces are omitted so the substring
    /// matches whether or not APO wraps the GUID.
    pub fn eapo_match(&self) -> String {
        self.guid().to_string()
    }

    /// The endpoint GUID, without braces: `{0.0.0.00000000}.{abc-...}` -> `abc-...`.
    pub fn guid(&self) -> &str {
        match self.id.rfind(".{") {
            Some(i) => self.id[i + 2..].trim_end_matches('}'),
            None => &self.id,
        }
    }
}

pub(crate) fn com_init() {
    // Safe to call repeatedly; RPC_E_CHANGED_MODE just means someone got here first.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

/// The registry-sourced half of a `Device`.
struct Facts {
    channels: u16,
    rate: u32,
    eapo: bool,
    form_factor: u32,
    virtual_device: bool,
    bluetooth: bool,
    hands_free: bool,
}

/// Read the per-endpoint facts that are a pain to get through COM.
fn registry_facts(flow: Flow, id: &str) -> Facts {
    // Endpoint id looks like `{0.0.0.00000000}.{guid}`; the hive keys it by the trailing guid.
    let guid = match id.rfind(".{") {
        Some(i) => &id[i + 1..],
        None => id,
    };
    let leaf = match flow {
        Flow::Render => "Render",
        Flow::Capture => "Capture",
    };
    let base = format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\{}\\{}",
        leaf, guid
    );
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    let mut channels = 2u16;
    let mut rate = 48_000u32;
    let mut form_factor = 0u32;
    let mut instance = String::new();
    if let Ok(props) = hklm.open_subkey(format!("{base}\\Properties")) {
        form_factor = props.get_value::<u32, _>(PROP_FORM_FACTOR).unwrap_or(0);
        instance = props
            .get_value::<String, _>(PROP_INSTANCE_ID)
            .unwrap_or_default()
            .to_ascii_uppercase();
        if let Ok(blob) = props.get_raw_value(PROP_DEVICE_FORMAT) {
            // The value is a serialised PROPVARIANT, not a bare struct: four
            // bytes of VT_BLOB tag, four of length, then the WAVEFORMATEX
            // (wFormatTag u16, nChannels u16, nSamplesPerSec u32, ...).
            const WFX: usize = 8;
            let b = &blob.bytes;
            if b.len() >= WFX + 8 {
                channels = u16::from_le_bytes([b[WFX + 2], b[WFX + 3]]);
                rate = u32::from_le_bytes([b[WFX + 4], b[WFX + 5], b[WFX + 6], b[WFX + 7]]);
            }
        }
    }

    let eapo = hklm
        .open_subkey(format!("{base}\\FxProperties"))
        .map(|fx| {
            FX_CLSID_KEYS.iter().any(|k| {
                fx.get_value::<String, _>(k)
                    .map(|v| {
                        let v = v.trim();
                        v.eq_ignore_ascii_case(EAPO_PRE_MIX) || v.eq_ignore_ascii_case(EAPO_POST_MIX)
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    Facts {
        channels,
        rate,
        eapo,
        form_factor,
        // Software endpoints hang off the ROOT bus; real gear is on USB,
        // HDAUDIO, BTHENUM, PCI and friends.
        virtual_device: instance.contains(".ROOT\\") || instance.starts_with("ROOT\\"),
        bluetooth: instance.contains("BTHENUM"),
        hands_free: instance.contains("BTHHFENUM"),
    }
}

fn prop_string(dev: &IMMDevice, fmtid: u128, pid: u32) -> Option<String> {
    unsafe {
        let store = dev.OpenPropertyStore(STGM_READ).ok()?;
        let key = PROPERTYKEY {
            fmtid: GUID::from_u128(fmtid),
            pid,
        };
        let pv = store.GetValue(&key).ok()?;
        let s = PropVariantToStringAlloc(&pv).ok()?;
        let out = s.to_string().ok();
        CoTaskMemFree(Some(s.0 as *const _));
        out
    }
}

pub fn list() -> Vec<Device> {
    com_init();
    let mut out = Vec::new();
    unsafe {
        let Ok(enumerator) =
            CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
        else {
            return out;
        };

        // Which endpoint is currently default, per flow.
        let mut defaults: HashMap<Flow, String> = HashMap::new();
        for flow in [Flow::Render, Flow::Capture] {
            let ed = if flow == Flow::Render { eRender } else { eCapture };
            if let Ok(dev) = enumerator.GetDefaultAudioEndpoint(ed, eConsole) {
                if let Ok(id) = dev.GetId() {
                    if let Ok(s) = id.to_string() {
                        defaults.insert(flow, s);
                    }
                    CoTaskMemFree(Some(id.0 as *const _));
                }
            }
        }

        let mask = DEVICE_STATE_ACTIVE.0
            | DEVICE_STATE_UNPLUGGED.0
            | DEVICE_STATE_DISABLED.0
            | DEVICE_STATE_NOTPRESENT.0;

        for flow in [Flow::Render, Flow::Capture] {
            let ed = if flow == Flow::Render { eRender } else { eCapture };
            let Ok(coll) = enumerator.EnumAudioEndpoints(ed, DEVICE_STATE(mask)) else {
                continue;
            };
            let count = coll.GetCount().unwrap_or(0);
            for i in 0..count {
                let Ok(dev) = coll.Item(i) else { continue };
                let Ok(idw) = dev.GetId() else { continue };
                let id = idw.to_string().unwrap_or_default();
                CoTaskMemFree(Some(idw.0 as *const _));
                if id.is_empty() {
                    continue;
                }

                let state = match dev.GetState().map(|s| s.0).unwrap_or(0) {
                    x if x == DEVICE_STATE_ACTIVE.0 => "active",
                    x if x == DEVICE_STATE_UNPLUGGED.0 => "unplugged",
                    x if x == DEVICE_STATE_DISABLED.0 => "disabled",
                    _ => "notpresent",
                };

                let name =
                    prop_string(&dev, FMTID_DEVICE, 2).unwrap_or_else(|| "Unknown".to_string());
                let adapter = prop_string(&dev, FMTID_INTERFACE, 6).unwrap_or_default();
                let f = registry_facts(flow, &id);

                out.push(Device {
                    is_default: defaults.get(&flow).map(|d| d == &id).unwrap_or(false),
                    id,
                    name,
                    adapter,
                    flow,
                    state,
                    eapo: f.eapo,
                    channels: f.channels,
                    sample_rate: f.rate,
                    form_factor: f.form_factor,
                    virtual_device: f.virtual_device,
                    bluetooth: f.bluetooth,
                    hands_free: f.hands_free,
                });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Setting the default endpoint.
//
// There is no public API for this - every tool that does it (EarTrumpet,
// AudioSwitcher, SoundVolumeView) calls the undocumented IPolicyConfig. The
// vtable layout below is the long-standing Vista..Win11 one; we only ever call
// SetDefaultEndpoint, so the ten preceding slots are declared as opaque padding
// purely to land on the right offset, and are never invoked.
// ---------------------------------------------------------------------------

#[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: windows::core::IUnknown {
    unsafe fn get_mix_format(&self) -> windows::core::HRESULT;
    unsafe fn get_device_format(&self) -> windows::core::HRESULT;
    unsafe fn reset_device_format(&self) -> windows::core::HRESULT;
    unsafe fn set_device_format(&self) -> windows::core::HRESULT;
    unsafe fn get_processing_period(&self) -> windows::core::HRESULT;
    unsafe fn set_processing_period(&self) -> windows::core::HRESULT;
    unsafe fn get_share_mode(&self) -> windows::core::HRESULT;
    unsafe fn set_share_mode(&self) -> windows::core::HRESULT;
    unsafe fn get_property_value(&self) -> windows::core::HRESULT;
    unsafe fn set_property_value(&self) -> windows::core::HRESULT;
    unsafe fn set_default_endpoint(&self, device_id: PCWSTR, role: ERole)
        -> windows::core::HRESULT;
    unsafe fn set_endpoint_visibility(&self) -> windows::core::HRESULT;
}

const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

/// Make `device_id` the default endpoint for all three roles.
pub fn set_default(device_id: &str) -> Result<(), String> {
    com_init();
    unsafe {
        let cfg: IPolicyConfig = CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL)
            .map_err(|e| format!("IPolicyConfig unavailable: {e}"))?;
        let wide = HSTRING::from(device_id);
        for role in [eConsole, eMultimedia, eCommunications] {
            let hr = cfg.set_default_endpoint(PCWSTR(wide.as_ptr()), role);
            if hr.is_err() {
                return Err(format!("SetDefaultEndpoint({role:?}) failed: {hr:?}"));
            }
        }
    }
    Ok(())
}
