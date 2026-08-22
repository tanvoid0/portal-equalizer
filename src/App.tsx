import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { AppRules } from "./components/AppRules";
import { DeviceList } from "./components/DeviceList";
import { TitleBar } from "./components/TitleBar";
import { EqPanel } from "./components/EqPanel";
import { NowPlaying } from "./components/NowPlaying";
import { PresetRail } from "./components/PresetRail";
import { SmartPreset } from "./components/SmartPreset";
import { AlertIcon, DevicesIcon, PinIcon } from "./components/icons";
import { Preset, findPreset } from "./presets";
import { AiConfig, Device, DeviceEq, EapoStatus, Flow, Settings, defaultEq } from "./types";

const NO_AI: AiConfig = {
  base_url: "http://127.0.0.1:18410",
  model: "",
  token: "",
  auto: false,
};

const FLAT = Array(10).fill(0);

const EMPTY: Settings = {
  priority: [],
  auto_switch: true,
  ignored: [],
  device_presets: {},
  eapo_match: {},
  app_rules: [],
  ai: NO_AI,
};

export default function App() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [status, setStatus] = useState<EapoStatus | null>(null);
  const [flow, setFlow] = useState<Flow>("render");
  const [pane, setPane] = useState<"devices" | "apps">("devices");
  // Output and input are independent choices. One shared selection meant
  // picking a microphone silently re-pointed the equaliser, which only ever
  // applies to an output.
  const [picked, setPicked] = useState<Record<Flow, string | null>>({
    render: null,
    capture: null,
  });
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  /** Preset under the pointer in the rail, ghosted on the equaliser. */
  const [preview, setPreview] = useState<Preset | null>(null);

  // The device list is the source of truth for *which* devices exist; the
  // priority list only says what order we want them in, so any device we have
  // never seen gets appended rather than silently dropped.
  const withNewDevices = useCallback((s: Settings, ds: Device[]): Settings => {
    const known = new Set(s.priority);
    const fresh = ds.filter((d) => !known.has(d.id)).map((d) => d.id);
    return fresh.length ? { ...s, priority: [...s.priority, ...fresh] } : s;
  }, []);

  useEffect(() => {
    (async () => {
      const [s, ds, st] = await Promise.all([
        invoke<Settings>("get_settings"),
        invoke<Device[]>("list_devices"),
        invoke<EapoStatus>("eapo_status"),
      ]);
      setDevices(ds);
      setStatus(st);
      setSettings(withNewDevices(s, ds));
      setPicked({
        render: ds.find((d) => d.flow === "render" && d.is_default)?.id ?? null,
        capture: ds.find((d) => d.flow === "capture" && d.is_default)?.id ?? null,
      });
    })();

    const subs = [
      listen<Device[]>("devices", (e) => {
        setDevices(e.payload);
        setSettings((s) => withNewDevices(s, e.payload));
      }),
      listen<Device>("switched", (e) =>
        setToast({ text: `Switched to ${e.payload.adapter || e.payload.name}` }),
      ),
      listen<string>("error", (e) => setToast({ text: e.payload, bad: true })),
    ];
    return () => {
      subs.forEach((p) => p.then((f) => f()));
    };
  }, [withNewDevices]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Writing the Equalizer APO config on every pointer move would thrash the
  // file it watches; one write shortly after you stop moving is plenty.
  const timer = useRef<number>();
  const persist = useCallback((next: Settings) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      invoke("save_settings", { settings: next }).catch((e) =>
        setToast({ text: String(e), bad: true }),
      );
    }, 200);
  }, []);

  const update = useCallback(
    (next: Settings, save = true) => {
      setSettings(next);
      if (save) persist(next);
    },
    [persist],
  );

  const smartOrganise = useCallback(async () => {
    const ids = await invoke<string[]>("smart_organise");
    setSettings((s) => {
      const next = { ...s, priority: ids };
      persist(next);
      return next;
    });
    setToast({ text: "Reordered by device type — drag to adjust" });
  }, [persist]);

  // Clicking a row means "use this one now", within its own flow only. A bare
  // SetDefaultEndpoint would be undone by the watcher within a second when
  // auto-switch is on, so promote the pick to the top of the priority list too
  // and let the watcher agree with us.
  const selectDevice = useCallback(
    (id: string) => {
      const d = devices.find((x) => x.id === id);
      if (!d) return;
      setPicked((p) => ({ ...p, [d.flow]: id }));
      if (d.state !== "active" || d.is_default || settings.ignored.includes(id)) return;
      if (settings.auto_switch) {
        update({ ...settings, priority: [id, ...settings.priority.filter((p) => p !== id)] });
      }
      invoke("set_default_device", { id })
        .then(() => setToast({ text: `Switched to ${d.adapter || d.name}` }))
        .catch((e) => setToast({ text: String(e), bad: true }));
    },
    [devices, settings, update],
  );

  // The equaliser is bound to the chosen output, whichever tab is on screen.
  // Inputs have no EQ - Equalizer APO only filters render endpoints.
  const eqId = picked.render;
  const output = useMemo(() => devices.find((d) => d.id === eqId) ?? null, [devices, eqId]);
  const eq = (eqId && settings.device_presets[eqId]) || defaultEq();

  const setEq = (next: DeviceEq, save = true) => {
    if (!eqId) return;
    update(
      { ...settings, device_presets: { ...settings.device_presets, [eqId]: next } },
      save,
    );
  };

  const blocked = !status?.installed || !status.writable;

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        subtitle={output ? `Equalising ${output.adapter || output.name}` : "Select an output"}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      {/* Nothing else in the app matters if the DSP engine cannot be reached. */}
      <AnimatePresence>
        {blocked && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="shrink-0 overflow-hidden"
          >
            <div className="flex items-start gap-2.5 rounded-xl border border-glow-hot/30 bg-glow-hot/[0.08] px-4 py-2.5 text-xs text-rose-200">
              <AlertIcon className="mt-px h-4 w-4 shrink-0 text-glow-hot" />
              <span>
              {!status?.installed
                ? "Equalizer APO is not installed. Install it and tick the devices you want to equalise — nothing here will be audible until then."
                : `Cannot write ${status.config_path}. Grant your user write permission to that folder.`}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Three regions, in task order: where it plays, how it sounds, which
          sound. The preset catalogue holds 85 entries and is the most-used
          surface in the window, so above 1024px it gets a full-height column
          of its own rather than the strip left over under the equaliser. */}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,320px)_minmax(0,1fr)] grid-rows-[auto_minmax(150px,1fr)] gap-3 md:grid-cols-[minmax(280px,min(32%,420px))_minmax(0,1fr)_minmax(190px,min(26%,360px))] md:grid-rows-[minmax(0,1fr)]">
        <div className="row-span-2 flex min-h-0 flex-col gap-2 md:row-span-1">
          <div className="flex shrink-0 gap-1 self-start rounded-lg bg-white/[0.04] p-0.5">
            {(["devices", "apps"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPane(p)}
                className="relative rounded-md px-3 py-1 text-xs font-medium"
              >
                {pane === p && (
                  <motion.span
                    layoutId="pane-pill"
                    className="absolute inset-0 rounded-md bg-white/10"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  />
                )}
                <span
                  className={`relative flex items-center gap-1.5 ${
                    pane === p ? "text-slate-100" : "text-slate-500"
                  }`}
                >
                  {p === "devices" ? (
                    <DevicesIcon className="h-3.5 w-3.5" />
                  ) : (
                    <PinIcon className="h-3.5 w-3.5" />
                  )}
                  {p === "devices" ? "Devices" : "App rules"}
                </span>
              </button>
            ))}
          </div>

          {pane === "apps" ? (
            <AppRules
              devices={devices}
              rules={settings.app_rules ?? []}
              onChange={(app_rules) => update({ ...settings, app_rules })}
            />
          ) : (
        <DeviceList
          devices={devices}
          order={settings.priority}
          flow={flow}
          onFlow={setFlow}
          onReorder={(ids) => update({ ...settings, priority: ids })}
          onSmartOrganise={smartOrganise}
          selectedId={picked[flow]}
          onSelect={selectDevice}
          autoSwitch={settings.auto_switch}
          onAutoSwitch={(v) => update({ ...settings, auto_switch: v })}
          ignored={settings.ignored}
          onIgnore={(id, off) =>
            update({
              ...settings,
              ignored: off
                ? [...settings.ignored, id]
                : settings.ignored.filter((x) => x !== id),
            })
          }
        />
          )}
        </div>

        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-3 overflow-y-auto overflow-x-hidden pr-1">
          <EqPanel
            eq={eq}
            disabled={!eqId || !eq.enabled}
            canToggle={!!eqId}
            onToggle={() => setEq({ ...eq, enabled: !eq.enabled })}
            preview={preview && { name: preview.name, gains: preview.gains }}
            onChange={(next) => setEq(next, false)}
            onCommit={() => persist(settings)}
          />
          <SmartPreset
            cfg={settings.ai ?? NO_AI}
            onCfg={(ai) => update({ ...settings, ai })}
            device={output}
            // With EQ off nothing is filtering, so the loopback is already the
            // raw signal and there is no applied curve to compensate for.
            applied={eq.enabled ? eq.gains : FLAT}
            disabled={!eqId || !eq.enabled}
            onApply={(preset, gains) => setEq({ ...eq, preset, gains })}
          />
        </div>

        {/* Its own grid so the rail fills the column and scrolls inside itself,
            instead of growing the page. */}
        <div className="grid min-h-0 grid-rows-[minmax(0,1fr)]">
          <PresetRail
            active={eq.preset}
            onPreview={setPreview}
            disabled={!eqId || !eq.enabled}
            onPick={(name) => {
              const p = findPreset(name);
              if (p) setEq({ ...eq, preset: name, gains: p.gains.slice() });
            }}
          />
        </div>
      </div>

      <NowPlaying />

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
            className={`pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-xl border px-4 py-2 text-xs backdrop-blur-xl ${
              toast.bad
                ? "border-glow-hot/40 bg-glow-hot/15 text-rose-200"
                : "border-glow/30 bg-glow/[0.12] text-glow"
            }`}
            role="status"
          >
            {toast.text}
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </div>
  );
}
