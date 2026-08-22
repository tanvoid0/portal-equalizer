import { invoke } from "@tauri-apps/api/core";
import { firstJson } from "./suggest";
import { AiConfig, CatalogueTrack, NowPlayingInfo } from "./types";

/**
 * "More like this" for whatever the media session is playing.
 *
 * The model is the only part of the app that knows what a track *is*, so it is
 * the only thing that can answer this - the spectrum cannot tell Boards of
 * Canada from any other slow tape-warped thing.
 *
 * Playing the result is where reality bites: SMTC controls the session that
 * already exists, it cannot put anything into it. Three tiers, best first:
 *
 * 1. Spotify connected - the pick is resolved to a real catalogue URI and
 *    queued or played through Spotify's own API. This is the real feature.
 * 2. Not connected - MusicBrainz still says whether the track exists, so the
 *    invented ones are dropped, and a pick opens a search where it can be
 *    played by hand.
 * 3. Neither reachable - the suggestions stand unchecked rather than being
 *    thrown away, and the strip says so.
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

/** Open a pick's search page. The fallback when there is nothing to queue on. */
export const openSearch = (app: string, t: SimilarTrack) =>
  invoke("open_url", { url: searchUrl(app, t) });

/* --------------------------------------------------------------- resolving */

/**
 * A suggestion checked against a real catalogue.
 *
 * `unchecked` matters: a lookup that failed is not a track that does not exist,
 * and throwing away real suggestions because MusicBrainz was down would be a
 * worse bug than the hallucinations this is here to catch.
 */
export interface Resolved extends SimilarTrack {
  /** Playable, when Spotify found it. */
  uri: string | null;
  found: "found" | "missing" | "unchecked";
}

/**
 * Strip everything a catalogue adds and a model does not: "- 2011 Remaster",
 * "(feat. X)", "[Explicit]". Without this half the real matches look wrong.
 */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\s-\s.*$/, " ")
    .replace(/\b(feat|ft|featuring|with|and|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Share of the words the two have in common, over the longer side.
 *
 * Over the longer, not the shorter: against the shorter, a one-word title
 * scores a perfect match on anything that merely contains it, and "Tesla"
 * queues "Tesla Girls". `norm` has already removed the suffixes that would
 * make this too strict.
 */
function overlap(a: string, b: string): number {
  const x = new Set(norm(a).split(" ").filter(Boolean));
  const y = new Set(norm(b).split(" ").filter(Boolean));
  if (!x.size || !y.size) return 0;
  let hit = 0;
  x.forEach((w) => y.has(w) && hit++);
  return hit / Math.max(x.size, y.size);
}

/** Above this, both title and artist, the catalogue entry is the same track. */
const MATCH = 0.75;

/**
 * The best catalogue entry for a suggestion, or null.
 *
 * Both sides must agree - a search for an invented track happily returns the
 * artist's real songs, and accepting on artist alone would queue the wrong one
 * every time the model made something up.
 */
export function bestMatch(want: SimilarTrack, found: CatalogueTrack[]): CatalogueTrack | null {
  let best: { t: CatalogueTrack; score: number } | null = null;
  for (const t of found) {
    const title = overlap(want.title, t.title);
    const artist = overlap(want.artist, t.artist);
    if (title < MATCH || artist < MATCH) continue;
    const score = title + artist;
    // On a tie take the plainer title. A catalogue answers with the album cut
    // and three of "- Radio Edit", "- Remastered 2011", "- Live"; they all
    // normalise to the same thing, and the one without the suffix is the one
    // the suggestion meant.
    const closer =
      !best || score > best.score || (score === best.score && t.title.length < best.t.title.length);
    if (closer) best = { t, score };
  }
  return best?.t ?? null;
}

/**
 * Check each suggestion against a catalogue, in order.
 *
 * Sequential on purpose: MusicBrainz allows one request a second and Spotify
 * rate-limits, and six lookups fired at once is how you get throttled for the
 * rest of the session.
 */
export async function resolve(picks: SimilarTrack[], connected: boolean): Promise<Resolved[]> {
  const out: Resolved[] = [];
  for (const p of picks) {
    try {
      const found = connected
        ? await invoke<CatalogueTrack[]>("spotify_search", { query: `${p.artist} ${p.title}` })
        : await invoke<CatalogueTrack[]>("mb_search", { title: p.title, artist: p.artist });
      const hit = bestMatch(p, found);
      out.push({
        ...p,
        // Keep the catalogue's spelling: it is the one that is right.
        ...(hit ? { title: hit.title, artist: hit.artist } : {}),
        uri: hit?.uri || null,
        found: hit ? "found" : "missing",
      });
    } catch {
      out.push({ ...p, uri: null, found: "unchecked" });
    }
  }
  return out;
}

/** Put a pick after the current track. Premium, and a woken device, required. */
export const queue = (uri: string) => invoke<void>("spotify_queue", { uri });

/** Skip to it now, keeping whatever context was playing. */
export const playNow = (uri: string) => invoke<void>("spotify_play", { uri });
