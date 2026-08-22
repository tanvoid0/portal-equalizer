//! "Start with Windows" is the per-user Run key, and that key is the truth.
//!
//! Deliberately not mirrored into settings.json: the user can revoke it from
//! Task Manager's Startup tab, from msconfig, or with another installer, and we
//! would never hear about it. A copy in our own file would go stale the first
//! time that happened and then lie to the switch.

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const NAME: &str = "PortalEqualizer";

/// Quoted, because the install path contains a space ("Program Files") and an
/// unquoted Run value is parsed as `C:\Program.exe "Files\..."`.
fn command() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| format!("\"{}\"", p.display()))
        .map_err(|e| e.to_string())
}

pub fn enabled() -> bool {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(NAME))
        .is_ok()
}

pub fn set(on: bool) -> Result<(), String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN, KEY_WRITE)
        .map_err(|e| e.to_string())?;
    if on {
        return key.set_value(NAME, &command()?).map_err(|e| e.to_string());
    }
    match key.delete_value(NAME) {
        // Already absent is the state that was asked for, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        r => r.map_err(|e| e.to_string()),
    }
}
