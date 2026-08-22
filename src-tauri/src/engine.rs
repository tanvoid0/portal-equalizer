//! Getting the DSP engine onto the machine.
//!
//! We ship Equalizer APO's own installer as a bundled resource and hand off to
//! it rather than registering the APO ourselves. Its installer owns the device
//! selection screen, the CLSID registration and the reboot prompt - and it goes
//! on owning them when the next APO release changes their shape. Re-implementing
//! that would buy one fewer window and a permanent maintenance debt.
//!
//! What we do own is the way out. Hooking an endpoint means rewriting its
//! `FxProperties`, and a half-applied write there is the difference between "the
//! EQ is silent" and "this endpoint has no audio at all". So we snapshot the
//! whole MMDevices hive before handing over, and keep a restore that puts it
//! back.

use crate::eapo;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use winreg::enums::HKEY_LOCAL_MACHINE;
use winreg::RegKey;

/// Registry root holding one subkey per audio endpoint. Same hive `audio.rs`
/// reads the hook state out of - see `FX_CLSID_KEYS` there.
const MMDEVICES: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio";

/// The three `FxProperties` values that can carry an APO CLSID. Deleting these
/// is what unhooks an endpoint; kept in step with `audio::FX_CLSID_KEYS`.
const FX_CLSID_KEYS: [&str; 3] = [
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5",
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},6",
    "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},7",
];

const DOWNLOAD_PAGE: &str = "https://sourceforge.net/projects/equalizerapo/";

/// ShellExecute keeps its 16-bit contract: a return value of 32 or less is an
/// error code, anything above it is a real instance handle.
const SHELLEXEC_MIN_SUCCESS: usize = 32;
/// What ShellExecute reports when the user dismisses the UAC prompt.
const SE_ERR_ACCESSDENIED: usize = 5;

fn app_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("PortalEqualizer")
}

fn backup_path() -> PathBuf {
    app_dir().join("mmdevices-backup.reg")
}

pub fn backup_exists() -> bool {
    backup_path().exists()
}

/// The bundled installer, if one was shipped. Matched by prefix rather than by
/// exact name so dropping a newer `EqualizerAPO64-1.4.exe` in needs no code
/// change.
pub fn bundled_installer(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("resources");
    std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
        let p = e.path();
        let name = p.file_name()?.to_string_lossy().to_ascii_lowercase();
        (name.starts_with("equalizerapo") && name.ends_with(".exe")).then_some(p)
    })
}

/// Endpoint ids are GUIDs read back out of HKLM. They are interpolated into an
/// elevated batch script below, so anything that is not GUID-shaped is dropped
/// rather than quoted - there is no legitimate endpoint id this rejects.
fn valid_endpoint_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || matches!(c, '{' | '}' | '-'))
}

/// Every endpoint subkey under Render and Capture, as `Render\{guid}` paths.
fn endpoint_keys() -> Vec<String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    ["Render", "Capture"]
        .iter()
        .filter_map(|flow| {
            let key = hklm.open_subkey(format!("{MMDEVICES}\\{flow}")).ok()?;
            Some(
                key.enum_keys()
                    .flatten()
                    .filter(|id| valid_endpoint_id(id))
                    .map(|id| format!("{flow}\\{id}"))
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .collect()
}

/// Export the MMDevices hive, once. A second export would capture the hive
/// *after* APO hooked it and overwrite the only pristine copy we have, so the
/// first snapshot wins - same reasoning as `eapo::backup_once`.
pub fn snapshot() -> Result<PathBuf, String> {
    let path = backup_path();
    if path.exists() {
        return Ok(path);
    }
    std::fs::create_dir_all(app_dir()).map_err(|e| format!("Cannot create the app folder: {e}"))?;

    // Exporting only reads HKLM, so this needs no elevation.
    let out = Command::new("reg.exe")
        .args([
            "export",
            &format!("HKLM\\{MMDEVICES}"),
            &path.to_string_lossy(),
            "/y",
        ])
        .output()
        .map_err(|e| format!("Could not run reg.exe: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "Could not back up the audio endpoint registry: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // Recorded now so `restore` can tell a pristine snapshot from a mangled one
    // before feeding it to an elevated `reg import`.
    std::fs::write(digest_path(), digest_of(&path)?)
        .map_err(|e| format!("Cannot record the backup checksum: {e}"))?;
    Ok(path)
}

/// Snapshot the endpoints, then hand over to Equalizer APO's own installer.
///
/// Returns a note for the UI rather than nothing, because the outcome the user
/// needs to read differs: an installer that launched, or a download page opened
/// because no installer was bundled with this build.
pub fn install(app: &AppHandle) -> Result<String, String> {
    let backup = snapshot()?;

    let Some(installer) = bundled_installer(app) else {
        crate::shell_open(DOWNLOAD_PAGE)?;
        return Ok(
            "This build ships without the installer, so the download page is open instead. \
             Tick every endpoint you want EQ on."
                .into(),
        );
    };

    run_elevated(&installer, "")?;
    Ok(format!(
        "Installer running. Tick every endpoint you want EQ on, then reboot. \
         Endpoints backed up to {}.",
        backup.display()
    ))
}

/// Equalizer APO's own device picker, for adding an endpoint after the fact.
pub fn open_configurator() -> Result<(), String> {
    let exe = eapo::install_dir()
        .map(|d| d.join("Configurator.exe"))
        .filter(|p| p.exists())
        .ok_or("Equalizer APO is not installed, so it has no Configurator to open.")?;
    snapshot()?;
    run_elevated(&exe, "")
}

/// Unhook every endpoint and put the snapshot back.
///
/// Deleting first is what makes this a real restore: `reg import` merges, so it
/// will happily rewrite the values that were there before but cannot remove the
/// ones the installer added where the key previously had none. Both halves go
/// into one `.reg` - `"name"=-` is the format's own "delete this value" - so
/// the elevated step is a single `reg.exe import` and never a script
/// interpreter. Anything that tampers with the file gets registry writes, not
/// arbitrary code as Administrator.
pub fn restore() -> Result<(), String> {
    let backup = backup_path();
    if !backup.exists() {
        return Err("There is no endpoint backup to restore from.".into());
    }
    verify_digest(&backup)?;

    let reg = build_restore_reg(&endpoint_keys(), &read_utf16(&backup)?);
    let path = app_dir().join("restore-endpoints.reg");
    write_utf16(&path, &reg)?;
    run_elevated(Path::new("reg.exe"), &format!("import \"{}\"", path.display()))
}

/// Value deletions for every endpoint, then the snapshot verbatim.
///
/// Order is the whole point: `"name"=-` clears a hook the installer added where
/// nothing was before, and the snapshot that follows puts back whatever the
/// endpoint originally had.
fn build_restore_reg(keys: &[String], snapshot_body: &str) -> String {
    let mut reg = String::from("Windows Registry Editor Version 5.00\r\n");
    for key in keys {
        reg.push_str(&format!(
            "\r\n[HKEY_LOCAL_MACHINE\\{MMDEVICES}\\{key}\\FxProperties]\r\n"
        ));
        for value in FX_CLSID_KEYS {
            reg.push_str(&format!("\"{value}\"=-\r\n"));
        }
    }
    // The export carries its own version header, and only one may appear.
    reg.push_str("\r\n");
    reg.push_str(
        snapshot_body
            .trim_start_matches('\u{feff}')
            .trim_start()
            .strip_prefix("Windows Registry Editor Version 5.00")
            .unwrap_or(snapshot_body),
    );
    reg
}

/// `reg export` writes UTF-16LE with a BOM, so the snapshot cannot be read as
/// UTF-8 and the file we hand back to `reg import` has to match.
fn read_utf16(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    if bytes.len() % 2 != 0 {
        return Err(format!("{} is truncated.", path.display()));
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&units).map_err(|_| format!("{} is not valid UTF-16.", path.display()))
}

fn write_utf16(path: &Path, text: &str) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(text.len() * 2 + 2);
    for unit in std::iter::once(0xfeff).chain(text.encode_utf16()) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(path, bytes).map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

fn digest_path() -> PathBuf {
    app_dir().join("mmdevices-backup.sha256")
}

fn digest_of(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

/// Catch a snapshot that changed since we took it.
///
/// ponytail: this detects corruption and casual tampering, not a determined
/// attacker - the digest sits in the same user-writable folder as the file it
/// describes, so anything able to rewrite one can rewrite both. Closing that
/// needs a store only Administrators can write, which we cannot create without
/// already being elevated.
fn verify_digest(backup: &Path) -> Result<(), String> {
    let recorded = std::fs::read_to_string(digest_path())
        .map_err(|_| "The endpoint backup has no checksum on record, so it will not be restored.")?;
    if recorded.trim() != digest_of(backup)? {
        return Err(format!(
            "The endpoint backup at {} has changed since it was taken and will not be restored. \
             Delete it and re-run the installer to take a fresh one.",
            backup.display()
        ));
    }
    Ok(())
}

fn run_elevated(exe: &Path, args: &str) -> Result<(), String> {
    let verb = HSTRING::from("runas");
    let file = HSTRING::from(exe.as_os_str());
    let params = HSTRING::from(args);
    let rc = unsafe {
        ShellExecuteW(
            HWND(std::ptr::null_mut()),
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            if args.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(params.as_ptr())
            },
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    match rc.0 as usize {
        n if n > SHELLEXEC_MIN_SUCCESS => Ok(()),
        SE_ERR_ACCESSDENIED => {
            Err("Cancelled at the Windows permission prompt. Nothing was changed.".into())
        }
        n => Err(format!(
            "Could not start {} as administrator (error {n}).",
            exe.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_shaped_endpoint_ids_are_accepted() {
        assert!(valid_endpoint_id("{a1b2c3d4-1111-2222-3333-444455556666}"));
        assert!(valid_endpoint_id("a1b2c3d4-1111-2222-3333-444455556666"));
    }

    /// The id lands in a key path inside a `.reg` that gets imported as
    /// Administrator, so a newline or a bracket in one would open a section of
    /// its own and rewrite a key nobody asked for.
    #[test]
    fn ids_that_could_break_out_of_the_reg_file_are_rejected() {
        for bad in [
            "{a1b2}]\r\n[HKEY_LOCAL_MACHINE\\SOFTWARE\\Evil",
            "{a1b2} & calc.exe",
            "\" /f & del C:\\x \"",
            "..\\..\\Render",
            "",
        ] {
            assert!(!valid_endpoint_id(bad), "must reject: {bad:?}");
        }
    }

    /// The deletions have to come first, or the snapshot puts the original
    /// values back and the very next line wipes them again.
    #[test]
    fn restore_clears_the_hooks_before_replaying_the_snapshot() {
        let keys = vec!["Render\\{a1b2c3d4-1111-2222-3333-444455556666}".to_string()];
        let snapshot = "\u{feff}Windows Registry Editor Version 5.00\r\n\r\n\
             [HKEY_LOCAL_MACHINE\\SOFTWARE\\X]\r\n\"Keep\"=dword:00000001\r\n";
        let out = build_restore_reg(&keys, snapshot);

        assert_eq!(
            out.matches("Windows Registry Editor Version 5.00").count(),
            1,
            "reg import rejects a second version header:\n{out}"
        );
        let delete_at = out.find("\"{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5\"=-").unwrap();
        let restore_at = out.find("\"Keep\"=dword:00000001").unwrap();
        assert!(delete_at < restore_at, "deletions must precede the snapshot:\n{out}");
        assert!(!out.contains('\u{feff}'), "the BOM belongs in the encoding, not the text");
        // All three CLSID slots, or a hook survives in the one we skipped.
        for value in FX_CLSID_KEYS {
            assert!(out.contains(&format!("\"{value}\"=-")), "missing deletion for {value}");
        }
    }

    /// Restoring without a snapshot must fail loudly rather than run a script
    /// that deletes every hook and puts nothing back.
    #[test]
    fn restore_refuses_without_a_backup() {
        if backup_path().exists() {
            return; // A real backup on the dev machine - nothing to assert.
        }
        assert!(restore().is_err());
    }
}
