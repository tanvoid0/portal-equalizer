import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { GROUPS, Group, PRESETS, Preset, SIMPLE, subsOf } from "../presets";
import { PresetMode } from "../types";
import { HeadphonesIcon, NoteIcon, PresetShape, SceneIcon, ToneIcon, ToolIcon } from "./icons";

const GROUP_ICON: Record<Group, (p: { className?: string }) => JSX.Element> = {
  Signature: ToneIcon,
  Genre: NoteIcon,
  Scene: SceneIcon,
  Headphones: HeadphonesIcon,
  Utility: ToolIcon,
};

/** Filter box appears once the catalogue is too long to scan by eye. */
const SEARCHABLE_FROM = 24;

export function PresetRail({
  active,
  onPick,
  onPreview,
  disabled,
  mode,
}: {
  active: string;
  onPick: (name: string) => void;
  /** Pointer or keyboard focus landed on a preset - or left one, with null. */
  onPreview: (p: Preset | null) => void;
  disabled?: boolean;
  mode: PresetMode;
}) {
  const [query, setQuery] = useState("");

  // The preset in use is always offered, even when Simple mode would hide it:
  // switching to Simple must not make what you are listening to unpickable.
  const catalogue = useMemo(
    () =>
      mode === "simple" ? PRESETS.filter((p) => SIMPLE.has(p.name) || p.name === active) : PRESETS,
    [mode, active],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalogue;
    return catalogue.filter((p) =>
      `${p.name} ${p.sub ?? ""} ${p.group} ${p.blurb}`.toLowerCase().includes(q),
    );
  }, [query, catalogue]);

  const chips = (list: Preset[]) => (
    <div className="flex flex-wrap gap-1">
      {list.map((p) => {
        const on = p.name === active;
        return (
          <button
            key={p.name}
            onClick={() => onPick(p.name)}
            onPointerEnter={() => onPreview(p)}
            onPointerLeave={() => onPreview(null)}
            onFocus={() => onPreview(p)}
            onBlur={() => onPreview(null)}
            title={p.blurb}
            aria-pressed={on}
            className="relative rounded-lg px-2 py-1 text-xs"
          >
            {on && (
              <motion.span
                layoutId="preset-pill"
                className="absolute inset-0 rounded-lg border border-glow/40 bg-glow/[0.12]"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span
              className={`relative flex items-center gap-1.5 ${
                on ? "text-glow" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <PresetShape gains={p.gains} className="h-4 w-[22px] shrink-0 text-slate-500" />
              {p.name}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      onPointerLeave={() => onPreview(null)}
      className={`panel min-h-0 overflow-y-auto p-4 ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      {/* Sticky: with 85 presets the filter box would otherwise scroll away
          exactly when you have scrolled far enough to want it. */}
      <div className="sticky -top-4 z-10 -mx-4 -mt-4 flex items-center justify-between gap-3 bg-ink-900/95 px-4 pb-3 pt-4 backdrop-blur-xl">
        <h2 className="shrink-0 text-[13px] font-semibold tracking-tight text-slate-200">Presets</h2>
        {catalogue.length >= SEARCHABLE_FROM && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter presets"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600"
          />
        )}
      </div>

      <div className="flex flex-col gap-3">
        {GROUPS.map((group) => {
          const inGroup = matches.filter((p) => p.group === group);
          if (!inGroup.length) return null;
          const subs = subsOf(group);

          return (
            <div key={group} className="border-t border-white/[0.06] pt-2.5 first:border-0 first:pt-0">
              <p className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                {(() => {
                  const Icon = GROUP_ICON[group];
                  return <Icon className="h-3.5 w-3.5" />;
                })()}
                {group}
              </p>
              {subs.length ? (
                <div className="flex flex-col gap-2.5">
                  {subs.map((sub) => {
                    const inSub = inGroup.filter((p) => p.sub === sub);
                    if (!inSub.length) return null;
                    return (
                      <div key={sub}>
                        <p className="pb-1 text-[11px] text-slate-400">{sub}</p>
                        {chips(inSub)}
                      </div>
                    );
                  })}
                </div>
              ) : (
                chips(inGroup)
              )}
            </div>
          );
        })}
        {!matches.length && (
          <p className="text-xs text-slate-500">Nothing matches “{query}”.</p>
        )}
      </div>
    </div>
  );
}
