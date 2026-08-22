# Portal Equalizer

System-wide EQ, live spectrum, and priority-based audio device switching for Windows.

## What it is

The DSP is not ours. [Equalizer APO](https://sourceforge.net/projects/equalizerapo/)
already does system-wide, per-device, per-channel equalisation at essentially zero
latency cost, and it is driven by a plain text config file. This app generates that
file. What it adds is everything Equalizer APO does not have: a usable interface,
presets, a live analyser, and device switching.

```
React + Tailwind + motion  ──invoke/events──  Rust (Tauri 2)
                                                ├── audio.rs    MMDevice enumeration, IPolicyConfig default-switching
                                                ├── rank.rs     "smart organise" ordering
                                                ├── eapo.rs     config.txt generation
                                                ├── spectrum.rs WASAPI loopback -> FFT -> 48 bars
                                                ├── analyze.rs  the same FFT -> spectral fingerprint
                                                ├── ai.rs       chat transport to Agent Platform
                                                ├── media.rs    SMTC now-playing, cover art, transport
                                                ├── approuting.rs per-app routing rules
                                                └── store.rs     settings.json
```

## Running it

```bash
pnpm install && pnpm tauri dev
```

Checks — the preset matcher and model-reply parser, then the Rust side:

```bash
pnpm check && cargo test --manifest-path src-tauri/Cargo.toml
```

Diagnostic dump of every endpoint, how it ranks, and the config that would be written:

```bash
cargo run --example probe --manifest-path src-tauri/Cargo.toml
```

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
[Agent Platform](../../ai/agentic-ai/agent-platform) at `/v1/chat/completions`, and takes
back a preset name or a bespoke curve with one line of reasoning. Auto mode re-asks only
when the correction drifts more than 10 dB total or the track changes, and never more
often than every 20 seconds.

A named preset always applies the catalogue's own gains, never the model's transcription
of them, so a hallucinated curve cannot arrive wearing a familiar label. Custom curves are
clamped to the same ±12 dB the sliders allow, and every suggestion needs a click — nothing
the model says reaches the audio path on its own.

The HTTP call is made in Rust rather than with `fetch`: a request from the webview would
need the platform started with `AGENT_PLATFORM_CORS_ORIGINS` set for the Tauri origin.
Token goes in Settings ⚙ or `$AGENT_PLATFORM_TOKEN`; blank means no auth header, which is
what a default local install expects.

## Things that are true and were not obvious

**`Device:` lines match on substrings, and `;` means OR.** Equalizer APO matches every
space-separated word of the pattern against `"<device> <connection> <GUID>"`, and treats
a semicolon as separating *alternative patterns*. So `Device: Headphones; Logi Z607`
does not mean "the Logi Z607 headphones" — it means "anything called Headphones, OR
anything called Logi Z607", which silently applies one device's EQ to every headphone
endpoint on the machine. We emit the bare endpoint GUID instead, which is unique and
appears in that same match string. If it ever fails to match, `eapo_match` in
`settings.json` overrides the pattern per device.

**Equalizer APO has to be installed *on each endpoint*.** Its installer asks which
devices to hook. An endpoint it was not ticked for gets no EQ at all, silently. We
detect this by reading the APO CLSIDs out of the endpoint's `FxProperties` registry key
and show a `no eq` badge. Re-run the Configurator to add a device.

**`Position` on a media session is a stamp, not a clock.** It is the position as
of `LastUpdatedTime`, and apps refresh it whenever they feel like it - Chrome will
leave one sitting for minutes while the video plays on. Reported raw, the timer is
wrong and every "skip 10 s" jumps somewhere else entirely, because it seeks relative
to the stale stamp. `live_position` ages it forward by `now - LastUpdatedTime` while
playing, and the skip buttons seek to an absolute position taken from what is on
screen.

**Blocking on WinRT async is illegal from an STA.** The now-playing session
(`GlobalSystemMediaTransportControlsSessionManager`) is a WinRT API, so every call
that matters is an `IAsyncOperation` we have to `.get()`. A Tauri command thread has
usually already been made apartment-threaded by `audio.rs`, and `.get()` there
deadlocks or fails outright. `media.rs` therefore owns one MTA thread; the
`media_control` command only posts to it over a channel, which also gets us an
immediate re-poll after a button press for free.

**`PKEY_AudioEngine_DeviceFormat` is a serialised PROPVARIANT**, not a bare
`WAVEFORMATEX` — the struct starts at byte 8. Parsing from byte 0 yields 0 channels at
1 Hz.

**Bluetooth Hands-Free (HFP) endpoints are a trap.** They are mono 16 kHz, and selecting
one drags the whole link out of A2DP, so playback quality collapses. Smart organise
penalises them heavily and never pairs one with its own headset.

**Virtual devices lie about what they are.** "Boom Audio" and "Steam Streaming Speakers"
report FormFactor `Speakers` exactly like real hardware. The reliable discriminator is
the device instance path: software endpoints sit on the `ROOT\` bus, real gear is on
`USB\`, `HDAUDIO\`, `BTHENUM\`.

**Setting the default device has no public API.** Every tool that does it calls the
undocumented `IPolicyConfig`. We declare its vtable with ten opaque padding slots to
land on `SetDefaultEndpoint` at the right offset.

**Per-app routing is a second, unrelated undocumented API.** "Spotify → Z607" goes
through `IAudioPolicyConfigFactory` — WinRT, activated by class name, twenty-two
padding slots this time — and wants the endpoint id wrapped in a device-interface
path, not the bare id. It persists per *executable*, so an app only has to be caught
running once and Windows re-applies the rule on every later launch itself. That is
why a rule is not a daemon: the 1 s poll that already watches for hotplugs is enough.
Full workings, including what its registry store does and does not tell you, in
**[docs/per-app-routing.md](docs/per-app-routing.md)**.

## Deliberately not built

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

## Notes

- Your pre-existing `config.txt` is backed up once to `config.portal-backup.txt` before
  we take ownership of it.
- Settings live in `%APPDATA%\PortalEqualizer\settings.json`.
- The automatic preamp is `-(loudest positive band + 0.5 dB)`, which is what prevents
  a boosted curve from clipping.
