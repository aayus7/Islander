// The settings window (iOS Settings look). Every change applies live and is saved by the backend.
import { useEffect, useState, type ReactNode } from "react";
import { bridge } from "./bridge";
import { useSettings } from "./lib/settings";
import type { AnimStyle } from "./lib/springs";
import { ALL_MODULES, type ModuleId, type MonitorInfo, type Theme } from "./settings-types";
import { on } from "./lib/native";

export function SettingsPage() {
  const { settings: s, update, reset } = useSettings();
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    bridge.listMonitors().then(setMonitors).catch(() => {});
  }, []);
  const [notifyStatus, setNotifyStatus] = useState<string>("");
  useEffect(() => on<string>("notify://status", setNotifyStatus), []);
  const toggleModule = (id: ModuleId, on: boolean) => {
    const set = new Set(on ? [...s.modules, id] : s.modules.filter((m) => m !== id));
    const next = ALL_MODULES.map((m) => m.id).filter((m) => set.has(m));
    if (next.length) update({ modules: next });
  };

  return (
    <div className="sp">
      <h1>Island</h1>

      <Group title="Behaviour">
        <Row label="Expand on hover" hint="Off: click the island to open it">
          <Switch on={s.expandOnHover} onChange={(v) => update({ expandOnHover: v })} />
        </Row>
        <Row label="Pin open">
          <Switch on={s.pinned} onChange={(v) => update({ pinned: v })} />
        </Row>
        <Row label="Auto-hide" hint="Tucks the island away when idle; touch the top edge to bring it back">
          <Switch on={s.autoHide} onChange={(v) => update({ autoHide: v })} />
        </Row>
        <Row label="Hide during fullscreen" hint="Games, fullscreen video and presentations get the whole screen">
          <Switch on={s.hideInFullscreen} onChange={(v) => update({ hideInFullscreen: v })} />
        </Row>
      </Group>

      <Group title="Tabs" footer="Scroll over the open island to move between tabs. Turn off the ones you don't use.">
        {ALL_MODULES.map((m) => (
          <Row key={m.id} label={m.label}>
            <Switch on={s.modules.includes(m.id)} onChange={(v) => toggleModule(m.id, v)} />
          </Row>
        ))}
      </Group>

      <Group title="Today & Weather" footer="Leave the city empty to use your approximate location. Weather by Open-Meteo.">
        <Row label="City" stack>
          <TextInput value={s.weatherCity} placeholder="Automatic" onChange={(v) => update({ weatherCity: v })} />
        </Row>
        <Row label="Units" stack>
          <Segmented<"C" | "F"> value={s.weatherUnit} options={[["C", "Celsius"], ["F", "Fahrenheit"]]} onChange={(v) => update({ weatherUnit: v })} />
        </Row>
      </Group>

      <Group title="System">
        <Row
          label="Replace Windows popups"
          hint="Windows' volume popup and notification banners stay hidden while the island runs — the island shows them instead. Notifications still go to the Notification Center, and your settings come back when you quit."
        >
          <Switch on={s.takeover} onChange={(v) => update({ takeover: v })} />
        </Row>
        <Row label="Volume & lock pills" hint="Volume, mute, Caps Lock and Num Lock appear in the island">
          <Switch on={s.hud} onChange={(v) => update({ hud: v })} />
        </Row>
        <Row label="Camera & mic dots" hint="Green while the camera is in use, orange for the microphone">
          <Switch on={s.privacyDots} onChange={(v) => update({ privacyDots: v })} />
        </Row>
        <Row
          label="Notifications"
          hint={
            notifyStatus === "denied"
              ? "Windows didn't allow access. Turn on notification access for apps in Windows Settings → Privacy & security → Notifications."
              : notifyStatus === "unavailable"
                ? "Windows' notification listener isn't available on this PC."
                : "Banners for new Windows notifications. Swipe sideways to dismiss."
          }
        >
          <Switch on={s.notifications} onChange={(v) => update({ notifications: v })} />
        </Row>
        <Row label="Do Not Disturb" hint="Island only: no banners (timers still ring)">
          <Switch on={s.dnd} onChange={(v) => update({ dnd: v })} />
        </Row>
        <Row label="Clipboard history" hint="Keeps your recent copies on this PC. Password managers are skipped.">
          <Switch on={s.clipboardHistory} onChange={(v) => update({ clipboardHistory: v })} />
        </Row>
        <Row label="Frame rate" hint="Waveform and glass refresh rate" stack>
          <Segmented<string>
            value={String(s.frameRate)}
            options={[["60", "60 Hz"], ["120", "120 Hz"], ["144", "144 Hz"], ["240", "240 Hz"]]}
            onChange={(v) => update({ frameRate: +v })}
          />
        </Row>
      </Group>

      <Group title="Animation">
        <Row label="Style" stack>
          <Segmented<AnimStyle>
            value={s.animStyle}
            options={[["default", "Default"], ["bouncy", "Bouncy"], ["smooth", "Smooth"], ["snappy", "Snappy"]]}
            onChange={(v) => update({ animStyle: v })}
          />
        </Row>
        <Row label="Speed" value={`${s.animSpeed.toFixed(2)}×`} stack>
          <Slider min={0.25} max={2} step={0.05} value={s.animSpeed} onChange={(v) => update({ animSpeed: v })} />
        </Row>
      </Group>

      <Group title="Appearance">
        <Row label="When nothing is playing" stack>
          <Segmented<"notch" | "dot" | "pill">
            value={s.idleStyle}
            options={[["notch", "Notch"], ["dot", "Dot"], ["pill", "Pill"]]}
            onChange={(v) => update({ idleStyle: v })}
          />
        </Row>
        <Row label="Theme" stack>
          <Segmented<Theme>
            value={s.theme}
            options={[["black", "Black"], ["graphite", "Graphite"], ["midnight", "Midnight"]]}
            onChange={(v) => update({ theme: v })}
          />
        </Row>
        <Row label="Transparency" value={`${Math.round(s.transparency * 100)}%`} stack>
          <Slider min={0} max={0.6} step={0.05} value={s.transparency} onChange={(v) => update({ transparency: v })} />
        </Row>
        <Row label="Size" value={`${Math.round(s.sizeScale * 100)}%`} stack>
          <Slider min={0.7} max={1.6} step={0.05} value={s.sizeScale} onChange={(v) => update({ sizeScale: v })} />
        </Row>
      </Group>

      <Group title="Position">
        <Row label="Display">
          <select className="sp-select" value={s.monitor} onChange={(e) => update({ monitor: e.target.value })}>
            <option value="primary">Primary display</option>
            <option value="follow">Follow mouse</option>
            {monitors.map((m) => (
              <option key={m.index} value={String(m.index)}>
                {m.label}
                {m.primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Horizontal offset" value={`${Math.round(s.offsetX)} px`} stack>
          <Slider min={-800} max={800} step={1} value={s.offsetX} onChange={(v) => update({ offsetX: v })} />
        </Row>
        <Row label="Vertical offset" value={`${Math.round(s.offsetY)} px`} stack>
          <Slider min={-20} max={300} step={1} value={s.offsetY} onChange={(v) => update({ offsetY: v })} />
        </Row>
        <button className="sp-link" onClick={() => update({ offsetX: 0, offsetY: 0 })}>
          Re-centre
        </button>
      </Group>

      <Group
        title="AI (Gemini)"
        footer="Get a free key at aistudio.google.com/apikey. On Google's free tier your questions may be used to improve their products — fine for testing, not for private info. Keys stay on this PC."
      >
        <Row label="API key" stack>
          <SecretInput value={s.aiApiKey} placeholder="Paste your Gemini API key" onChange={(v) => update({ aiApiKey: v })} />
        </Row>
        <Row label="Model" hint="Fast = Flash-Lite (quickest, Siri-like). Smart = Flash (a bit better reasoning, slower)." stack>
          <Segmented<string>
            value={s.aiModel === "gemini-flash-latest" ? "smart" : s.aiModel === "gemini-flash-lite-latest" ? "fast" : "custom"}
            options={[["fast", "Fast"], ["smart", "Smart"], ["custom", "Custom"]]}
            onChange={(v) => {
              if (v === "fast") update({ aiModel: "gemini-flash-lite-latest" });
              if (v === "smart") update({ aiModel: "gemini-flash-latest" });
            }}
          />
          <TextInput value={s.aiModel} placeholder="gemini-flash-lite-latest" onChange={(v) => update({ aiModel: v || "gemini-flash-lite-latest" })} />
        </Row>
        <Row label="Relay URL" hint="For keyless use: your deployed relay (see the relay folder). Leave empty when using your own key." stack>
          <TextInput value={s.aiRelayUrl} placeholder="https://island-ai-relay.you.workers.dev" onChange={(v) => update({ aiRelayUrl: v })} />
        </Row>
        <Row label="Liquid glass" hint="Real refraction of what's behind the panel (captured locally, never saved or sent)">
          <Switch on={s.aiGlass} onChange={(v) => update({ aiGlass: v })} />
        </Row>
        <Row label="Search or Ask">
          <HotkeyInput value={s.aiHotkey} onChange={(v) => update({ aiHotkey: v })} />
        </Row>
      </Group>

      <Group title="Shortcuts" footer="Hiding the island parks it completely. The hotkey is the only way back, so keep one set.">
        <Row label="Hide / show island">
          <HotkeyInput value={s.hideHotkey} onChange={(v) => update({ hideHotkey: v })} />
        </Row>
      </Group>

      <Group>
        <button className="sp-danger" onClick={reset}>
          Reset All Settings
        </button>
      </Group>
    </div>
  );
}

/* ---------- building blocks ---------- */

function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <section className="sp-group">
      {title && <div className="sp-title">{title}</div>}
      <div className="sp-card">{children}</div>
      {footer && <div className="sp-footer">{footer}</div>}
    </section>
  );
}

function Row({ label, value, hint, stack, children }: { label: string; value?: string; hint?: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={`sp-row ${stack ? "stack" : ""}`}>
      <div className="sp-label">
        <span>{label}</span>
        {value && <span className="sp-value">{value}</span>}
        {hint && <span className="sp-hint">{hint}</span>}
      </div>
      <div className="sp-control">{children}</div>
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange(v: boolean): void }) {
  return (
    <button className={`sp-switch ${on ? "on" : ""}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  const i = Math.max(0, options.findIndex(([v]) => v === value));
  return (
    <div className="sp-seg" style={{ ["--n" as string]: options.length, ["--i" as string]: i }}>
      <div className="sp-seg-thumb" />
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({ min, max, step, value, onChange }: { min: number; max: number; step: number; value: number; onChange(v: number): void }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      className="sp-slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ["--p" as string]: `${pct}%` }}
      onChange={(e) => onChange(+e.target.value)}
    />
  );
}

/** Text field that saves when you leave it (or press Enter), not on every keystroke. */
function TextInput({ value, placeholder, onChange, type = "text" }: { value: string; placeholder?: string; onChange(v: string): void; type?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onChange(v.trim());
  return (
    <input
      className="sp-text"
      type={type}
      value={v}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

function SecretInput(props: { value: string; placeholder?: string; onChange(v: string): void }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <div style={{ flex: 1 }}>
        <TextInput {...props} type={show ? "text" : "password"} />
      </div>
      <button className="sp-hotkey" style={{ minWidth: 64 }} onClick={() => setShow((x) => !x)}>
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

const KEY_NAMES: Record<string, string> = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc" };

function HotkeyInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") return setRecording(false);
      if (e.key === "Backspace" || e.key === "Delete") {
        onChange("");
        return setRecording(false);
      }
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; // wait for the real key
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
      if (!mods.length) return; // a global hotkey needs at least one modifier
      const code = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : KEY_NAMES[e.key] ?? e.code;
      onChange([...mods, code].join("+"));
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <button className={`sp-hotkey ${recording ? "rec" : ""}`} onClick={() => setRecording((r) => !r)}>
      {recording ? "Press keys…" : value || "None"}
    </button>
  );
}
