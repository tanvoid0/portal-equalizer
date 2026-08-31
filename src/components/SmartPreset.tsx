import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AiConfig, Device, Features, NowPlayingInfo, aiOn } from "../types";
import {
  AiSuggestion,
  AutoApplied,
  askAi,
  autoCurve,
  drift,
  effectiveNeed,
  rank,
  shouldAutoApply,
} from "../suggest";
import { GearIcon } from "./icons";
import { Switch } from "./Switch";

/** How much the correction must move before Smart mode spends another request. */
const DRIFT_DB = 10;
/** And how long between requests regardless, so a busy mix cannot spam it. */
const MIN_GAP_MS = 20_000;
/**
 * How much better a challenger must score before it takes the top slot. Without
 * it the ranking re-sorts every half second, the buttons relabel and re-flow,
 * and the one you were reaching for moves out from under the cursor.
 */
const SWAP_MARGIN = 0.1;

export function SmartPreset({
  cfg,
  onCfg,
  onSettings,
  device,
  applied,
  onApply,
  disabled,
}: {
  cfg: AiConfig;
  onCfg: (next: AiConfig) => void;
  /** Everything else about the AI is configured on the settings page. */
  onSettings: () => void;
  device: Device | null;
  /** The curve currently on the sliders - the measurement already contains it. */
  applied: number[];
  onApply: (preset: string, gains: number[]) => void;
  disabled?: boolean;
}) {
  const [features, setFeatures] = useState<Features | null>(null);
  const [np, setNp] = useState<NowPlayingInfo | null>(null);
  const [ai, setAi] = useState<AiSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subs = [
      listen<Features>("features", (e) => setFeatures(e.payload)),
      listen<NowPlayingInfo | null>("now_playing", (e) => setNp(e.payload)),
    ];
    return () => {
      subs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  // Everything downstream reasons about the total correction from flat, never
  // the residual the loopback measured through the EQ that is already running.
  const need = useMemo(
    () => (features ? effectiveNeed(features.need, applied) : []),
    [features, applied],
  );
  const ranked = useMemo(() => (features?.active ? rank(need, 4) : []), [features?.active, need]);

  // Hold the previous winner until something clearly beats it.
  const heldRef = useRef<string>("");
  const held = ranked.find((c) => c.preset.name === heldRef.current);
  const best = held && ranked[0].score < held.score + SWAP_MARGIN ? held : ranked[0];
  heldRef.current = best?.preset.name ?? "";

  // A suggestion is about the track it was asked for; a new one invalidates it.
  const track = np?.title ?? "";
  useEffect(() => {
    setAi(null);
    setError(null);
  }, [track]);

  const lastNeed = useRef<number[]>();
  const lastAt = useRef(0);
  const lastTrack = useRef("");

  const ask = useCallback(
    async (f: Features) => {
      lastNeed.current = effectiveNeed(f.need, applied);
      lastAt.current = Date.now();
      lastTrack.current = np?.title ?? "";
      setBusy(true);
      setError(null);
      try {
        const compensated = { ...f, need: effectiveNeed(f.need, applied) };
        setAi(await askAi(cfg, compensated, np, device, applied));
      } catch (e) {
        setAi(null);
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [cfg, np, device, applied],
  );

  useEffect(() => {
    if (disabled || busy || !cfg.auto || !aiOn(cfg)) return;
    if (!features?.active) return;
    const trackChanged = (np?.title ?? "") !== lastTrack.current;
    if (!trackChanged && drift(lastNeed.current, need) <= DRIFT_DB) return;
    if (Date.now() - lastAt.current < MIN_GAP_MS) return;
    void ask(features);
  }, [features, need, np, cfg, disabled, busy, ask]);

  // One headline suggestion. The AI's answer supersedes the tonal guess when
  // there is one, because it is the one that knows what the track is.
  const primary = ai
    ? { name: ai.preset, gains: ai.gains, why: ai.reason, fromAi: true }
    : best && {
        name: best.preset.name,
        gains: best.preset.gains.slice(),
        why: best.preset.blurb,
        fromAi: false,
      };
  const alternates = ranked.filter((c) => c.preset.name !== primary?.name).slice(0, 2);

  // Smart mode is what the switch is for: it puts its pick on the sliders
  // itself. The local guess lands as the track changes and the AI's answer
  // replaces it a moment later when there is one - unless you have touched the
  // curve in between, in which case it leaves you alone until the next track.
  const autoRef = useRef<AutoApplied | null>(null);
  const [autoApplied, setAutoApplied] = useState(false);
  useEffect(() => {
    if (disabled || !primary || !features?.active) return;
    const key = `${track}|${primary.fromAi ? "ai" : "local"}`;
    if (!shouldAutoApply(cfg.auto, key, autoRef.current, applied)) return;
    autoRef.current = { key, gains: primary.gains };
    setAutoApplied(true);
    onApply(primary.name, primary.gains);
  }, [primary, track, cfg.auto, disabled, applied, features?.active, onApply]);

  // A new track, or switching Smart off, clears the claim on the curve.
  useEffect(() => {
    if (!cfg.auto) autoRef.current = null;
    setAutoApplied(false);
  }, [cfg.auto, track]);

  const chip =
    "inline-flex items-center rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-white/25 disabled:opacity-30";

  const explanation = error
    ? error
    : primary
      ? primary.why
      : features
        ? "Nothing playing — start something and a suggestion appears here."
        : "Listening…";

  return (
    // z-10: the equaliser above draws its curve as an SVG, and this row must
    // stay above it however the panels are stacked.
    <div className={`panel relative z-10 p-3 ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      {/* Two rows on purpose. The actions never change size, so they never move
          under the cursor; the suggestions above them relabel constantly and
          wrap instead of pushing the column wider than it is. */}
      <div className="flex items-center gap-2">
        <Switch
          on={cfg.auto}
          onChange={(auto) => onCfg({ ...cfg, auto })}
          label="Smart"
          title="Pick a preset automatically whenever the track changes"
        />

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={chip}
            disabled={!features?.active}
            onClick={() => features && onApply("Auto", autoCurve(need))}
            title="Build a curve from this audio instead of using a preset: the analyser measures what the sound is missing and sets the sliders to match."
          >
            Fit to sound
          </button>
          <button
            type="button"
            className={chip}
            disabled={!aiOn(cfg) || busy || !features?.active}
            onClick={() => features && ask(features)}
            title={
              aiOn(cfg)
                ? "Ask the AI, which also sees the track title and artist"
                : "Connect an AI server in settings first"
            }
          >
            {busy ? "Asking…" : "Ask AI"}
          </button>
          <button
            type="button"
            className={chip}
            onClick={onSettings}
            aria-label="AI settings"
            title="Server, token and model"
          >
            <GearIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pt-2">
        {primary ? (
          <button
            type="button"
            onClick={() => onApply(primary.name, primary.gains)}
            className="rounded-lg border border-glow/40 bg-glow/[0.12] px-2.5 py-1 text-xs font-medium text-glow"
          >
            {primary.fromAi && <span className="pr-1 opacity-70">✦</span>}
            Use {primary.name}
          </button>
        ) : (
          <span className="text-[11px] text-slate-500">No suggestion yet</span>
        )}

        {alternates.map((c) => (
          <button
            key={c.preset.name}
            type="button"
            onClick={() => onApply(c.preset.name, c.preset.gains.slice())}
            title={c.preset.blurb}
            className={chip}
          >
            {c.preset.name}
          </button>
        ))}

      </div>

      <p
        className={`line-clamp-2 pt-1.5 text-[11px] ${error ? "text-rose-300" : "text-slate-500"}`}
        title={explanation}
      >
        {autoApplied && !error && <span className="pr-1 text-glow">Applied ·</span>}
        {explanation}
      </p>

    </div>
  );
}
