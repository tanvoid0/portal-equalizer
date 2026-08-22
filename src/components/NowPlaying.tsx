import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { AiConfig, NowPlayingInfo, RepeatMode, SpotifyStatus } from "../types";
import { Resolved, askSimilar, openSearch, playNow, queue, resolve } from "../similar";
import { Spectrum } from "./Spectrum";

const send = (action: string, value?: number, id?: string) =>
  invoke("media_control", { action, value, id }).catch(() => {});

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** off -> repeat the queue -> repeat this track -> off. */
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { none: "list", list: "track", track: "none" };
const REPEAT_WIRE: Record<RepeatMode, number> = { none: 0, track: 1, list: 2 };
/** How long a local volume drag outranks what the backend reports. */
const VOLUME_GRACE = 900;
/** Ditto for a seek: an app can take a moment to restamp its timeline, and
 *  believing the old stamp in the meantime snaps the bar back where it was. */
const SEEK_GRACE = 2500;

const PLAY = "M8 5.14v13.72a1 1 0 0 0 1.54.84l10.1-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z";
const PAUSE = "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z";
const PREV = "M7 5h2.2v14H7zm11.3-.7v15.4a.7.7 0 0 1-1.1.6L10 13.1v-2.2l7.2-6.2a.7.7 0 0 1 1.1.6Z";
const NEXT = "M14.8 5H17v14h-2.2zM5.7 4.3l7.2 6.2v2.2L5.7 19a.7.7 0 0 1-1.1-.6V4.9a.7.7 0 0 1 1.1-.6Z";
const BACK10 = "M12.5 5V2L8 6l4.5 4V7a5.5 5.5 0 1 1-5.5 5.5H5A7.5 7.5 0 1 0 12.5 5Z";
const FWD10 = "M11.5 5V2L16 6l-4.5 4V7A5.5 5.5 0 1 0 17 12.5h2A7.5 7.5 0 1 1 11.5 5Z";
const SHUFFLE =
  "M17 3.5 21 7l-4 3.5V8.4h-1.6c-1 0-1.7.4-2.4 1.4l-.9 1.3-1.2-1.8.6-.8C12.6 6.9 13.9 6.3 15.4 6.3H17V3.5ZM3 6.3h2.9c1.6 0 2.9.7 3.9 2.2l4 5.9c.6.9 1.3 1.3 2.2 1.3H17v-2.2L21 17l-4 3.5v-2.2h-1c-1.6 0-2.9-.7-3.9-2.2l-4-5.9c-.6-.9-1.3-1.3-2.2-1.3H3V6.3Zm0 9.4h2.9c.9 0 1.6-.4 2.2-1.2l.4-.6 1.2 1.8-.2.3c-1 1.4-2.2 2-3.6 2H3v-2.3Z";
const REPEAT = "M7 7h9v2.5L20 6l-4-3.5V5H5v6h2V7Zm10 10H8v-2.5L4 18l4 3.5V19h11v-6h-2v4Z";
const NOTE = "M12 3v10.6A3.5 3.5 0 1 0 14 16.5V8h4V3h-6Z";
const LOUD =
  "M4 9.5h3.2L12 5.2v13.6L7.2 14.5H4v-5Zm11.6-2.1a6.2 6.2 0 0 1 0 9.2l-1.3-1.5a4.2 4.2 0 0 0 0-6.2l1.3-1.5Zm2.6-2.6a9.6 9.6 0 0 1 0 14.4l-1.3-1.5a7.6 7.6 0 0 0 0-11.4l1.3-1.5Z";
const MUTED =
  "M4 9.5h3.2L12 5.2v13.6L7.2 14.5H4v-5Zm12.9 2.5 2.6-2.6-1.4-1.4-2.6 2.6-2.6-2.6-1.4 1.4 2.6 2.6-2.6 2.6 1.4 1.4 2.6-2.6 2.6 2.6 1.4-1.4-2.6-2.6Z";

function Icon({ path, className = "" }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={path} />
    </svg>
  );
}

function Button({
  label,
  onClick,
  disabled,
  active,
  size = 8,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  size?: 7 | 8 | 11;
  children: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.88 }}
      className={`grid shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-25 ${
        size === 11 ? "h-11 w-11" : size === 8 ? "h-8 w-8" : "h-7 w-7"
      } ${
        active
          ? "border-glow/40 bg-glow/[0.14] text-glow shadow-[0_0_20px_-6px_rgba(94,234,212,0.8)]"
          : "border-white/10 bg-white/[0.05] text-slate-300 hover:border-white/25 hover:text-slate-100"
      }`}
    >
      {children}
    </motion.button>
  );
}

/**
 * A drag/click track shared by the scrubber and the volume slider - same
 * pointer maths, different geometry.
 */
function Bar({
  value,
  label,
  text,
  disabled,
  onScrub,
  className = "",
  accent = "bg-glow/80",
}: {
  /** 0..1 */
  value: number;
  label: string;
  text: string;
  disabled?: boolean;
  onScrub: (ratio: number, commit: boolean) => void;
  className?: string;
  accent?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const at = (e: React.PointerEvent, commit: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    onScrub(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), commit);
  };
  const pct = `${Math.min(100, Math.max(0, value * 100))}%`;

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={text}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        const to = e.key === "ArrowRight" ? value + step : e.key === "ArrowLeft" ? value - step : null;
        if (to === null || disabled) return;
        e.preventDefault();
        onScrub(Math.min(1, Math.max(0, to)), true);
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDragging(true);
        at(e, false);
      }}
      onPointerMove={(e) => dragging && at(e, false)}
      onPointerUp={(e) => {
        if (!dragging) return;
        setDragging(false);
        at(e, true);
      }}
      className={`group relative h-4 ${disabled ? "" : "cursor-pointer"} ${className}`}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/10" />
      <div
        className={`absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full ${accent}`}
        style={{ width: pct }}
      />
      {!disabled && (
        <div
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-100 shadow shadow-black/60 transition-opacity group-hover:opacity-100"
          style={{ left: pct, opacity: dragging ? 1 : 0 }}
        />
      )}
    </div>
  );
}

/**
 * The Windows media session, rendered as a player. Metadata arrives on
 * `now_playing`, cover art separately on `now_playing_art` (it is a base64 blob,
 * so it is only sent when the track changes) - and because both only fire on
 * *change*, a window that opens later pulls the current state once on mount.
 */
export function NowPlaying({ cfg }: { cfg: AiConfig }) {
  const [np, setNp] = useState<NowPlayingInfo | null>(null);
  const [art, setArt] = useState<{ key: string; data: string | null } | null>(null);
  const [pos, setPos] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  /** What we asked for but have not been told happened yet. */
  const [pending, setPending] = useState<boolean | null>(null);
  const [vol, setVol] = useState<number | null>(null);
  /** "More like this": the picks, what stage it is at, and what went wrong. */
  const [similar, setSimilar] = useState<Resolved[] | null>(null);
  const [stage, setStage] = useState<"" | "asking" | "checking">("");
  const [simError, setSimError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [spotify, setSpotify] = useState<SpotifyStatus | null>(null);
  const volAt = useRef(0);
  const seeked = useRef({ ms: 0, at: 0 });

  // Position only arrives twice a second, and some apps update their timeline
  // far more lazily than that, so run the clock locally from the last report.
  const base = useRef({ ms: 0, at: 0 });

  useEffect(() => {
    const take = (p: NowPlayingInfo | null) => {
      const at = performance.now();
      const since = at - seeked.current.at;
      // Only distrust the report if it disagrees with where we just seeked to.
      const stale =
        p && since < SEEK_GRACE && Math.abs(p.position_ms - (seeked.current.ms + since)) > 2000;
      if (!stale) base.current = { ms: p?.position_ms ?? 0, at };
      setNp(p);
    };

    invoke<(NowPlayingInfo & { art: string | null }) | null>("get_now_playing")
      .then((c) => {
        if (!c) return;
        take(c);
        setArt({ key: c.art_key, data: c.art });
      })
      .catch(() => {});

    const subs = [
      listen<NowPlayingInfo | null>("now_playing", (e) => take(e.payload)),
      listen<{ key: string; data: string | null }>("now_playing_art", (e) => setArt(e.payload)),
    ];
    return () => {
      subs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  const playing = pending ?? np?.playing ?? false;

  // Whether there is a Spotify login decides whether picks can be played or
  // only looked up, so it is read once and re-read after settings may have
  // changed it - the panel is cheap and says nothing over the network.
  useEffect(() => {
    invoke<SpotifyStatus>("spotify_status").then(setSpotify).catch(() => {});
  }, [cfg]);

  // A list is about the track it was asked for; a new one invalidates it.
  useEffect(() => {
    setSimilar(null);
    setSimError(null);
    setNote("");
  }, [np?.title]);

  const findSimilar = async () => {
    setSimError(null);
    setNote("");
    setStage("asking");
    try {
      const picks = await askSimilar(cfg, np);
      // Show them straight away: the catalogue pass takes seconds, and a list
      // you can already read is better than a spinner in front of one.
      setSimilar(picks.map((p) => ({ ...p, uri: null, found: "unchecked" })));
      setStage("checking");
      setSimilar(await resolve(picks, !!spotify?.connected));
    } catch (e) {
      setSimilar(null);
      setSimError(String(e));
    } finally {
      setStage("");
    }
  };

  /** Queue, play now, or - with no Spotify - open a search for it. */
  const act = async (t: Resolved, now: boolean) => {
    setSimError(null);
    try {
      if (!t.uri) return await openSearch(np?.app ?? "", t);
      await (now ? playNow(t.uri) : queue(t.uri));
      setNote(now ? `Playing ${t.title}` : `Queued ${t.title}`);
    } catch (e) {
      setSimError(String(e));
    }
  };

  useEffect(() => {
    setPos(base.current.ms);
    if (!playing) return;
    const id = setInterval(
      () => setPos(base.current.ms + (performance.now() - base.current.at)),
      250,
    );
    return () => clearInterval(id);
  }, [playing, np?.position_ms]);

  const toggle = () => {
    setPending(!playing);
    send("play_pause");
    // Whatever the app does, its own state wins shortly after.
    setTimeout(() => setPending(null), 1200);
  };

  // Skips are relative to the position on screen, not to the one the session
  // last stamped - those differ by however long the app has been quiet, and
  // seeking from the stamp is what made +10s jump somewhere else entirely.
  const seekTo = (ms: number) => {
    const clamped = Math.min(np?.duration_ms ?? 0, Math.max(0, ms));
    base.current = { ms: clamped, at: performance.now() };
    seeked.current = { ...base.current };
    setPos(clamped);
    send("seek", Math.round(clamped));
  };

  const cover = art && np && art.key === np.art_key ? art.data : null;
  const shown = scrub ?? Math.min(pos, np?.duration_ms || pos);
  const line = [np?.artist, np?.album].filter(Boolean).join(" — ");
  // A fresh drag outranks the backend until it has had time to report back.
  const volume =
    vol !== null && performance.now() - volAt.current < VOLUME_GRACE ? vol : (np?.volume ?? 0);
  const others = np?.sources.filter((s) => s.id !== np.source_id) ?? [];
  const store = /spotify/i.test(np?.app ?? "") ? "Spotify" : "YouTube Music";
  /** Connected means a pick can be queued outright rather than searched for. */
  const canPlay = !!spotify?.connected;
  const dropped = similar?.filter((t) => t.found === "missing").length ?? 0;
  const shownPicks = similar?.filter((t) => t.found !== "missing") ?? [];

  return (
    <AnimatePresence>
      {np && (
        <motion.section
          initial={{ opacity: 0, y: 14, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: 14, height: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 36 }}
          aria-label="Now playing"
          className="shrink-0"
        >
          <div className="panel relative overflow-hidden">
            {/* The cover, blown up and blurred, is the panel's light source -
                cheaper and better looking than sampling a colour out of it. */}
            <AnimatePresence>
              {cover && (
                <motion.img
                  key={np.art_key}
                  src={cover}
                  alt=""
                  aria-hidden="true"
                  initial={{ opacity: 0, scale: 1.3 }}
                  animate={{ opacity: 0.3, scale: 1.5 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.8 }}
                  className="pointer-events-none absolute -inset-32 h-auto w-full object-cover blur-3xl saturate-150"
                />
              )}
            </AnimatePresence>
            <div className="pointer-events-none absolute inset-0 bg-ink-900/55" />

            {/* The analyser lives here now: it is the sound *this* is playing. */}
            <Spectrum className="pointer-events-none absolute inset-x-0 bottom-0 h-16 w-full opacity-45 [mask-image:linear-gradient(to_top,black,transparent)]" />

            <div className="relative flex items-center gap-4 p-4">
              <motion.div
                animate={{ scale: playing ? 1 : 0.94 }}
                transition={{ type: "spring", stiffness: 320, damping: 26 }}
                className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.04] shadow-lg shadow-black/50"
              >
                {cover ? (
                  <img
                    src={cover}
                    alt={`Cover art for ${np.album || np.title}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <Icon path={NOTE} className="h-full w-full p-5 text-slate-600" />
                )}
              </motion.div>

              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="truncate text-sm font-semibold tracking-tight text-slate-100">
                    {np.title || "Unknown track"}
                  </p>
                  {np.app &&
                    (np.pinned ? (
                      <button
                        onClick={() => send("pin", undefined, "")}
                        title={`Pinned to ${np.app} — click to follow whatever Windows is playing`}
                        className="chip shrink-0 border border-glow/30 bg-glow/[0.1] text-glow"
                      >
                        {np.app} ×
                      </button>
                    ) : (
                      <span className="chip shrink-0 bg-white/[0.07] text-slate-400">{np.app}</span>
                    ))}
                  {/* Other apps holding a session, one click to take them over. */}
                  {others.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => send("pin", undefined, s.id)}
                      title={`Control ${s.app}`}
                      className="chip shrink-0 border border-white/10 bg-transparent text-slate-500 hover:border-white/25 hover:text-slate-300"
                    >
                      {s.playing ? "▸ " : ""}
                      {s.app}
                    </button>
                  ))}
                  {/* Hidden without a model: the local tonal matcher cannot
                      answer this one, so there would be nothing behind it. */}
                  {cfg.model && np.title && (
                    <button
                      onClick={findSimilar}
                      disabled={!!stage}
                      title={
                        canPlay
                          ? "Ask the AI for tracks like this one and queue them in Spotify"
                          : `Ask the AI for tracks like this one. Connect Spotify in settings to queue them; without it a pick opens in ${store}.`
                      }
                      className="chip ml-auto shrink-0 border border-glow/30 bg-glow/[0.08] text-glow disabled:opacity-40"
                    >
                      <span className="pr-1 opacity-70">✦</span>
                      {stage === "asking" ? "Asking…" : stage === "checking" ? "Checking…" : "Similar"}
                    </button>
                  )}
                </div>
                <p className="truncate text-[11px] text-slate-500">{line || " "}</p>

                <div className="mt-2 flex items-center gap-2">
                  <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
                    {clock(shown)}
                  </span>
                  <Bar
                    className="flex-1"
                    label="Playback position"
                    text={`${clock(shown)} of ${clock(np.duration_ms)}`}
                    value={np.duration_ms ? shown / np.duration_ms : 0}
                    disabled={!np.can_seek}
                    onScrub={(ratio, commit) => {
                      const ms = ratio * np.duration_ms;
                      if (commit) {
                        setScrub(null);
                        seekTo(ms);
                      } else setScrub(ms);
                    }}
                  />
                  <span className="w-9 shrink-0 text-[10px] tabular-nums text-slate-500">
                    {clock(np.duration_ms)}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  label={np.shuffle ? "Shuffle on" : "Shuffle off"}
                  size={7}
                  disabled={!np.can_shuffle}
                  active={np.shuffle}
                  onClick={() => send("shuffle", np.shuffle ? 0 : 1)}
                >
                  <Icon path={SHUFFLE} className="h-3 w-3" />
                </Button>
                <Button label="Previous track" disabled={!np.can_prev} onClick={() => send("prev")}>
                  <Icon path={PREV} className="h-3.5 w-3.5" />
                </Button>
                <Button
                  label="Back 10 seconds"
                  size={7}
                  disabled={!np.can_seek}
                  onClick={() => seekTo(shown - 10_000)}
                >
                  <Icon path={BACK10} className="h-3.5 w-3.5" />
                </Button>
                <Button label={playing ? "Pause" : "Play"} active={playing} size={11} onClick={toggle}>
                  <Icon path={playing ? PAUSE : PLAY} className="h-[18px] w-[18px]" />
                </Button>
                <Button
                  label="Forward 10 seconds"
                  size={7}
                  disabled={!np.can_seek}
                  onClick={() => seekTo(shown + 10_000)}
                >
                  <Icon path={FWD10} className="h-3.5 w-3.5" />
                </Button>
                <Button label="Next track" disabled={!np.can_next} onClick={() => send("next")}>
                  <Icon path={NEXT} className="h-3.5 w-3.5" />
                </Button>
                <Button
                  label={
                    np.repeat === "track"
                      ? "Repeat track"
                      : np.repeat === "list"
                        ? "Repeat queue"
                        : "Repeat off"
                  }
                  size={7}
                  disabled={!np.can_repeat}
                  active={np.repeat !== "none"}
                  onClick={() => send("repeat", REPEAT_WIRE[NEXT_REPEAT[np.repeat]])}
                >
                  <span className="relative grid place-items-center">
                    <Icon path={REPEAT} className="h-3 w-3" />
                    {np.repeat === "track" && (
                      <span className="absolute -bottom-[5px] text-[7px] font-bold tabular-nums">
                        1
                      </span>
                    )}
                  </span>
                </Button>
              </div>

              {/* System output volume - the knob people reach for from a player,
                  even though it belongs to the endpoint and not the session. */}
              <div className="flex w-32 shrink-0 items-center gap-2 border-l border-white/[0.07] pl-3">
                <button
                  type="button"
                  aria-label={np.muted ? "Unmute" : "Mute"}
                  title={np.muted ? "Unmute" : "Mute"}
                  onClick={() => send("mute", np.muted ? 0 : 1)}
                  className={`shrink-0 transition-colors ${
                    np.muted ? "text-glow-hot" : "text-slate-400 hover:text-slate-100"
                  }`}
                >
                  <Icon path={np.muted ? MUTED : LOUD} className="h-4 w-4" />
                </button>
                <Bar
                  className="flex-1"
                  label="Output volume"
                  text={`${Math.round(volume * 100)} percent`}
                  value={np.muted ? 0 : volume}
                  accent="bg-slate-300/80"
                  onScrub={(ratio) => {
                    setVol(ratio);
                    volAt.current = performance.now();
                    send("volume", ratio);
                  }}
                />
                <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-slate-500">
                  {Math.round((np.muted ? 0 : volume) * 100)}
                </span>
              </div>
            </div>

            {/* Where the picks land. With Spotify connected they go into its
                queue; without it they are only verified and opened. */}
            <AnimatePresence>
              {(similar || simError) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 36 }}
                  className="relative overflow-hidden border-t border-white/[0.07]"
                >
                  <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5">
                    {shownPicks.map((t) => (
                      <span
                        key={`${t.artist}|${t.title}`}
                        className="flex max-w-full items-stretch overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] transition-colors hover:border-white/25"
                      >
                        <button
                          type="button"
                          onClick={() => act(t, false)}
                          title={`${t.why || "Similar to this"} — ${
                            t.uri
                              ? "queue after this track"
                              : t.found === "unchecked"
                                ? `not verified, opens a search in ${store}`
                                : `opens a search in ${store}`
                          }`}
                          className="truncate px-2.5 py-1 text-xs text-slate-300 hover:text-slate-100"
                        >
                          {t.title}
                          <span className="pl-1 text-slate-500">{t.artist}</span>
                        </button>
                        {/* Play now is a second target rather than a modifier
                            click: a queue you did not want is undoable, a skip
                            over what you were listening to is not. */}
                        {t.uri && (
                          <button
                            type="button"
                            onClick={() => act(t, true)}
                            aria-label={`Play ${t.title} now`}
                            title="Play now"
                            className="border-l border-white/10 px-1.5 text-[10px] text-slate-500 hover:bg-white/[0.06] hover:text-glow"
                          >
                            ▸
                          </button>
                        )}
                      </span>
                    ))}

                    {canPlay && shownPicks.some((t) => t.uri) && (
                      <button
                        type="button"
                        onClick={async () => {
                          for (const t of shownPicks) if (t.uri) await act(t, false);
                          setNote(`Queued ${shownPicks.filter((t) => t.uri).length} tracks`);
                        }}
                        className="chip shrink-0 border border-glow/30 bg-glow/[0.08] text-glow"
                      >
                        Queue all
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setSimilar(null);
                        setSimError(null);
                        setNote("");
                      }}
                      aria-label="Hide similar tracks"
                      className="ml-auto shrink-0 text-[11px] text-slate-500 hover:text-slate-300"
                    >
                      Close
                    </button>
                  </div>

                  {/* One line of truth about what just happened, and about what
                      was quietly thrown away - a shorter list than you asked
                      for should never be silent. */}
                  <p
                    className={`px-4 pb-2.5 text-[11px] ${
                      simError ? "text-rose-300" : "text-slate-500"
                    }`}
                  >
                    {simError ||
                      note ||
                      [
                        stage === "checking" && "Checking the catalogue…",
                        dropped > 0 &&
                          `${dropped} suggestion${dropped > 1 ? "s" : ""} dropped — no such track.`,
                        shownPicks.some((t) => t.found === "unchecked") &&
                          "Could not verify these against a catalogue.",
                        !canPlay &&
                          !stage &&
                          "Connect Spotify in settings to queue these instead of searching.",
                      ]
                        .filter(Boolean)
                        .join(" ") || " "}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
