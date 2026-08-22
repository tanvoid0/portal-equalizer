# Development

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

## Browser mock

The UI runs in a plain browser with the Tauri IPC stubbed out, so a layout or styling
change needs no Rust rebuild:

```bash
pnpm dev:mock
```

`vite.mock.config.ts` aliases `@tauri-apps/api/{core,event,window}` to `src/mock/`.
Nothing in `src/` imports that directory, and the normal `pnpm dev` / `pnpm tauri dev`
paths never see it. The stubs answer with deliberately awkward data — a hands-free
Bluetooth endpoint, an unplugged HDMI output with no Equalizer APO hook, a virtual
cable, a switched-off device — because those are the rows that break layouts and the
ones you never have plugged in when you need them.

Add a case to `src/mock/core.ts` for any new command. A command with no case answers
`null`, which reaches the UI as a missing field rather than an error, and the crash
turns up somewhere unrelated.

The screenshots in `docs/screenshots/` are taken from this harness, so they never
contain anyone's real device names or listening history.

## Bundling the engine installer

Drop Equalizer APO's installer into `src-tauri/resources/` and the release carries it,
so users never leave the app to get the DSP engine. Any file there whose name starts
with `EqualizerAPO` and ends in `.exe` is picked up — see
[src-tauri/resources/README.md](../src-tauri/resources/README.md).

Leave the folder empty and everything still builds: `install_engine` falls back to
opening the download page, and `eapo_status.installer_bundled` reports `false` so the
UI says so.

## Releasing

Tag pushes matching `v*.*.*` build a signed Windows installer, publish it as a
GitHub release and write the `latest.json` the built-in updater reads. The tag
has to match `version` in `src-tauri/tauri.conf.json` — the updater compares the
version baked into the bundle, not the tag, so the workflow refuses a mismatch
rather than shipping a build nobody updates to.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Two repository secrets are needed, from `pnpm tauri signer generate`:
`TAURI_SIGNING_PRIVATE_KEY` (the contents of the private key file) and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The matching public key lives in
`tauri.conf.json`; installs verify every update against it, so losing the
private key means existing installs can never be updated again.
