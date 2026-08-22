import { useRef, useState } from "react";
import { BANDS, bandLabel, DeviceEq } from "../types";
import { PowerIcon } from "./icons";

const MIN_DB = -12;
const MAX_DB = 12;
const TRACK_H = 190;
/** One viewBox column per band, so knob x and curve x are the same number. */
const VB_W = BANDS.length * 100;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

const clamp = (db: number) => Math.min(MAX_DB, Math.max(MIN_DB, db));
const toY = (db: number) => ((MAX_DB - db) / (MAX_DB - MIN_DB)) * TRACK_H;
/** Screen-space position. The track height is now whatever the column gives
 *  it, so anything drawn in the DOM is placed as a percentage, not a pixel. */
const toPct = (db: number) => ((MAX_DB - db) / (MAX_DB - MIN_DB)) * 100;
const toDb = (y: number, h: number) =>
  Math.round((MAX_DB - (y / h) * (MAX_DB - MIN_DB)) * 2) / 2;
const ZERO_Y = toY(0);
const ZERO_PCT = toPct(0);

const tone = (v: number) =>
  Math.abs(v) < 0.05 ? "text-slate-500" : v > 0 ? "text-glow" : "text-glow-warm";

/**
 * Catmull-Rom through every band centre, so the line passes through the knobs
 * rather than near them, and runs flat off both edges to fill the width.
 */
function curve(gains: number[]) {
  const p = gains.map((g, i) => [(i + 0.5) * 100, toY(g)] as const);
  let d = `M 0 ${p[0][1]} L ${p[0][0]} ${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] ?? p[i];
    const b = p[i];
    const c = p[i + 1];
    const e = p[i + 2] ?? p[i + 1];
    d += ` C ${b[0] + (c[0] - a[0]) / 6} ${b[1] + (c[1] - a[1]) / 6}, ${c[0] - (e[0] - b[0]) / 6} ${c[1] - (e[1] - b[1]) / 6}, ${c[0]} ${c[1]}`;
  }
  return `${d} L ${VB_W} ${p[p.length - 1][1]}`;
}

function BandSlider({
  hz,
  value,
  dragging,
  onChange,
  onCommit,
  onDrag,
}: {
  hz: number;
  value: number;
  dragging: boolean;
  onChange: (v: number) => void;
  onCommit: () => void;
  onDrag: (on: boolean) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const apply = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    onChange(
      clamp(toDb(Math.min(Math.max(clientY - rect.top, 0), rect.height), rect.height)),
    );
  };

  const nudge = (delta: number) => {
    onChange(clamp(value + delta));
    onCommit();
  };

  const end = () => {
    onDrag(false);
    onCommit();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 3 : 0.5;
    const next: Record<string, number> = {
      ArrowUp: value + step,
      ArrowRight: value + step,
      ArrowDown: value - step,
      ArrowLeft: value - step,
      Home: MAX_DB,
      End: MIN_DB,
      PageUp: value + 3,
      PageDown: value - 3,
    };
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onChange(0);
      onCommit();
      return;
    }
    if (!(e.key in next)) return;
    e.preventDefault();
    nudge(next[e.key] - value);
  };

  const boosted = value > 0;
  const flat = Math.abs(value) < 0.05;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={`${bandLabel(hz)} hertz`}
      aria-valuemin={MIN_DB}
      aria-valuemax={MAX_DB}
      aria-valuenow={value}
      aria-valuetext={`${value} decibels at ${bandLabel(hz)} hertz`}
      onKeyDown={onKeyDown}
      onWheel={(e) => nudge(e.deltaY < 0 ? 1 : -1)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDrag(true);
        apply(e.clientY);
      }}
      onPointerMove={(e) => dragging && apply(e.clientY)}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => {
        onChange(0);
        onCommit();
      }}
      className="group relative h-full flex-1 cursor-ns-resize rounded-lg transition-colors hover:bg-white/[0.03]"
    >
      {/* rail */}
      <div className="absolute left-1/2 h-full w-px -translate-x-1/2 rounded-full bg-white/[0.09]" />
      {/* unity line */}
      <div
        className="absolute left-1/2 h-px w-3 -translate-x-1/2 bg-white/20"
        style={{ top: `${ZERO_PCT}%` }}
      />
      {/* Knob. The curve behind it carries the shape, so this only has to say
          where the band sits and which way it went. */}
      <div
        className={`pointer-events-none absolute left-1/2 h-3.5 w-3.5 rounded-full border-2 bg-ink-800 shadow-lg shadow-black/60 ${
          flat
            ? "border-slate-500 group-hover:border-slate-300"
            : boosted
              ? "border-glow"
              : "border-glow-warm"
        }`}
        style={{
          top: `${toPct(value)}%`,
          transform: `translate(-50%, -50%) scale(${dragging ? 1.25 : 1})`,
          transition: dragging
            ? `transform 140ms ${EASE}`
            : `top 180ms ${EASE}, transform 140ms ${EASE}`,
        }}
      />
    </div>
  );
}

export function EqPanel({
  eq,
  onChange,
  onCommit,
  onToggle,
  canToggle,
  disabled,
  preview,
}: {
  eq: DeviceEq;
  onChange: (eq: DeviceEq) => void;
  onCommit: () => void;
  onToggle: () => void;
  canToggle: boolean;
  disabled?: boolean;
  /** The preset currently under the pointer in the rail, if any. */
  preview?: { name: string; gains: number[] } | null;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const gains = BANDS.map((_, i) => eq.gains[i] ?? 0);
  const flat = gains.every((g) => Math.abs(g) < 0.05);

  const setGain = (i: number, v: number) => {
    const next = gains.slice();
    next[i] = v;
    onChange({ ...eq, gains: next, preset: "Custom" });
  };

  return (
    <div className="panel flex min-h-0 flex-col p-5">
      {/* The header stays live while the bands are dimmed — turning the EQ back
          on has to be reachable from the panel it switches off. */}
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-3 gap-y-1 pb-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-200">Equalizer</h2>
          {/* At the window minimum this column is ~350px and the hint used to
              wrap one word per line beside the buttons. It is a first-run
              hint, not a control, so it is the thing that goes. */}
          <p className="hidden text-xs text-slate-500 lg:block">
            Drag or scroll a band · double-click to reset it
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            // Bounded, or hovering a long preset name reflows the whole
            // header row and the buttons jump under the pointer.
            className={`chip max-w-[8rem] truncate border ${
              preview
                ? "border-slate-300/40 bg-slate-300/10 text-slate-200"
                : "border-white/10 bg-white/[0.04] text-slate-400"
            }`}
          >
            {preview ? preview.name : eq.preset}
          </span>
          <button
            onClick={() => {
              onChange({ ...eq, gains: BANDS.map(() => 0), preset: "Flat" });
              onCommit();
            }}
            disabled={flat || disabled}
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-30"
          >
            Reset
          </button>
          <button
            onClick={onToggle}
            role="switch"
            aria-checked={eq.enabled}
            aria-label="Equaliser on"
            title={eq.enabled ? "Turn the equaliser off" : "Turn the equaliser on"}
            disabled={!canToggle}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] disabled:opacity-30 ${
              eq.enabled
                ? "border-glow/40 bg-glow/[0.1] text-glow"
                : "border-white/10 bg-white/[0.03] text-slate-400"
            }`}
          >
            <PowerIcon className="h-3.5 w-3.5" />
            {eq.enabled ? "On" : "Off"}
          </button>
        </div>
      </div>

      <div
        className={`flex min-h-0 flex-1 flex-col ${disabled ? "pointer-events-none opacity-40" : ""}`}
      >
      {/* gain readouts */}
      <div className="flex shrink-0 pb-1.5">
        {gains.map((g, i) => (
          <span
            key={BANDS[i]}
            className={`flex-1 text-center text-[10px] font-medium tabular-nums ${tone(g)}`}
          >
            {g > 0 ? `+${g}` : g}
          </span>
        ))}
      </div>

      {/* min-h keeps the bands draggable at the window minimum; above that
          the track takes every pixel the column has spare. */}
      <div className="relative min-h-[150px] flex-1">
        {/* The response curve is what you are actually shaping, so it sits
            behind the knobs it is drawn through. */}
        <svg
          viewBox={`0 0 ${VB_W} ${TRACK_H}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="eq-curve" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#5eead4" />
              <stop offset="0.5" stopColor="#94a3b8" />
              <stop offset="1" stopColor="#fb923c" />
            </linearGradient>
          </defs>
          <path
            d={`${curve(gains)} L ${VB_W} ${ZERO_Y} L 0 ${ZERO_Y} Z`}
            fill="url(#eq-curve)"
            opacity={0.13}
            style={{ transition: drag === null ? `d 180ms ${EASE}` : "none" }}
          />
          <path
            d={curve(gains)}
            fill="none"
            stroke="url(#eq-curve)"
            strokeWidth={1.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            style={{ transition: drag === null ? `d 180ms ${EASE}` : "none" }}
          />
          {/* Hovering a preset draws what it would do, over what is applied
              now. The rail's glyph can only suggest a shape at 22px; this is
              the shape. */}
          {preview && (
            <path
              d={curve(preview.gains)}
              fill="none"
              stroke="#e2e8f0"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              strokeLinecap="round"
              opacity={0.75}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        <div className="absolute inset-0 flex">
          {BANDS.map((hz, i) => (
            <BandSlider
              key={hz}
              hz={hz}
              value={gains[i]}
              dragging={drag === i}
              onChange={(v) => setGain(i, v)}
              onCommit={onCommit}
              onDrag={(on) => setDrag(on ? i : null)}
            />
          ))}
        </div>
      </div>

      {/* frequencies */}
      <div className="flex shrink-0 pt-1.5">
        {BANDS.map((hz) => (
          <span key={hz} className="flex-1 text-center text-[10px] tabular-nums text-slate-500">
            {bandLabel(hz)}
          </span>
        ))}
      </div>
      </div>
    </div>
  );
}
