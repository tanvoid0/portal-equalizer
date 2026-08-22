# Things that are true and were not obvious

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
and show a `no eq` badge. The Engine panel in Settings opens the Configurator to add one.

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
**[per-app-routing.md](per-app-routing.md)**.
