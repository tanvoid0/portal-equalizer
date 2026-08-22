import { Device } from "../types";

/**
 * One icon family, one geometry: 24x24, stroked in currentColor at 1.6, round
 * caps. Anything drawn to a different weight reads as a pasted-in glyph, which
 * is exactly what the old "⚙" text character did.
 */
function Svg({ className = "h-4 w-4", children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { className?: string };

export const SpeakerIcon = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="2.5" width="14" height="19" rx="2.5" />
    <circle cx="12" cy="15" r="3.5" />
    <circle cx="12" cy="6.5" r="1.2" />
  </Svg>
);

export const HeadphonesIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="2.5" y="14" width="4" height="6.5" rx="2" />
    <rect x="17.5" y="14" width="4" height="6.5" rx="2" />
  </Svg>
);

export const HeadsetIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <rect x="2.5" y="13" width="4" height="6" rx="2" />
    <rect x="17.5" y="13" width="4" height="6" rx="2" />
    <path d="M19.5 19v.5a2 2 0 0 1-2 2H13" />
  </Svg>
);

export const MicIcon = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4" />
  </Svg>
);

export const DisplayIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
    <path d="M8.5 20.5h7M12 16.5v4" />
  </Svg>
);

export const OpticalIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.5" />
  </Svg>
);

export const BluetoothIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 7.5 17 16.5 12 20.5V3.5l5 4L7 16.5" />
  </Svg>
);

export const VirtualIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4.5" width="19" height="12" rx="2" strokeDasharray="3 2.5" />
    <path d="M8 20.5h8" />
  </Svg>
);

/**
 * The Devices pane. A stack of endpoints ranked by priority - which is what
 * that pane actually is. The first draft drew a monitor beside a phone and
 * read as "displays".
 */
export const DevicesIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 6.5h13M4 12h9M4 17.5h5" strokeWidth="1.9" />
    <circle cx="20" cy="6.5" r="1.3" />
  </Svg>
);

export const PinIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 3.5h6l-.8 5.4 3.3 3.3H6.5l3.3-3.3z" />
    <path d="M12 12.2v8.3" />
  </Svg>
);

export const WandIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 20 15 9" />
    <path d="M17.5 6.5 15 9l-2-2 2.5-2.5z" />
    <path d="M6 3.5v3M4.5 5h3M19 14v2.5M17.75 15.25h2.5" />
  </Svg>
);

// A hub ringed by eight detached spokes is a sun, not a gear - the teeth have
// to be part of the body's outline. Six of them, because at 14px the eight-tooth
// version fills its own gaps in.
export const GearIcon = (p: P) => (
  <Svg {...p}>
    <path d="M 9.42 5.28 L 9.84 2.65 L 14.16 2.65 L 14.58 5.28 A 7.2 7.2 0 0 1 16.53 6.40 L 19.02 5.45 L 21.18 9.19 L 19.11 10.87 A 7.2 7.2 0 0 1 19.11 13.13 L 21.18 14.81 L 19.02 18.55 L 16.53 17.60 A 7.2 7.2 0 0 1 14.58 18.72 L 14.16 21.35 L 9.84 21.35 L 9.42 18.72 A 7.2 7.2 0 0 1 7.47 17.60 L 4.98 18.55 L 2.82 14.81 L 4.89 13.13 A 7.2 7.2 0 0 1 4.89 10.87 L 2.82 9.19 L 4.98 5.45 L 7.47 6.40 A 7.2 7.2 0 0 1 9.42 5.28 Z" />
    <circle cx="12" cy="12" r="3.1" />
  </Svg>
);

export const PowerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v8" />
    <path d="M7.1 6.4a7.5 7.5 0 1 0 9.8 0" />
  </Svg>
);

export const GripIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 6.5h.01M15 6.5h.01M9 12h.01M15 12h.01M9 17.5h.01M15 17.5h.01" strokeWidth="2.4" />
  </Svg>
);

export const ChevronIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 4 4" />
  </Svg>
);

export const AlertIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5 22 20H2z" />
    <path d="M12 9.5v4.5M12 17h.01" />
  </Svg>
);

/**
 * Windows' EndpointFormFactor, plus the flags we already read off the endpoint.
 * A row is far quicker to place by silhouette than by reading its name, and we
 * have had the form factor in `Device` all along without ever drawing it.
 */
export function DeviceIcon({ device, className }: { device: Device; className?: string }) {
  if (device.virtual_device) return <VirtualIcon className={className} />;
  if (device.flow === "capture") return <MicIcon className={className} />;
  switch (device.form_factor) {
    case 3:
      return <HeadphonesIcon className={className} />;
    case 4:
      return <MicIcon className={className} />;
    case 5:
      return <HeadsetIcon className={className} />;
    case 8:
      return <OpticalIcon className={className} />;
    case 9:
      return <DisplayIcon className={className} />;
    default:
      return device.bluetooth ? <BluetoothIcon className={className} /> : <SpeakerIcon className={className} />;
  }
}

/* --- Preset group marks. Five of them, so they are worth drawing by hand;
   the 88 presets underneath them are not - see PresetShape. ----------------- */

/** Signature: broad tone shapes. A tilt. */
export const ToneIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 17c4.5 0 5-10 9.5-10S17 17 21 17" />
  </Svg>
);

/** Genre. */
export const NoteIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 18V5.5l11-2V16" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="16" r="2.5" />
  </Svg>
);

/** Scene: what you are doing, not what you are playing. */
export const SceneIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
    <path d="M10 9.5l5 2.5-5 2.5z" />
  </Svg>
);

/** Utility: corrections for a specific box. */
export const ToolIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14.5 3.5a5 5 0 0 0-6.2 6.4L3.5 14.7a2 2 0 0 0 2.8 2.8l4.8-4.8a5 5 0 0 0 6.4-6.2l-2.9 2.9-2.5-.5-.5-2.5z" />
    <path d="M15 15l5.5 5.5" />
  </Svg>
);

/**
 * A preset's character, as four fat marks: low, low-mid, high-mid, air.
 *
 * Eighty-eight hand-drawn glyphs would have meant inventing a picture for
 * "Lo-Fi" and another for "Synthwave" - decoration you have to learn before it
 * tells you anything. What actually separates one preset from the next is the
 * shape of its correction, and that is already in the data.
 *
 * The first attempt drew all ten bands as a polyline and was unreadable at
 * this size: ten points across 24px is two pixels apart, so Bass Boost and
 * Treble Cut both came out as the same faint dash. Five filled bars were
 * better and still too fine. Four bars at 4px wide is the point where the
 * silhouette survives being small - detail the glyph could never show anyway,
 * traded for one it can. For the real shape, hover the chip: the equaliser
 * ghosts the full curve.
 *
 * Teal up, amber down - the same boost/cut language the equaliser itself uses,
 * so there is nothing new to learn.
 */
/** Four bands, not ten: low, low-mid, high-mid, air. */
const BANDS4: number[][] = [
  [0, 1, 2],
  [3, 4],
  [5, 6],
  [7, 8, 9],
];

/**
 * Scaled to 8 dB, not the slider's 12. Almost every preset lives inside 8, so
 * scaling to the extreme left the common case as a row of stubs.
 */
const GLYPH_FULL_SCALE = 8;

export function PresetShape({ gains, className = "h-4 w-[22px]" }: { gains: number[]; className?: string }) {
  const BAR = 4;
  const GAP = 2;
  const W = BANDS4.length * BAR + (BANDS4.length - 1) * GAP;
  const H = 16;
  const MID = H / 2;
  const SPAN = 6.5;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} aria-hidden="true">
      <line x1="0" y1={MID} x2={W} y2={MID} stroke="currentColor" strokeWidth="0.9" opacity="0.3" />
      {BANDS4.map((idx, i) => {
        const g = idx.reduce<number>((sum, j) => sum + (gains[j] ?? 0), 0) / idx.length;
        const level = Math.max(-1, Math.min(1, g / GLYPH_FULL_SCALE));
        const flat = Math.abs(g) < 0.25;
        // A band left at unity still gets a stub. Drawing nothing would read as
        // "this preset does not reach here" rather than "it leaves it alone".
        const len = flat ? 1.4 : Math.max(2, Math.abs(level) * SPAN);
        const up = level >= 0;
        return (
          <rect
            key={i}
            x={i * (BAR + GAP)}
            y={up ? MID - len : MID}
            width={BAR}
            height={len}
            rx={1.4}
            fill={flat ? "currentColor" : up ? "#5eead4" : "#fb923c"}
            opacity={flat ? 0.4 : 1}
          />
        );
      })}
    </svg>
  );
}

/**
 * The product mark, without its tile: an aperture seen edge-on with the signal
 * running through it. Same geometry as `src-tauri/icons/icon.svg`, scaled to a
 * 32 box — keep the two in step if either moves.
 *
 * The gradient is userSpaceOnUse on purpose. The bands are perfectly vertical
 * paths, so their bounding box is zero-width and the proportional default
 * collapses them to nothing.
 */
export function Logo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="portal-mark" gradientUnits="userSpaceOnUse" x1="7" y1="7" x2="25" y2="25">
          <stop offset="0%" stopColor="#5eead4" />
          <stop offset="55%" stopColor="#67d9e8" />
          <stop offset="100%" stopColor="#818cf8" />
        </linearGradient>
      </defs>
      {/* 2*pi*8.75 = 54.98, so 18.3/9.2 twice closes the ring. */}
      <circle
        cx="16"
        cy="16"
        r="8.75"
        fill="none"
        stroke="url(#portal-mark)"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeDasharray="18.3 9.2"
        strokeDashoffset="9.15"
      />
      <g stroke="url(#portal-mark)" strokeWidth="2.1" strokeLinecap="round">
        <path d="M11.25 19.75v-5.6" />
        <path d="M16 25.25V6.75" />
        <path d="M20.75 18.5v-5.6" />
      </g>
    </svg>
  );
}
