import { motion } from "motion/react";

/**
 * The one toggle. Three components had grown their own copy of this pill and
 * they had drifted apart in size, colour and what "on" looked like.
 */
export function Switch({
  on,
  onChange,
  label,
  title,
  /** Label after the pill rather than before it. */
  trailing,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
  trailing?: boolean;
  disabled?: boolean;
}) {
  const pill = (
    <span
      className={`flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${
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
  );

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex shrink-0 items-center gap-2 text-xs font-medium disabled:opacity-40 ${
        on ? "text-glow" : "text-slate-400"
      }`}
    >
      {trailing ? pill : null}
      {label && <span className={trailing ? "" : "order-first"}>{label}</span>}
      {trailing ? null : pill}
    </button>
  );
}
