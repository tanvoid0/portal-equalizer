import { invoke } from "@tauri-apps/api/core";
import { firstJson } from "./suggest";
import { AiConfig, NowPlayingInfo } from "./types";

/**
 * "More like this" for whatever the media session is playing.
 *
 * The model is the only part of the app that knows what a track *is*, so it is
 * the only thing that can answer this - the spectrum cannot tell Boards of
 * Canada from any other slow tape-warped thing.
 *
 * Playing the result is where reality bites: SMTC controls the session that
 * already exists, it cannot queue into someone else's app. So a pick is handed
 * to the shell as a search URI in the app that is already playing, which lands
 * the listener one click from the track instead of pretending we can start it.
 */

export interface SimilarTrack {
  title: string;
  artist: string;
  /** Six words or fewer on why it follows from the seed. */
  why: string;
}

const WANTED = 6;

const SYSTEM = `You suggest music similar to the track someone is playing right now.

Reply with ONLY a JSON array, no prose and no code fence:
[{"title":"<track>","artist":"<artist>","why":"<six words or fewer>"}]

Rules:
- Exactly ${WANTED} entries, all real releases you are confident exist.
- Never include the seed track, and at most one track per artist.
- Match the seed's mood, era and production, not just its genre label.
- Prefer adjacent picks over the one obvious hit everyone names.
- Titles and artists exactly as released, so a search finds them.`;

/** Turn a model reply into a list, or throw with a message fit for a toast. */
export function parseSimilar(
  reply: string,
  seed?: { title?: string; artist?: string } | null,
): SimilarTrack[] {
  const raw = firstJson(reply, "[");
  if (!raw) throw new Error(`Model did not return JSON: ${reply.slice(0, 120)}`);
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Model did not return a list.");

  const key = (t: string, a: string) => `${t}|${a}`.toLowerCase().trim();
  const seen = new Set<string>();
  if (seed?.title) seen.add(key(seed.title, seed.artist ?? ""));

  const tracks: SimilarTrack[] = [];
  for (const item of parsed) {
    const title = String((item as SimilarTrack)?.title ?? "").trim();
    const artist = String((item as SimilarTrack)?.artist ?? "").trim();
    if (!title || !artist) continue;
    if (!seen.has(key(title, artist))) {
      seen.add(key(title, artist));
      tracks.push({ title, artist, why: String((item as SimilarTrack)?.why ?? "").slice(0, 60) });
    }
    if (tracks.length === WANTED) break;
  }
  if (!tracks.length) throw new Error("Model returned no usable tracks.");
  return tracks;
}

/**
 * Where to send a pick. Spotify registers a `spotify:` protocol that opens its
 * own search, which keeps the listener in the app already playing; anything
 * else - a browser, a local player, an unknown session - gets YouTube Music,
 * which plays without an account.
 */
export function searchUrl(app: string, t: SimilarTrack): string {
  const q = encodeURIComponent(`${t.artist} ${t.title}`);
  return /spotify/i.test(app) ? `spotify:search:${q}` : `https://music.youtube.com/search?q=${q}`;
}

/** Ask for tracks like the one playing. Throws if nothing is playing. */
export async function askSimilar(cfg: AiConfig, np: NowPlayingInfo | null): Promise<SimilarTrack[]> {
  if (!np?.title) throw new Error("Nothing is playing to be similar to.");
  const user = `Seed track: ${np.title} — ${np.artist || "unknown artist"}${
    np.album ? ` (${np.album})` : ""
  }, playing in ${np.app || "an unknown app"}.

JSON:`;
  return parseSimilar(await invoke<string>("ai_chat", { cfg, system: SYSTEM, user }), np);
}

/** Hand a pick to the shell. The Rust side allowlists the scheme. */
export const play = (app: string, t: SimilarTrack) =>
  invoke("open_url", { url: searchUrl(app, t) });
