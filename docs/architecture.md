# Architecture

```
React + Tailwind + motion  ──invoke/events──  Rust (Tauri 2)
                                                ├── audio.rs    MMDevice enumeration, IPolicyConfig default-switching
                                                ├── rank.rs     "smart organise" ordering
                                                ├── eapo.rs     config.txt generation
                                                ├── engine.rs   installing Equalizer APO, endpoint registry backup
                                                ├── spectrum.rs WASAPI loopback -> FFT -> 48 bars
                                                ├── analyze.rs  the same FFT -> spectral fingerprint
                                                ├── ai.rs       chat transport to Agent Platform
                                                ├── media.rs    SMTC now-playing, cover art, transport
                                                ├── approuting.rs per-app routing rules
                                                ├── autostart.rs the Run key, for "start with Windows"
                                                └── store.rs     settings.json
```

## Getting the engine onto the machine

`engine.rs` ships Equalizer APO's own installer as a bundled resource and hands off to
it rather than registering the APO ourselves. Its installer owns the device selection
screen, the CLSID registration and the reboot prompt — and goes on owning them when the
next APO release changes their shape. Re-implementing that would buy one fewer window
and a permanent maintenance debt.

What we do own is the way out. Hooking an endpoint means rewriting its `FxProperties`,
and a half-applied write there is the difference between "the EQ is silent" and "this
endpoint has no audio at all". So the whole MMDevices hive is exported with `reg.exe`
before the installer is launched, once, and **Restore** in Settings puts it back.

Restore deletes the three APO CLSID values before importing the snapshot, because
`reg import` merges: it will happily rewrite values that were there before, but cannot
remove ones the installer added where the key previously had none.

## Picking a preset for what is playing

Two halves, because they know different things.

**The local half is tonal and runs always.** `analyze.rs` folds every FFT frame the
spectrum already computed into a 4-second average per octave band, fits a weighted
least-squares line through those levels in log frequency, and asks two questions: is
this mix darker or brighter than a well-balanced one (the line's slope against a -3.5
dB/octave reference), and does any band stick out of its own trend (the residual). Half
of each error becomes the suggested correction. `suggest.ts` then ranks every preset by
cosine similarity to that curve, scaled down when a preset is far larger than the problem
— a +9 dB V-shape is a bad answer to a 1 dB imbalance even though it points the same way.
The correction itself is offered as "Auto curve".

Correcting to *flat* is the mistake here. Music is roughly pink; a curve that flattens it
sounds thin and harsh, which is why the reference is a tilt rather than a straight line.

**The measurement includes the EQ.** WASAPI loopback taps the stream after
Equalizer APO, so the fingerprint describes the *equalised* signal. A correction read
from there means "go this much further", which makes every apply dig deeper into its own
last suggestion — apply a treble cut and the next suggestion asks for more treble cut.
`effectiveNeed` adds the applied curve back, giving the total correction from flat, which
is what the sliders hold and what converges.

**The agentic half knows what the track is.** A spectrum cannot tell techno from a
synth-heavy film score — they measure the same. So `SmartPreset` sends the fingerprint,
the SMTC track title/artist/app, the output device, and the local top three to the
[Agent Platform](../../../ai/agentic-ai/agent-platform) at `/v1/chat/completions`, and
takes back a preset name or a bespoke curve with one line of reasoning. Auto mode
re-asks only when the correction drifts more than 10 dB total or the track changes, and
never more often than every 20 seconds.

A named preset always applies the catalogue's own gains, never the model's transcription
of them, so a hallucinated curve cannot arrive wearing a familiar label. Custom curves are
clamped to the same ±12 dB the sliders allow, and every suggestion needs a click — nothing
the model says reaches the audio path on its own.

The HTTP call is made in Rust rather than with `fetch`: a request from the webview would
need the platform started with `AGENT_PLATFORM_CORS_ORIGINS` set for the Tauri origin.
Token goes in Settings ⚙ or `$AGENT_PLATFORM_TOKEN`; blank means no auth header, which is
what a default local install expects.

## Settings

One page behind the title bar's gear, and the settings the panels used to carry
themselves — the AI server, the auto-switch toggle — now live there rather than in the
surface they affect.

- **Start with Windows** writes `HKCU\...\CurrentVersion\Run` and reads it back from
  there, never from `settings.json`: the user can revoke it from Task Manager's Startup
  tab and a mirrored copy would go stale and then lie about it.
- **Close to tray** (default on) hides the window instead of quitting, because
  auto-switching and app rules only happen while the process is alive. That makes a
  second launch of the shortcut a hazard — two watchers fighting over the default device
  — so `tauri-plugin-single-instance` hands the launch to the running copy instead.
- **Simple / Advanced** cuts the 85-preset catalogue down to one obvious answer per
  intent. The preset in use is always offered, even when Simple would hide it.
- **Show inactive / virtual devices** filters the list only. Hidden devices keep their
  place in the priority order, and whatever is playing right now is never hidden.
- **Engine** installs Equalizer APO, opens its Configurator to hook another endpoint,
  and restores the endpoint registry snapshot.

## Deliberately not built

- **Registering the APO ourselves.** One fewer UAC prompt, in exchange for owning every
  "this endpoint has no audio" report and re-verifying against every APO release.
- **Genre classification from the audio itself.** That is a trained model, not a
  heuristic. The fingerprint plus the track metadata gets the language model there for
  free, so there is nothing to train.
- **31-band parametric EQ with a draggable curve.** The 10-band graphic EQ covers the
  presets; the config generator already emits arbitrary peaking filters, so widening it
  is a change to `BANDS` and the slider layout, not to the engine.
- **Picking which media session to control.** We follow whatever Windows calls the
  current session, same as the volume flyout. `GetSessions()` would let you pin one
  app, and it is a dropdown plus one field of state if it ever matters.
- **Convolution / room correction.** Equalizer APO supports it natively; we just do not
  expose it yet.
