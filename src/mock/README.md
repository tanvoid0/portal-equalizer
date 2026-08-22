# Browser mock

Runs the UI in a plain browser with the Tauri IPC stubbed out, so a layout or
styling change can be looked at without a Rust rebuild:

    pnpm dev:mock

`vite.mock.config.ts` aliases `@tauri-apps/api/{core,event,window}` to the
stubs here. Nothing in `src/` imports this directory, and the normal
`pnpm dev` / `pnpm tauri dev` paths never see it.

The stubs answer with fixed, deliberately awkward data - a hands-free
Bluetooth endpoint, an unplugged HDMI output with no Equalizer APO hook, a
virtual cable, a switched-off device - because those are the rows that break
layouts and the ones you never have plugged in when you need them.

They are intentionally loose about types: `invoke` returns `Promise<any>`, so
adding a field to `Settings` does not break the harness, it just arrives
undefined. If a new field changes what the UI renders, add it below.
