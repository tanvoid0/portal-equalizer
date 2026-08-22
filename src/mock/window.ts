/** Stub for `@tauri-apps/api/window`. See ./README.md. */

export const getCurrentWindow = () => ({
  isMaximized: async () => false,
  onResized: async (_f: unknown) => () => {},
  minimize() {},
  toggleMaximize() {},
  close() {},
});
