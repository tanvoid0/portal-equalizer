import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { AiConfig, Device, Features, NowPlayingInfo } from "../types";
import { AiSuggestion, askAi, autoCurve, drift, effectiveNeed, rank } from "../suggest";

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

type Conn = { ok: boolean; note: string } | null;

/** Same switch the device list uses, so "on" reads the same everywhere. */
function Switch({
  on,
  onChange,
  label,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      onClick={() => onChange(!on)}
      className={`flex shrink-0 items-center gap-2 text-xs font-semibold ${
        on ? "text-glow" : "text-slate-400"
      }`}
    >
      <span
        className={`flex h-4 w-7 items-center rounded-full px-0.5 transition-colors ${
          on ? "bg-glow/70" : "bg-white/10"
        }`}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 700, damping: 40 }}
          className="h-3 w-3 rounded-full bg-slate-100"
          style={{ marginLeft: on ? "auto" : 0 }}
        />
      </span>
      {label}
    </button>
  );
}

export function SmartPreset({
  cfg,
  onCfg,
  device,
  applied,
  onApply,
  disabled,
}: {
  cfg: AiConfig;
  onCfg: (next: AiConfig) => void;
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
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [conn, setConn] = useState<Conn>(null);

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
        setConn({ ok: true, note: cfg.model });
      } catch (e) {
        setAi(null);
        setError(String(e));
        setConn({ ok: false, note: String(e) });
      } finally {
        setBusy(false);
      }
    },
    [cfg, np, device, applied],
  );

  useEffect(() => {
    if (disabled || busy || !cfg.auto || !cfg.model) return;
    if (!features?.active) return;
    const trackChanged = (np?.title ?? "") !== lastTrack.current;
    if (!trackChanged && drift(lastNeed.current, need) <= DRIFT_DB) return;
    if (Date.now() - lastAt.current < MIN_GAP_MS) return;
    void ask(features);
  }, [features, need, np, cfg, disabled, busy, ask]);

  const check = useCallback(async () => {
    setConn(null);
    try {
      const ids = await invoke<string[]>("ai_models", { cfg });
      setModels(ids);
      setConn({ ok: true, note: `${ids.length} models available` });
      if (!cfg.model) onCfg({ ...cfg, model: ids[0] });
    } catch (e) {
      setConn({ ok: false, note: String(e) });
    }
  }, [cfg, onCfg]);

  // Answer "is the server there?" when settings open, rather than making the
  // user press a button to find out.
  const opened = useRef(false);
  useEffect(() => {
    if (open && !opened.current) {
      opened.current = true;
      void check();
    }
  }, [open, check]);

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

  const chip =
    "rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-white/25 disabled:opacity-30";
  const field = "min-w-0 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-slate-200";

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
            disabled={!cfg.model || busy || !features?.active}
            onClick={() => features && ask(features)}
            title={
              cfg.model
                ? "Ask the AI, which also sees the track title and artist"
                : "Connect an AI server in settings first"
            }
          >
            {busy ? "Asking…" : "Ask AI"}
          </button>
          <button
            type="button"
            className={chip}
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Smart settings"
          >
            ⚙
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
        {explanation}
      </p>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-2 border-t border-white/5 pt-3 text-[11px] text-slate-400">
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    conn === null ? "bg-slate-600" : conn.ok ? "bg-glow" : "bg-glow-hot"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate" title={conn?.note}>
                  {conn === null
                    ? "Checking AI server…"
                    : conn.ok
                      ? `Connected — ${conn.note}`
                      : `Not connected — ${conn.note}`}
                </span>
                <button type="button" className={chip} onClick={check}>
                  Retry
                </button>
              </div>

              <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                <span>Server</span>
                <input
                  value={cfg.base_url}
                  onChange={(e) => onCfg({ ...cfg, base_url: e.target.value })}
                  placeholder="http://127.0.0.1:18410"
                  className={field}
                />

                <span>Token</span>
                <input
                  type="password"
                  value={cfg.token}
                  onChange={(e) => onCfg({ ...cfg, token: e.target.value })}
                  placeholder="agp_… (blank uses $AGENT_PLATFORM_TOKEN)"
                  className={field}
                />

                <span>Model</span>
                {models.length ? (
                  <select
                    value={cfg.model}
                    onChange={(e) => onCfg({ ...cfg, model: e.target.value })}
                    className={field}
                  >
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={cfg.model}
                    onChange={(e) => onCfg({ ...cfg, model: e.target.value })}
                    placeholder="model id"
                    className={field}
                  />
                )}
              </div>

              <p className="text-slate-600">
                Nothing here changes your sound on its own — Smart mode only refreshes
                what is offered. Without a server the tonal match still works: it reads
                the spectrum, it just cannot tell what the track is.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
