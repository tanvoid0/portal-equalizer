import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { AiConfig, EapoStatus, PresetMode, Settings } from "../types";
import { PRESETS, SIMPLE } from "../presets";
import { Switch } from "./Switch";
import { AlertIcon, ChevronIcon, DevicesIcon, GearIcon, ToneIcon, WandIcon } from "./icons";

export type Section = "general" | "devices" | "presets" | "ai" | "engine";

const SECTIONS: { id: Section; label: string; icon: (p: { className?: string }) => JSX.Element }[] = [
  { id: "general", label: "General", icon: GearIcon },
  { id: "devices", label: "Devices", icon: DevicesIcon },
  { id: "presets", label: "Presets", icon: ToneIcon },
  { id: "ai", label: "AI", icon: WandIcon },
  { id: "engine", label: "Engine", icon: AlertIcon },
];

type Conn = { ok: boolean; note: string } | null;

/** Version line plus whatever the last update check said about it. */
function Updates() {
  const [version, setVersion] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "current" | "ready" | "error">("idle");
  const [note, setNote] = useState("");

  useEffect(() => {
    invoke<string>("app_version").then(setVersion).catch(() => {});
  }, []);

  const check = async () => {
    setState("busy");
    try {
      const next = await invoke<string | null>("check_update");
      if (next) {
        setNote(next);
        setState("ready");
      } else {
        setState("current");
      }
    } catch (e) {
      setNote(String(e));
      setState("error");
    }
  };

  // No return: the app restarts into the new version from inside this call.
  const install = async () => {
    setState("busy");
    try {
      await invoke("install_update");
    } catch (e) {
      setNote(String(e));
      setState("error");
    }
  };

  return (
    <Row
      title="Updates"
      hint={
        state === "ready"
          ? `Version ${note} is available. Installing restarts the app.`
          : state === "error"
            ? note
            : state === "current"
              ? `Version ${version} is the latest.`
              : `Version ${version || "…"}. Updates are downloaded from GitHub and checked against the release signing key.`
      }
    >
      <button
        className="btn"
        disabled={state === "busy"}
        onClick={state === "ready" ? install : check}
      >
        {state === "busy" ? "Working…" : state === "ready" ? `Install ${note}` : "Check now"}
      </button>
    </Row>
  );
}

/** Label, explanation, control. Every setting is one of these. */
function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 border-t border-white/[0.05] py-3 first:border-0 first:pt-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-slate-200">{title}</p>
        <p className="pt-0.5 text-[11px] leading-relaxed text-slate-500">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center pt-0.5">{children}</div>
    </div>
  );
}

function Group({ id, title, children }: { id: Section; title: string; children: React.ReactNode }) {
  return (
    <section id={`settings-${id}`} className="panel scroll-mt-3 p-4">
      <h3 className="pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function SettingsPage({
  settings,
  onChange,
  status,
  focus,
  onClose,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
  status: EapoStatus | null;
  /** Which section to scroll to when the page opens. */
  focus: Section;
  onClose: () => void;
}) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [conn, setConn] = useState<Conn>(null);
  const [err, setErr] = useState<string | null>(null);

  const ai = settings.ai;
  const setAi = (next: Partial<AiConfig>) => onChange({ ...settings, ai: { ...ai, ...next } });

  // The Run key is the source of truth, not our settings file - read it rather
  // than remembering what we last wrote there.
  useEffect(() => {
    invoke<boolean>("autostart_enabled")
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, []);

  const check = useCallback(async () => {
    setConn(null);
    try {
      const ids = await invoke<string[]>("ai_models", { cfg: settings.ai });
      setModels(ids);
      setConn({ ok: true, note: `${ids.length} models available` });
      if (!settings.ai.model && ids.length) setAi({ model: ids[0] });
    } catch (e) {
      setConn({ ok: false, note: String(e) });
    }
  }, [settings.ai.base_url, settings.ai.token]);

  // Answer "is the server there?" on open, rather than making the user press a
  // button to find out - but only once, or every keystroke in the token field
  // would cost a request.
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    void check();
  }, [check]);

  useEffect(() => {
    document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Optimistic, then corrected: the registry write can fail on a locked-down
  // account and the switch must not keep claiming it worked.
  const toggleAutostart = async (on: boolean) => {
    setAutostart(on);
    try {
      await invoke("set_autostart", { on });
      setErr(null);
    } catch (e) {
      setAutostart(!on);
      setErr(String(e));
    }
  };

  const simpleCount = PRESETS.filter((p) => SIMPLE.has(p.name)).length;

  const jump = (id: Section) =>
    document
      .getElementById(`settings-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: "spring", stiffness: 500, damping: 40 }}
      className="absolute inset-0 z-30 flex flex-col gap-3 bg-ink-900/95 p-3 backdrop-blur-xl"
      role="dialog"
      aria-label="Settings"
    >
      <div className="flex shrink-0 items-center gap-3">
        <button onClick={onClose} className="btn" aria-label="Back">
          <ChevronIcon className="h-3.5 w-3.5 rotate-90" />
          Back
        </button>
        <h2 className="text-[13px] font-semibold tracking-tight text-slate-200">Settings</h2>
        <div className="ml-auto flex flex-wrap justify-end gap-1">
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => jump(s.id)} className="btn">
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <p className="shrink-0 rounded-lg border border-glow-hot/30 bg-glow-hot/[0.08] px-3 py-2 text-[11px] text-rose-200">
          {err}
        </p>
      )}

      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3 overflow-y-auto pr-1">
        <Group id="general" title="General">
          <Row
            title="Start with Windows"
            hint="Adds Portal Equalizer to this account's startup items. Device switching and app rules only happen while it is running."
          >
            <Switch
              on={!!autostart}
              disabled={autostart === null}
              onChange={toggleAutostart}
              label=""
              title="Start at login"
            />
          </Row>
          <Row
            title="Start hidden"
            hint="Launch straight to the tray with no window. Click the tray icon to bring it back."
          >
            <Switch
              on={settings.start_minimised}
              onChange={(start_minimised) => onChange({ ...settings, start_minimised })}
              label=""
              title="Start hidden"
            />
          </Row>
          <Row
            title="Close to tray"
            hint="Closing the window hides it instead of quitting. Off means the close button really quits — and automatic switching stops with it."
          >
            <Switch
              on={settings.close_to_tray}
              onChange={(close_to_tray) => onChange({ ...settings, close_to_tray })}
              label=""
              title="Close to tray"
            />
          </Row>
          <Updates />
        </Group>

        <Group id="devices" title="Devices">
          <Row
            title="Switch automatically"
            hint="As devices come and go, move to the highest one in the priority list that is plugged in."
          >
            <Switch
              on={settings.auto_switch}
              onChange={(auto_switch) => onChange({ ...settings, auto_switch })}
              label=""
              title="Automatic device switching"
            />
          </Row>
          <Row
            title="Show inactive devices"
            hint="Endpoints that are unplugged, disabled or absent. They keep their place in the priority list while hidden, and whatever is playing right now is always shown."
          >
            <Switch
              on={settings.show_inactive}
              onChange={(show_inactive) => onChange({ ...settings, show_inactive })}
              label=""
              title="Show inactive devices"
            />
          </Row>
          <Row
            title="Show virtual devices"
            hint="Software endpoints — Steam streaming, Oculus, virtual cables — rather than real hardware."
          >
            <Switch
              on={settings.show_virtual}
              onChange={(show_virtual) => onChange({ ...settings, show_virtual })}
              label=""
              title="Show virtual devices"
            />
          </Row>
        </Group>

        <Group id="presets" title="Presets">
          <Row
            title="Catalogue"
            hint={`Simple offers ${simpleCount} presets, one for each usual reason to reach for one. Advanced offers all ${PRESETS.length}, grouped by genre, scene, headphone type and problem.`}
          >
            <div className="flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
              {(["simple", "advanced"] as PresetMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => onChange({ ...settings, preset_mode: m })}
                  aria-pressed={settings.preset_mode === m}
                  className={`rounded-md px-3 py-1 text-xs font-medium capitalize ${
                    settings.preset_mode === m
                      ? "bg-white/10 text-slate-100"
                      : "text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </Row>
        </Group>

        <Group id="ai" title="AI suggestions">
          <Row
            title="Smart mode"
            hint="Puts its pick on the sliders itself when the track changes, and stops for the rest of that track the moment you move a band by hand. Off, it only suggests and you click to apply."
          >
            <Switch on={ai.auto} onChange={(auto) => setAi({ auto })} label="" title="Smart mode" />
          </Row>

          <div className="border-t border-white/[0.05] py-3">
            <div className="flex items-center gap-2 pb-2.5 text-[11px]">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  conn === null ? "bg-slate-600" : conn.ok ? "bg-glow" : "bg-glow-hot"
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-slate-400" title={conn?.note}>
                {conn === null
                  ? "Checking AI server…"
                  : conn.ok
                    ? `Connected — ${conn.note}`
                    : `Not connected — ${conn.note}`}
              </span>
              <button type="button" className="btn" onClick={check}>
                Retry
              </button>
            </div>

            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 text-[11px] text-slate-400">
              <span>Server</span>
              <input
                value={ai.base_url}
                onChange={(e) => setAi({ base_url: e.target.value })}
                placeholder="http://127.0.0.1:18410"
                className="field"
              />

              <span>Token</span>
              <input
                type="password"
                value={ai.token}
                onChange={(e) => setAi({ token: e.target.value })}
                placeholder="agp_… (blank uses $AGENT_PLATFORM_TOKEN)"
                className="field"
              />

              <span>Model</span>
              {models.length ? (
                <div className="relative">
                  <select
                    value={ai.model}
                    onChange={(e) => setAi({ model: e.target.value })}
                    className="select"
                  >
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <ChevronIcon className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                </div>
              ) : (
                <input
                  value={ai.model}
                  onChange={(e) => setAi({ model: e.target.value })}
                  placeholder="model id"
                  className="field"
                />
              )}
            </div>

            <p className="pt-2 text-[11px] leading-relaxed text-slate-600">
              Without a server the tonal match still works: it reads the spectrum, it just
              cannot tell what the track is.
            </p>
          </div>
        </Group>

        <Group id="engine" title="Equalizer APO">
          <Row
            title="Status"
            hint={
              status?.installed
                ? `Hooked into ${status.hooked_devices} endpoint${
                    status.hooked_devices === 1 ? "" : "s"
                  }. EQ on any other one is silent — re-run the Equalizer APO Configurator to add it.`
                : "Not installed. Nothing here is audible until it is: Equalizer APO is the engine, this app is the interface."
            }
          >
            <span className={status?.installed && status.writable ? "chip-live" : "chip-warn"}>
              {!status?.installed ? "missing" : status.writable ? "ready" : "read-only"}
            </span>
          </Row>
          <Row
            title="Config file"
            hint={status?.config_path ?? "No config path found."}
          >
            <span className="chip-quiet">generated</span>
          </Row>
        </Group>
      </div>
    </motion.div>
  );
}
