import { invoke } from "@tauri-apps/api/core";
import { PRESETS, Preset, findPreset } from "./presets";
import { AiConfig, BANDS, Device, Features, NowPlayingInfo, bandLabel } from "./types";

/**
 * Two ways to choose a preset for whatever is playing.
 *
 * `rank` is local, instant and free: it scores every preset against the tonal
 * correction `analyze.rs` measured, so it answers "what does this signal need"
 * without ever knowing what the signal is.
 *
 * `askAi` is the other half. It sends the same measurements plus the track's
 * title, artist and app to the Agent Platform, which can bring in the one thing
 * a spectrum cannot: knowing that this is a Burial track and should not be
 * treated like the loud compressed pop it measures similarly to.
 */

/** Below this the correction is small enough that Flat is the honest answer. */
const BALANCED_DB = 1.5;
const MAX_GAIN = 12;

export interface Candidate {
  preset: Preset;
  /** -1..1. Above ~0.6 the shapes genuinely agree. */
  score: number;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
const mag = (a: number[]) => Math.sqrt(dot(a, a));
const centre = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return a.map((v) => v - m);
};

/**
 * Rank presets by how closely their shape matches the correction the signal
 * asks for. Cosine similarity compares shape irrespective of size, so the
 * second term re-introduces size: a +9 dB preset is a poor answer to a 1 dB
 * problem even though it points the same way.
 */
export function rank(need: number[], limit = 3): Candidate[] {
  const n = centre(need);
  const nm = mag(n);
  if (nm < BALANCED_DB) {
    const flat = findPreset("Flat")!;
    return [{ preset: flat, score: 1 }];
  }
  return PRESETS.filter((p) => p.name !== "Flat")
    .map((preset) => {
      const g = centre(preset.gains);
      const gm = mag(g) || 1e-6;
      const cos = dot(n, g) / (nm * gm);
      const scale = Math.min(gm, nm) / Math.max(gm, nm);
      return { preset, score: cos * (0.7 + 0.3 * scale) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Loopback capture taps the stream *after* Equalizer APO, so the fingerprint
 * describes the equalised signal, not the source. A correction measured from
 * there says "from where you are, go this much further" - which means a curve
 * that is already right keeps asking for more of itself, and every apply digs
 * deeper. Adding the applied curve back gives the total correction from flat,
 * which is what the sliders hold and what converges: once the curve is right
 * the measurement asks for nothing and the suggestion stops moving.
 */
export const effectiveNeed = (need: number[], applied: number[]) =>
  need.map((v, i) => v + (applied[i] ?? 0));

/** The measured correction itself, ready to drop into the sliders. */
export const autoCurve = (need: number[]) =>
  need.map((v) => Math.max(-MAX_GAIN, Math.min(MAX_GAIN, Math.round(v * 2) / 2)));

/** How far apart two fingerprints are, in total dB. Drives the auto re-ask. */
export const drift = (a: number[] | undefined, b: number[]) =>
  a && a.length === b.length ? a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) : Infinity;

export interface AiSuggestion {
  /** A preset name, or "Custom" when `gains` carries a bespoke curve. */
  preset: string;
  gains: number[];
  reason: string;
  confidence: number;
}

const SYSTEM = `You choose an equalizer preset for the audio a Windows PC is playing right now.

You get: a measured spectral fingerprint of the live output, the track's metadata
if the media session exposes any, the playback device, and the app's own local
best guesses (a purely tonal match, blind to genre).

Reply with ONLY a JSON object, no prose and no code fence:
{"preset":"<exact name from the catalogue, or Custom>","gains":[10 numbers],"reason":"<one short sentence>","confidence":<0-1>}

Rules:
- "gains" is dB per band for 31, 62, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz, each between -12 and 12.
- If you pick a catalogue preset, still return its gains verbatim.
- Only return "Custom" when no catalogue preset fits; then keep the curve gentle and musical.
- Prefer the track's actual genre over the tonal guess when the metadata tells you what it is.
- Respect the device: tiny speakers cannot reproduce a sub boost, and a boosted curve on
  an already bass-heavy headphone makes it worse.
- Do not chase the measurement flat. Music is meant to be tilted.
- If nothing is playing, choose Flat with low confidence.`;

const catalogue = () =>
  PRESETS.map((p) => `${p.name} [${p.sub ?? p.group}] ${p.blurb} ${JSON.stringify(p.gains)}`).join("\n");

function describe(
  f: Features,
  np: NowPlayingInfo | null,
  dev: Device | null,
  top: Candidate[],
  applied: number[],
) {
  const bands = BANDS.map((hz, i) => `${bandLabel(hz)}=${f.bands[i]?.toFixed(0)}`).join(" ");
  const need = BANDS.map((hz, i) => `${bandLabel(hz)}=${f.need[i] > 0 ? "+" : ""}${f.need[i]}`).join(" ");
  const track = np?.title
    ? `${np.title} — ${np.artist || "unknown artist"}${np.album ? ` (${np.album})` : ""}, playing in ${np.app || "an unknown app"}`
    : "no media session metadata available";
  const device = dev
    ? `${dev.adapter || dev.name} (${dev.name}), form factor ${dev.form_factor}${dev.bluetooth ? ", Bluetooth" : ""}`
    : "unknown";

  return `Now playing: ${track}
Output device: ${device}
Signal is ${f.active ? "active" : "SILENT"}
Band levels dB: ${bands}
Spectral slope: ${f.slope} dB/octave (about -3.5 is a balanced mix)
Centroid: ${f.centroid_hz} Hz | onset density: ${f.flux} | crest: ${f.crest_db} dB | loudness: ${f.loudness_db} dBFS
EQ already applied (the measurement above includes it): ${applied.some((g) => g) ? BANDS.map((hz, i) => `${bandLabel(hz)}=${applied[i]}`).join(" ") : "none"}
Total correction from flat that this implies: ${need}
Local tonal guesses: ${top.map((c) => `${c.preset.name} (${c.score.toFixed(2)})`).join(", ") || "none"}

Preset catalogue:
${catalogue()}

JSON:`;
}

/** First balanced {...} span in a reply, so a chatty model still parses. */
function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Turn a model reply into something we would have accepted from a slider, or
 * throw with a message fit for a toast.
 */
export function parseSuggestion(reply: string): AiSuggestion {
  const raw = firstObject(reply);
  if (!raw) throw new Error(`Model did not return JSON: ${reply.slice(0, 120)}`);
  const parsed = JSON.parse(raw) as Partial<AiSuggestion>;

  const name = String(parsed.preset ?? "").trim();
  const known = findPreset(name);
  // Trust the catalogue over the model's transcription of it: a named preset
  // always applies its own gains, so a hallucinated curve cannot ride in under
  // a familiar label.
  const gains = known
    ? known.gains.slice()
    : (Array.isArray(parsed.gains) ? parsed.gains : []).map((v) =>
        Math.max(-MAX_GAIN, Math.min(MAX_GAIN, Math.round(Number(v) * 2) / 2 || 0)),
      );
  if (gains.length !== BANDS.length) {
    throw new Error(`Model returned an unusable curve for "${name || "?"}".`);
  }

  return {
    preset: known ? known.name : name || "Custom",
    gains,
    reason: String(parsed.reason ?? "").slice(0, 200),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
  };
}

/** Ask the Agent Platform for a preset for what is playing right now. */
export async function askAi(
  cfg: AiConfig,
  f: Features,
  np: NowPlayingInfo | null,
  dev: Device | null,
  applied: number[],
): Promise<AiSuggestion> {
  const reply = await invoke<string>("ai_chat", {
    cfg,
    system: SYSTEM,
    user: describe(f, np, dev, rank(f.need, 3), applied),
  });
  return parseSuggestion(reply);
}
