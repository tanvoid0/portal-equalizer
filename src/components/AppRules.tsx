import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { AppRule, Device } from "../types";
import { AlertIcon, ChevronIcon, DeviceIcon, PinIcon } from "./icons";

const key = (r: AppRule) => `${r.exe}:${r.flow}`;

export function AppRules({
  devices,
  rules,
  onChange,
}: {
  devices: Device[];
  rules: AppRule[];
  onChange: (rules: AppRule[]) => void;
}) {
  const [procs, setProcs] = useState<string[]>([]);
  const [known, setKnown] = useState<AppRule[]>([]);
  const [exe, setExe] = useState("");
  const [target, setTarget] = useState("");

  // `known` is what Windows itself believes, read from its own store. It is the
  // only way to see rules set through Settings ▸ Sound ▸ Volume mixer, and the
  // only way to confirm one of ours actually landed.
  const refresh = useCallback(() => {
    invoke<string[]>("list_processes").then(setProcs).catch(() => {});
    invoke<AppRule[]>("list_app_rules").then(setKnown).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  useEffect(() => {
    if (!target) {
      setTarget(devices.find((d) => d.flow === "render" && d.state === "active")?.id ?? "");
    }
  }, [devices, target]);

  const device = (id: string) => devices.find((d) => d.id.toLowerCase() === id.toLowerCase());
  const label = (id: string) => {
    const d = device(id);
    if (d) return d.adapter || d.name;
    // Rules Windows wrote itself record a PnP path rather than an endpoint id,
    // so there is nothing to resolve - see docs/per-app-routing.md.
    return id ? "a device that is not plugged in" : "a device Windows picked";
  };

  const mine = new Set(rules.map(key));
  const external = known.filter((r) => !mine.has(key(r)));

  const add = () => {
    const name = exe.trim().toLowerCase();
    const d = devices.find((x) => x.id === target);
    if (!name || !d) return;
    onChange([
      ...rules.filter((r) => !(r.exe === name && r.flow === d.flow)),
      { exe: name, device_id: d.id, flow: d.flow },
    ]);
    setExe("");
    // The watcher applies it on its next tick; let one pass before re-reading
    // what Windows believes.
    setTimeout(refresh, 1500);
  };

  const remove = (r: AppRule) => {
    onChange(rules.filter((x) => key(x) !== key(r)));
    // Removing cannot go through the watcher: by the time it next looks there
    // is no rule left to tell it what to undo.
    invoke("clear_app_rule", { exe: r.exe, flow: r.flow }).catch(() => {});
    setTimeout(refresh, 800);
  };

  const Row = ({ rule, own }: { rule: AppRule; own: boolean }) => {
    const d = device(rule.device_id);
    return (
      <motion.li
        layout
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, height: 0 }}
        className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
      >
        {d ? (
          <DeviceIcon device={d} className="h-4 w-4 shrink-0 text-slate-500" />
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-slate-200">{rule.exe}</span>
          <span className="block truncate text-[11px] text-slate-500">
            {rule.flow === "capture" ? "records from" : "plays to"} {label(rule.device_id)}
          </span>
        </span>

        {d && d.state !== "active" && (
          <span
            className="badge shrink-0 bg-glow-warm/15 text-glow-warm"
            title="That device is not available, and a pinned app does not fall back — it goes silent. This is what Windows does too."
          >
            <AlertIcon className="h-2.5 w-2.5" />
            device off
          </span>
        )}
        {!own && (
          <span
            className="badge shrink-0 bg-white/[0.06] text-slate-500"
            title="Set outside Portal, in Settings ▸ System ▸ Sound ▸ Volume mixer. Add a rule here for the same app to take it over."
          >
            windows
          </span>
        )}
        {own && (
          <button
            onClick={() => remove(rule)}
            aria-label={`Clear the rule for ${rule.exe}`}
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-white/[0.06] hover:text-rose-300"
          >
            ✕
          </button>
        )}
      </motion.li>
    );
  };

  return (
    <div className="panel flex min-h-0 flex-1 flex-col p-4">
      <p className="pb-2 text-[11px] leading-relaxed text-slate-500">
        Pin an app to one device. It stays there whatever the default is — which
        also means it ignores the priority list entirely.
      </p>

      <div className="flex shrink-0 flex-col gap-1.5 pb-3">
        <input
          list="portal-procs"
          value={exe}
          onChange={(e) => setExe(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          onFocus={refresh}
          placeholder="spotify.exe"
          aria-label="Application"
          className="field"
        />
        <datalist id="portal-procs">
          {procs.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>

        <div className="flex gap-1.5">
          <div className="relative min-w-0 flex-1">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            aria-label="Device"
            className="select"
          >
            {(["render", "capture"] as const).map((f) => (
              <optgroup key={f} label={f === "render" ? "Output" : "Input"}>
                {devices
                  .filter((d) => d.flow === f && d.state === "active")
                  .map((d) => (
                    <option key={d.id} value={d.id} className="bg-slate-900">
                      {d.adapter || d.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <ChevronIcon className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          </div>
          <motion.button
            onClick={add}
            whileTap={{ scale: 0.94 }}
            className="btn-accent shrink-0"
          >
            <PinIcon className="h-3.5 w-3.5" />
            Pin
          </motion.button>
        </div>
      </div>

      <ul className="-mr-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        <AnimatePresence initial={false}>
          {rules.map((r) => (
            <Row key={key(r)} rule={r} own />
          ))}
          {external.length > 0 && (
            <motion.li layout key="external" className="px-1 pt-2 text-[11px] text-slate-600">
              Also set outside Portal
            </motion.li>
          )}
          {external.map((r) => (
            <Row key={`x:${key(r)}:${r.device_id}`} rule={r} own={false} />
          ))}
          {rules.length === 0 && external.length === 0 && (
            <motion.li key="empty" className="px-1 pt-2 text-[11px] text-slate-600">
              No app is pinned. Everything follows the default device.
            </motion.li>
          )}
        </AnimatePresence>
      </ul>
    </div>
  );
}
