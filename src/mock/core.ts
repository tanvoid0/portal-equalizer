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
  // A model is set so the Smart panel's "Ask AI" is live rather than greyed
  // out - an empty model is what disables it, and a screenshot of a dead
  // button reads as a broken feature.
  ai: { base_url: "http://127.0.0.1:18410", model: "claude-opus-5", token: "", auto: false },
};

/** Stand-in sleeve for the player. Generated, not a real album cover:
 *  the repo has no business carrying someone else's artwork. */
const COVER = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22300%22%20height%3D%22300%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%230f766e%22%2F%3E%3Cstop%20offset%3D%220.55%22%20stop-color%3D%22%231e1b4b%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23c2410c%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22300%22%20height%3D%22300%22%20fill%3D%22url%28%23g%29%22%2F%3E%3Ccircle%20cx%3D%22150%22%20cy%3D%22150%22%20r%3D%2292%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-opacity%3D%22.28%22%20stroke-width%3D%222%22%2F%3E%3Ccircle%20cx%3D%22150%22%20cy%3D%22150%22%20r%3D%2258%22%20fill%3D%22none%22%20stroke%3D%22%23fff%22%20stroke-opacity%3D%22.2%22%20stroke-width%3D%222%22%2F%3E%3Ccircle%20cx%3D%22150%22%20cy%3D%22150%22%20r%3D%2216%22%20fill%3D%22%230b1020%22%20fill-opacity%3D%22.75%22%2F%3E%3C%2Fsvg%3E";

export async function invoke(cmd: string, args?: any): Promise<any> {
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
        installer_bundled: true,
        has_backup: true,
      };
    case "ai_models":
      return [
        { id: "claude-opus-5", provider: "anthropic" },
        { id: "claude-sonnet-5", provider: "anthropic" },
        { id: "llama3.1", provider: "ollama" },
      ];
    case "install_engine":
      return "Installer running. Tick every endpoint you want EQ on, then reboot.";
    case "open_configurator":
    case "restore_audio_endpoints":
      return null;
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
        art: COVER,
      };
    case "spotify_status":
      return {
        connected: false,
        client_id: "",
        redirect_uri: "http://127.0.0.1:18411/callback",
        name: "",
        product: "",
      };
    // Everything the model names "exists" in mock, so the strip renders the
    // verified path without a network round trip.
    case "mb_search":
      return [{ uri: "", title: args?.title ?? "", artist: args?.artist ?? "", album: "" }];
    case "smart_organise":
      return settings.priority;
    default:
      return null;
  }
}
