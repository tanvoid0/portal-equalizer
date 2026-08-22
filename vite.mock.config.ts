import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Runs the UI in a plain browser against the stubs in src/mock, so a layout
 * change can be looked at without a Rust rebuild. See src/mock/README.md.
 *
 * Separate from vite.config.ts on purpose: nothing here can leak into a real
 * build, because `pnpm tauri build` never loads this file.
 */
const mock = (name: string) => fileURLToPath(new URL(`./src/mock/${name}.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: mock("core") },
      { find: "@tauri-apps/api/event", replacement: mock("event") },
      { find: "@tauri-apps/api/window", replacement: mock("window") },
    ],
  },
});
