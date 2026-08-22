/** Stub for `@tauri-apps/api/core`. See ./README.md. */

const DEV = (
  id: string,
  name: string,
  adapter: string,
  flow: "render" | "capture",
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  adapter,
  flow,
  state: "active",
  is_default: false,
  eapo: true,
  channels: 2,
  sample_rate: 48000,
  form_factor: 1,
  virtual_device: false,
  bluetooth: false,
  hands_free: false,
  ...extra,
});

/** One of each awkward case, because those are what break a layout. */
const devices = [
  DEV("d1", "Speakers", "Logi Z607", "render", { is_default: true }),
  DEV("d2", "Headphones", "Sennheiser HD 560S", "render", { form_factor: 3 }),
  DEV("d3", "Headset", "WH-1000XM5 Hands-Free", "render", {
    bluetooth: true,
    hands_free: true,
    form_factor: 5,
    channels: 1,
    sample_rate: 16000,
  }),
  DEV("d4", "Digital Output", "LG HDR 4K (HDMI)", "render", {
    form_factor: 9,
    eapo: false,
    state: "unplugged",
  }),
  DEV("d5", "Line", "VoiceMeeter Input", "render", { virtual_device: true }),
  DEV("d6", "Microphone", "Blue Yeti", "capture", { is_default: true, form_factor: 4 }),
  DEV("d7", "Microphone Array", "Realtek", "capture", { form_factor: 4 }),
];

const settings = {
  priority: ["d1", "d2", "d3", "d4", "d5", "d6", "d7"],
  auto_switch: true,
  ignored: ["d5"],
  device_presets: {
    d1: { enabled: true, preamp: 0, preset: "V-Shape", gains: [6, 5, 2, -1, -3, -3, -1, 2, 5, 6] },
  },
  eapo_match: {},
  app_rules: [{ exe: "spotify.exe", device_id: "d2", flow: "render" }],
  ai: { base_url: "http://127.0.0.1:18410", model: "", token: "", auto: false },
};

export async function invoke(cmd: string, _args?: unknown): Promise<any> {
  switch (cmd) {
    case "get_settings":
      return settings;
    case "list_devices":
      return devices;
    case "eapo_status":
      return {
        installed: true,
        config_path: "C:\\Program Files\\EqualizerAPO\\config\\config.txt",
        writable: true,
        hooked_devices: 3,
      };
    case "list_processes":
      return ["spotify.exe", "chrome.exe", "discord.exe"];
    case "list_app_rules":
      return [
        { exe: "spotify.exe", device_id: "d2", flow: "render" },
        { exe: "discord.exe", device_id: "d3", flow: "capture" },
      ];
    case "get_now_playing":
      return {
        playing: true,
        title: "Nightcall",
        artist: "Kavinsky",
        album: "OutRun",
        app: "Spotify",
        position_ms: 78_000,
        duration_ms: 257_000,
        can_next: true,
        can_prev: true,
        can_seek: true,
        can_shuffle: true,
        can_repeat: true,
        shuffle: false,
        repeat: "none",
        art_key: "k1",
        sources: [
          { id: "s1", app: "Spotify", playing: true },
          { id: "s2", app: "Chrome", playing: false },
        ],
        source_id: "s1",
        pinned: false,
        volume: 0.62,
        muted: false,
        art: null,
      };
    case "smart_organise":
      return settings.priority;
    default:
      return null;
  }
}
