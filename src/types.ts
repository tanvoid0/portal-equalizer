export type Flow = "render" | "capture";

export interface Device {
  id: string;
  /** Endpoint name, e.g. "Headphones". */
  name: string;
  /** Adapter name, e.g. "Logi Z607". */
  adapter: string;
  flow: Flow;
  state: "active" | "unplugged" | "disabled" | "notpresent";
  is_default: boolean;
  /** Equalizer APO is hooked into this endpoint, so EQ is actually audible. */
  eapo: boolean;
  channels: number;
  sample_rate: number;
  /** EndpointFormFactor: 1 speakers, 3 headphones, 4 mic, 5 headset, 8 SPDIF, 9 HDMI. */
  form_factor: number;
  /** Software endpoint (Steam, Oculus, virtual cable) rather than real hardware. */
  virtual_device: boolean;
  bluetooth: boolean;
  /** Bluetooth Hands-Free: mono 16 kHz, and using it wrecks playback quality. */
  hands_free: boolean;
}

export interface DeviceEq {
  enabled: boolean;
  preamp: number;
  preset: string;
  gains: number[];
}

export interface Settings {
  /** Every known device id, most-wanted first. Outputs and inputs share one
   *  list — the winner is picked per flow, so they never compete. */
  priority: string[];
  auto_switch: boolean;
  /** Device ids the user has switched off: never auto-switched to, no EQ block,
   *  hidden from the list unless you ask to see them. */
  ignored: string[];
  device_presets: Record<string, DeviceEq>;
  eapo_match: Record<string, string>;
  /** Per-app routing. A pinned app ignores the priority list entirely. */
  app_rules: AppRule[];
  ai: AiConfig;
  /** Show endpoints that are unplugged, disabled or absent. */
  show_inactive: boolean;
  /** Show software endpoints - Steam, Oculus, virtual cables. */
  show_virtual: boolean;
  /** How much of the preset catalogue the rail offers. */
  preset_mode: PresetMode;
  /** Closing the window hides it to the tray instead of quitting. */
  close_to_tray: boolean;
  /** Start with no window, tray only. */
  start_minimised: boolean;
}

export type PresetMode = "simple" | "advanced";

/** "Spotify always plays to the Z607." Keyed on the executable file name,
 *  because an app that self-updates changes its full path. */
export interface AppRule {
  /** Lowercased exe file name, e.g. "spotify.exe". */
  exe: string;
  device_id: string;
  flow: Flow;
}

/** Agent Platform connection used for AI preset suggestions. */
/** One model the server offers, and the provider it came from. */
export interface AiModel {
  id: string;
  /** `owned_by`. Empty when the server did not say. */
  provider: string;
}

export interface AiConfig {
  /** Host root of an OpenAI-compatible server, not a /v1 path. Empty is off:
   * the local tonal match still works without a server. */
  base_url: string;
  /** Left empty, the Rust side falls back to $AGENT_PLATFORM_TOKEN. */
  token: string;
  /** Override. Empty lets the platform route to its own configured default. */
  model: string;
  /** Smart mode - re-ask on its own when what is playing changes character. */
  auto: boolean;
}

/** Spotify connection, from `spotify.rs`. Playing a suggestion needs one. */
export interface SpotifyStatus {
  /** A sealed refresh token is on disk - not that it still works. */
  connected: boolean;
  client_id: string;
  /** Must be pasted into the Spotify dashboard character for character. */
  redirect_uri: string;
  /** Only filled in by `spotify_me`, which actually asks. */
  name: string;
  /** "premium" or "free". Only Premium can control playback. */
  product: string;
}

/** A real catalogue entry. From Spotify, or from MusicBrainz with no `uri`. */
export interface CatalogueTrack {
  uri: string;
  title: string;
  artist: string;
  album: string;
}

/** Spectral fingerprint of what is playing right now, from `analyze.rs`. */
export interface Features {
  /** Level per EQ band, dB. */
  bands: number[];
  /** The tonal correction those levels imply, dB per band. Zero-mean. */
  need: number[];
  /** Measured spectral slope, dB per octave. ~-3.5 is a balanced mix. */
  slope: number;
  centroid_hz: number;
  /** Onset density 0-1. High is percussive and fast. */
  flux: number;
  /** Peak-to-average of the loudness envelope, dB. Low means squashed. */
  crest_db: number;
  loudness_db: number;
  /** False when the output is silent. */
  active: boolean;
}

export type RepeatMode = "none" | "track" | "list";

/** The Windows media session (SMTC) the volume overlay's flyout also shows. */
export interface NowPlayingInfo {
  playing: boolean;
  title: string;
  artist: string;
  album: string;
  /** Owning app, e.g. "Spotify". */
  app: string;
  position_ms: number;
  duration_ms: number;
  can_next: boolean;
  can_prev: boolean;
  can_seek: boolean;
  can_shuffle: boolean;
  can_repeat: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Cover art arrives on its own event; this says which track it belongs to. */
  art_key: string;
  /** Every app holding a media session right now. */
  sources: MediaSource[];
  /** Which of them the fields above describe. */
  source_id: string;
  /** Following this app by choice, not because Windows put it in front. */
  pinned: boolean;
  /** Default output volume, 0..1, and its mute state. */
  volume: number;
  muted: boolean;
}

export interface MediaSource {
  id: string;
  app: string;
  playing: boolean;
}

export interface EapoStatus {
  installed: boolean;
  config_path: string | null;
  writable: boolean;
  hooked_devices: number;
  /** Whether this build carries the engine installer, or only a link to it. */
  installer_bundled: boolean;
  /** Whether there is an endpoint registry snapshot to restore from. */
  has_backup: boolean;
}

/** Must stay in step with `eapo::BANDS` on the Rust side. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

export const defaultEq = (): DeviceEq => ({
  enabled: true,
  preamp: 0,
  preset: "Flat",
  gains: Array(BANDS.length).fill(0),
});

/**
 * Is there an AI server to ask? `model` used to stand in for this, back when
 * blank meant "no AI"; blank now means "let the platform choose", so the
 * address is the only thing left that says whether to ask at all.
 */
export function aiOn(cfg: AiConfig): boolean {
  return cfg.base_url.trim() !== "";
}
