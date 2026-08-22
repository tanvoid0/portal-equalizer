import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Logo } from "./icons";

const win = getCurrentWindow();

// Windows' own control glyphs are 10x10 strokes on a 46x32 button; matching that
// geometry is what keeps a custom bar from reading as "a web page pretending".
const ICON = {
  min: <path d="M0 5h10" />,
  max: <rect x="0.5" y="0.5" width="9" height="9" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5V0.5h7v7h-2" />
    </>
  ),
  close: <path d="M0 0l10 10M10 0L0 10" />,
};

function Control({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: keyof typeof ICON;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-8 w-11 shrink-0 items-center justify-center text-bar-icon transition-colors hover:text-bar-icon-hot ${
        danger ? "hover:bg-glow-hot/80 hover:!text-white" : "hover:bg-white/[0.08]"
      }`}
    >
      <svg viewBox="-1 -1 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.1">
        {ICON[icon]}
      </svg>
    </button>
  );
}

export function TitleBar({ subtitle, children }: { subtitle: string; children?: React.ReactNode }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setMaximized);
    const un = win.onResized(() => win.isMaximized().then(setMaximized));
    return () => {
      un.then((f) => f());
    };
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.07] bg-white/[0.02] pl-4 backdrop-blur-xl"
    >
      <Logo className="h-[18px] w-[18px] shrink-0" />

      <div data-tauri-drag-region className="min-w-0 flex-1 leading-tight">
        <h1 data-tauri-drag-region className="truncate text-[13px] font-semibold tracking-tight text-bar-title">
          Portal Equalizer
        </h1>
        <p data-tauri-drag-region className="truncate text-[11px] text-bar-sub">
          {subtitle}
        </p>
      </div>

      {children}

      <div className="flex shrink-0 items-center">
        <Control icon="min" label="Minimise" onClick={() => win.minimize()} />
        <Control
          icon={maximized ? "restore" : "max"}
          label={maximized ? "Restore" : "Maximise"}
          onClick={() => win.toggleMaximize()}
        />
        <Control icon="close" label="Close" danger onClick={() => win.close()} />
      </div>
    </header>
  );
}
