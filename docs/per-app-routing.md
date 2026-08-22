# Per-app audio routing

Built — [`approuting.rs`](../src-tauri/src/approuting.rs). This document is why
it looks the way it does: none of the API below is documented, so the reasoning
is worth more than the code.

**Goal:** rules like "Spotify → Z607", "Discord → Crusher headset", so a given
application plays to a chosen endpoint regardless of the system default.

**Why it was kept separate:** it shares nothing with the EQ or the priority
switcher. Those work on the *system default* endpoint through `IPolicyConfig`;
this works per-process through a completely different, also-undocumented API.

---

## The API

Windows 10 1803+ exposes per-app routing through `IAudioPolicyConfigFactory`,
an **IInspectable**-derived (WinRT) interface with no public header. It is what
the Settings ▸ System ▸ Sound ▸ Volume mixer page drives, and what EarTrumpet
uses.

Obtain it with `RoGetActivationFactory`, not `CoCreateInstance`:

```
class name : "Windows.Media.Internal.AudioPolicyConfig"
IID (21H2+): ab3d4648-e242-459f-b02f-541c70306324
```

There are **two vtable variants**. EarTrumpet branches on build ≥ 21H2. This
machine is build **26200**, so only the 21H2 variant matters here; keep the
branch only if you care about Windows 10.

Vtable order for the 21H2 variant — 6 IUnknown/IInspectable slots, then
**19 unrelated methods**, then the three that matter:

```
QueryInterface, AddRef, Release,                      (IUnknown)
GetIids, GetRuntimeClassName, GetTrustLevel,          (IInspectable)
add_CtxVolumeChange, remove_CtxVolumeChanged,
add_RingerVibrateStateChanged, remove_RingerVibrateStateChange,
SetVolumeGroupGainForId, GetVolumeGroupGainForId,
GetActiveVolumeGroupForEndpointId, GetVolumeGroupsForEndpoint,
GetCurrentVolumeContext, SetVolumeGroupMuteForId, GetVolumeGroupMuteForId,
SetRingerVibrateState, GetRingerVibrateState,
SetPreferredChatApplication, ResetPreferredChatApplication,
GetPreferredChatApplication, GetCurrentChatApplications,
add_ChatContextChanged, remove_ChatContextChanged,     (19 padding slots)

SetPersistedDefaultAudioEndpoint(u32 processId, EDataFlow, ERole, HSTRING deviceId)
GetPersistedDefaultAudioEndpoint(u32 processId, EDataFlow, ERole, HSTRING* out)
ClearAllPersistedApplicationDefaultEndpoints()
```

Declare it the same way `IPolicyConfig` is already declared in
[`audio.rs`](../src-tauri/src/audio.rs) — `#[windows::core::interface("...")]`
with opaque padding methods to reach the right offset. That one derives from
`IUnknown`; this one must derive from `IInspectable`, so either write
`unsafe trait IAudioPolicyConfigFactory: IInspectable` or add three extra
padding slots by hand.

## Device ID format

**Not** the plain endpoint id. It must be wrapped into the device-interface
path form:

```
\\?\SWD#MMDEVAPI#{0.0.0.00000000}.{5d686a6f-...}#{e6327cad-dcec-4949-ae8a-991e976a79d2}
└─ MMDEVAPI_TOKEN ─┘└──── Device.id verbatim ────┘└──── DEVINTERFACE_AUDIO_RENDER ────┘
```

```
render  suffix: #{e6327cad-dcec-4949-ae8a-991e976a79d2}
capture suffix: #{2eef81be-33fa-4800-9670-1cd474972c3f}
```

The middle section is exactly the `Device.id` this codebase already carries.
Pass the result as an **HSTRING** (`WindowsCreateString`). Passing a null/empty
HSTRING **resets that app to the system default** — that is the "clear rule"
path, not a separate call.

Call it **twice**, once for `eMultimedia` and once for `eConsole`. EarTrumpet
does; a single role leaves half the app's streams on the old device.

## What actually persists

The assignment is stored per-executable, not per-PID, under:

```
HKCU\Software\Microsoft\Internet Explorer\LowRegistry\Audio\PolicyConfig\PropertyStore
```

424 entries already exist on this machine. Each value reads:

```
{2}.\\?\bthenum#{0000110b-...}#{6994ad04-93ef-11d0-a3cc-00a0c9223196}\src/00010001
  |\Device\HarddiskVolume3\...\Spotify.exe%b{00000000-0000-0000-0000-000000000000}
   └─ NT path to the exe ─┘                └─ audio session GUID ─┘
```

Key names are a hash (`1182f3dc_0`) with a `_0`/`_1` suffix for flow. **Do not
write this key directly** — the hash is not something to reproduce, and the
audio engine caches. Use the COM call for writes.

It *is* excellent for **reads**, with one caveat found once the reader was
written: **the device half is not always the id you passed in.** Rules we write
come back in the `swd#mmdevapi#{0.0.0.00000000}.{guid}#{interface}` form, and the
endpoint id falls straight out of the middle. Rules *Windows* wrote — every one
of the 424 already here — carry the underlying PnP path instead
(`usb#vid_3206&pid_0861&mi_00#{kscategory}\global/00010003`), which names an
adapter and a pin rather than an endpoint. Mapping one back to an MMDevice id is
guesswork, so `parse_entry` returns an empty id for those: the app is still
listed, because a rule is *why* that app ignores the priority list, but we do not
claim to know where it points.

Two more things the format does not advertise: an app half of bare `#` is a
system-wide default, not a per-app rule, so filter it out or a third of the
entries are noise; and the exe path is the full NT path of whatever version was
running when the rule was set, which is why rules key on the file name.

**Consequence that shrinks the work:** because the rule persists by executable
path, you only have to catch a process **once**. Windows re-applies it on every
later launch by itself. A rule is not a daemon that must re-assert forever.

## Process discovery

You need a live PID to make the call. Options, laziest first:

1. **Extend the existing 1 s poll** in `watch()` in
   [`lib.rs`](../src-tauri/src/lib.rs). It already wakes every second; diff the
   process list against rules with no rule applied yet. Reuses machinery that
   exists. Costs one `CreateToolhelp32Snapshot` per tick.
2. WMI `__InstanceCreationEvent` on `Win32_Process` — event-driven, no polling,
   but drags in a WMI subscription and its threading rules.
3. Enumerate only audio sessions (`IAudioSessionManager2::GetSessionEnumerator`)
   rather than all processes. Smaller set, and an app that is not playing audio
   does not need a rule yet. Probably the *right* answer, slightly more code.

Given that rules persist per-exe, option 1 is almost certainly enough.

## Where it plugs in

| Change | File |
| --- | --- |
| `IAudioPolicyConfigFactory` decl + `set_app_endpoint(pid, flow, device_id)` | [`approuting.rs`](../src-tauri/src/approuting.rs) |
| Read existing rules from the registry | same file, reusing the `winreg` dep |
| `app_rules: Vec<AppRule>` on `Settings` | [`store.rs`](../src-tauri/src/store.rs) |
| Apply unapplied rules each tick | `watch()` in [`lib.rs`](../src-tauri/src/lib.rs) |
| `list_app_rules` / `list_processes` / `clear_app_rule` commands | [`lib.rs`](../src-tauri/src/lib.rs) |
| Rules tab beside the device list | [`AppRules.tsx`](../src/components/AppRules.tsx) |

There is no `set_app_rule` command in the end. Adding a rule is a settings
change like any other, so it rides `save_settings` and the watcher applies it on
its next tick. Only *removal* needs its own call: once the rule is gone from
settings there is nothing left to tell the watcher what to undo, so the clear has
to happen while we still know.

The shape, as built:

```rust
struct AppRule {
    /// Lowercased executable file name, e.g. "spotify.exe". Matching on the
    /// full path breaks the moment an app self-updates into a new versioned
    /// folder - Spotify and Discord both do exactly that.
    exe: String,
    device_id: String,
    flow: Flow,
}
```

That `exe` comment is the one real design trap: the registry stores full NT
paths, and `...\Discord\app-1.0.9234\...` changes on every update. Match on the
file name, resolve to whatever PID is running.

## Gotchas

- **Rules do not move with a device that disappears.** If an app is pinned to
  the Z607 and the Z607 is off, that app goes silent rather than falling back.
  Left as-is, deliberately: that is what Windows itself does, and silently
  un-pinning an app because its speakers were off would be worse. The rules list
  shows a `device off` chip instead. The priority switcher does *not* cover this
  — it only moves the system default.
- **It interacts with auto-switching.** An app with a rule ignores the priority
  list entirely, which is stated on the rules tab and is the reason rules Windows
  set itself are listed there too, even when we cannot name their device.
- Elevated processes may reject the call from a non-elevated app.
- `ClearAllPersistedApplicationDefaultEndpoints()` wipes rules set through
  Windows Settings too, not just ours. Never call it as a "reset our stuff"
  shortcut.

## Verifying

The probe activates the factory (which fails loudly on a build that does not
expose the class) and prints every rule Windows is holding:

```bash
cargo run --example probe --manifest-path src-tauri/Cargo.toml
```

It deliberately does **not** call `SetPersistedDefaultAudioEndpoint` — that would
write a real rule onto the machine running the probe. The vtable offset is only
proven by pinning something and hearing it move.

To see what Windows currently believes, without going through us:

```powershell
Get-ChildItem "HKCU:\Software\Microsoft\Internet Explorer\LowRegistry\Audio\PolicyConfig\PropertyStore" |
  ForEach-Object { (Get-ItemProperty $_.PSPath).'(default)' } |
  Where-Object { $_ -match 'spotify' }
```

Ground truth for a human: Settings ▸ System ▸ Sound ▸ Volume mixer shows the
per-app device dropdowns this API drives.

## Sources

Interface shape, activation string and ID format were read from EarTrumpet
(MIT), which is the reference implementation:
`EarTrumpet/Interop/MMDeviceAPI/IAudioPolicyConfigFactoryVariantFor21H2.cs`,
`EarTrumpet/Interop/Helpers/AudioPolicyConfigFactoryImplFor21H2.cs`,
`EarTrumpet/DataModel/WindowsAudio/Internal/AudioPolicyConfigService.cs`.
