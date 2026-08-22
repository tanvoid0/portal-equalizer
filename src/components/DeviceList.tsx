import { useRef, useState } from "react";
import { Reorder, motion, AnimatePresence } from "motion/react";
import { Device, Flow } from "../types";
import { DeviceIcon, GripIcon, PowerIcon, SpeakerIcon, MicIcon, WandIcon } from "./icons";

const STATE_STYLE: Record<Device["state"], string> = {
  active: "bg-glow",
  unplugged: "bg-slate-600",
  disabled: "bg-slate-700",
  notpresent: "bg-slate-700",
};

function Row({ device, rank, onSelect, selected, off, onToggle }: {
  device: Device;
  rank: number;
  selected: boolean;
  /** Switched off by the user: still listed, never switched to. */
  off: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const present = device.state === "active";
  // A drag still ends in a click, and a click now switches the device - so
  // remember that we dragged and swallow the click that follows.
  const dragged = useRef(false);
  return (
    <Reorder.Item
      value={device.id}
      layout
      whileDrag={{ scale: 1.03, zIndex: 10 }}
      onDragStart={() => (dragged.current = true)}
      transition={{ type: "spring", stiffness: 600, damping: 40 }}
      className={`group flex cursor-grab items-center gap-3 rounded-xl border px-3 py-2.5 active:cursor-grabbing ${
        selected
          ? "border-glow/40 bg-glow/[0.07]"
          : "border-white/[0.06] bg-white/[0.02] hover:border-white/15"
      } ${off ? "opacity-40 saturate-0" : present ? "" : "opacity-45"}`}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onSelect();
      }}
    >
      {/* The whole row is draggable AND clickable, and a click does something
          else entirely. Without a grip there is nothing saying so. */}
      <span className="relative w-3 shrink-0 text-slate-600">
        <span className="block text-center text-[11px] tabular-nums group-hover:opacity-0">
          {rank}
        </span>
        <GripIcon className="absolute inset-0 m-auto h-3.5 w-3.5 opacity-0 group-hover:opacity-100" />
      </span>

      {/* Windows has told us the form factor all along; a silhouette places a
          row faster than reading its name does. */}
      <span className="relative shrink-0">
        <DeviceIcon
          device={device}
          className={`h-[18px] w-[18px] ${present ? "text-slate-300" : "text-slate-600"}`}
        />
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-ink-900 ${STATE_STYLE[device.state]}`}
        />
        {device.is_default && (
          <motion.span
            className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-glow"
            animate={{ scale: [1, 2.6], opacity: [0.7, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
        )}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-slate-200">{device.adapter || device.name}</span>
        <span className="block truncate text-[11px] text-slate-500">
          {device.name} · {device.channels}ch · {(device.sample_rate / 1000).toFixed(1)} kHz
        </span>
      </span>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-label={off ? "Enable this device" : "Disable this device"}
        aria-pressed={off}
        title={
          off
            ? "Switched off: never selected automatically and given no EQ. Click to bring it back."
            : "Switch this device off - it stays listed but is never selected automatically and gets no EQ."
        }
        className={`shrink-0 rounded-md p-1 transition-opacity hover:text-glow-hot ${
          off ? "text-glow-hot opacity-100" : "text-slate-600 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        }`}
      >
<PowerIcon className="h-3.5 w-3.5" />
      </button>

      {off && (
        <span className="chip-quiet shrink-0">off</span>
      )}
      {device.virtual_device && (
        <span className="chip-quiet shrink-0" title="A software endpoint, not real hardware.">
          virtual
        </span>
      )}
      {device.hands_free && (
        <span
          className="chip-warn shrink-0"
          title="Bluetooth Hands-Free: mono 16 kHz. Selecting it drops the link out of A2DP, so playback quality collapses."
        >
          hfp
        </span>
      )}
      {!device.eapo && device.flow === "render" && (
        <span
          className="chip-warn shrink-0"
          title="Equalizer APO is not installed on this endpoint, so EQ will not be heard. Re-run the Equalizer APO Configurator and tick this device."
        >
          no eq
        </span>
      )}
      {device.is_default && (
        <span className="chip-live shrink-0">live</span>
      )}
    </Reorder.Item>
  );
}

export function DeviceList({
  devices,
  order,
  flow,
  onFlow,
  onReorder,
  onSmartOrganise,
  selectedId,
  onSelect,
  autoSwitch,
  showInactive,
  showVirtual,
  ignored,
  onIgnore,
}: {
  devices: Device[];
  order: string[];
  flow: Flow;
  onFlow: (f: Flow) => void;
  onReorder: (ids: string[]) => void;
  onSmartOrganise: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Shown, not set, here: the switch for it lives in Settings. */
  autoSwitch: boolean;
  showInactive: boolean;
  showVirtual: boolean;
  ignored: string[];
  onIgnore: (id: string, off: boolean) => void;
}) {
  const [showOff, setShowOff] = useState(false);
  const byId = new Map(devices.map((d) => [d.id, d]));
  const off = new Set(ignored);
  // Whatever is playing right now is never hidden, whichever filter would
  // otherwise catch it - a list that cannot show the device in use is lying.
  const visible = (d: Device) =>
    d.is_default ||
    ((showInactive || d.state === "active") && (showVirtual || !d.virtual_device));
  const mine = order.filter((id) => {
    const d = byId.get(id);
    return !!d && d.flow === flow && visible(d);
  });
  const live = mine.filter((id) => !off.has(id));
  const hidden = mine.filter((id) => off.has(id));
  // Switched-off devices sink to the bottom, and stay out of the list entirely
  // until you ask for them - that is the whole point of switching one off.
  const ids = showOff ? [...live, ...hidden] : live;
  const winner = live.find((id) => byId.get(id)?.state === "active");

  return (
    <div className="panel flex min-h-0 flex-1 flex-col p-4">
      <div className="flex items-center justify-between pb-3">
        <div className="flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
          {(["render", "capture"] as Flow[]).map((f) => (
            <button
              key={f}
              onClick={() => onFlow(f)}
              className="relative rounded-md px-3 py-1 text-xs font-medium capitalize"
            >
              {flow === f && (
                <motion.span
                  layoutId="flow-pill"
                  className="absolute inset-0 rounded-md bg-white/10"
                  transition={{ type: "spring", stiffness: 500, damping: 38 }}
                />
              )}
              <span
                className={`relative flex items-center gap-1.5 ${
                  flow === f ? "text-slate-100" : "text-slate-500"
                }`}
              >
                {f === "render" ? (
                  <SpeakerIcon className="h-3.5 w-3.5" />
                ) : (
                  <MicIcon className="h-3.5 w-3.5" />
                )}
                {f === "render" ? "Output" : "Input"}
              </span>
            </button>
          ))}
        </div>

        {!autoSwitch && (
          <span
            className="chip-quiet"
            title="Automatic switching is off, so this list is a preference, not a rule. Turn it back on in Settings."
          >
            manual
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pb-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-slate-500">
          {winner && byId.get(winner) ? (
            <>
              <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-glow align-middle" />
              Now on{" "}
              <span className="text-slate-200">
                {byId.get(winner)!.adapter || byId.get(winner)!.name}
              </span>
            </>
          ) : (
            "Drag to set priority — the top one plugged in wins."
          )}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
        {hidden.length > 0 && (
          <button
            onClick={() => setShowOff((v) => !v)}
            aria-pressed={showOff}
            className={`shrink-0 ${showOff ? "btn-on" : "btn"}`}
          >
            {hidden.length} off
          </button>
        )}
        <motion.button
          onClick={onSmartOrganise}
          whileTap={{ scale: 0.94 }}
          title="Rank by what Windows reports: real hardware over virtual endpoints, headphones over HDMI, and the microphone that belongs to whatever you are listening on."
          aria-label="Smart organise"
          className="btn-accent shrink-0 px-1.5"
        >
          <WandIcon className="h-4 w-4" />
        </motion.button>
        </div>
      </div>

      <Reorder.Group
        axis="y"
        values={ids}
        onReorder={(next) => {
          // Keep everything we are not showing - the other flow, and any
          // switched-off device that is currently collapsed away.
          const shown = new Set(next);
          const others = order.filter((id) => !shown.has(id));
          onReorder([...next, ...others]);
        }}
        className="-mr-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1"
      >
        <AnimatePresence initial={false}>
          {ids.map((id, i) => {
            const d = byId.get(id);
            if (!d) return null;
            return (
              <Row
                key={id}
                device={d}
                rank={i + 1}
                selected={selectedId === id}
                onSelect={() => onSelect(id)}
                off={off.has(id)}
                onToggle={() => onIgnore(id, !off.has(id))}
              />
            );
          })}
        </AnimatePresence>
      </Reorder.Group>
    </div>
  );
}
