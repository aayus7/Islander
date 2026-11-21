// The settings window: a desktop app in the style of macOS System Settings — sidebar
// with coloured icons, a search field, and grouped pages. Every change applies live
// and is saved by the backend.
import { AnimatePresence, motion, Reorder, useDragControls } from "motion/react";
import { browserName, connectedBrowsers, STORE, type Browser } from "./lib/extension";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bridge } from "./bridge";
import { useSettings } from "./lib/settings";
import type { AnimStyle } from "./lib/springs";
import { ALL_MODULES, type Dock, type DockAlong, type ModuleId, type MonitorInfo, type Theme } from "./settings-types";
import { on, send } from "./lib/native";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { TabGlyph } from "./island/TabDock";

const APP_VERSION = __APP_VERSION__;
const FAST = "gemini-3.5-flash-lite";
const SMART = "gemini-3.6-flash";

type PageId = "general" | "tabs" | "system" | "appearance" | "motion" | "position" | "weather" | "ai" | "shortcuts" | "about";

const PAGES: { id: PageId; label: string; color: string; icon: ReactNode }[] = [
  { id: "general", label: "General", color: "#8e8e93", icon: <Ico d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.5h4l.4-2.5c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4z" /> },
  { id: "tabs", label: "Tabs", color: "#0a84ff", icon: <Ico d="M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z" round /> },
  { id: "system", label: "Notifications & System", color: "#ff453a", icon: <Ico d="M18 16.5V11a6 6 0 0 0-12 0v5.5L4.5 18h15zM10 20.5a2 2 0 0 0 4 0" /> },
  { id: "appearance", label: "Appearance", color: "#5e5ce6", icon: <Ico d="M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18" fillHalf /> },
  { id: "motion", label: "Animation", color: "#bf5af2", icon: <Ico d="M4 17c3-9 6-9 8 0s5 9 8 0" /> },
  { id: "position", label: "Position & Display", color: "#30d158", icon: <Ico d="M3.5 5.5h17v11h-17zM8.5 20h7M12 16.5V20M9.5 8.5h5" /> },
  { id: "weather", label: "Weather", color: "#32ade6", icon: <Ico d="M7.5 18.5h9.5a3.6 3.6 0 0 0 .4-7.2 5.2 5.2 0 0 0-9.9 1.3 3 3 0 0 0 0 5.9z" solid /> },
  { id: "ai", label: "Search or Ask", color: "linear-gradient(135deg,#ff6b6b,#a95cff 55%,#4c8dff)", icon: <Ico d="M11 2.5c.5 4.6 2.9 7 7.5 7.5-4.6.5-7 2.9-7.5 7.5-.5-4.6-2.9-7-7.5-7.5 4.6-.5 7-2.9 7.5-7.5z" solid /> },
  { id: "shortcuts", label: "Keyboard Shortcuts", color: "#636366", icon: <Ico d="M3 6.5h18v11H3zM6.5 10h1M10 10h1M13.5 10h1M17 10h.5M8 14h8" /> },
  { id: "about", label: "About", color: "#8e8e93", icon: <Ico d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.6v.1" /> },
];

/* Search: rows that don't match the query hide themselves; empty groups/pages vanish (CSS :has). */
const QueryCtx = createContext("");

export function SettingsPage() {
  const [page, setPage] = useState<PageId>("general");
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (e.key === "Escape" && document.activeElement === search.current) {
        setQuery("");
        search.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <QueryCtx.Provider value={q}>
      <div className="sp-app">
        <aside className="sp-side">
          <div className="sp-brand">
            <div className="sp-appicon">
              <span />
            </div>
            <div>
              <div className="sp-brand-name">Islander</div>
              <div className="sp-brand-ver">Version {APP_VERSION}</div>
            </div>
          </div>
          <label className="sp-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="M15.5 15.5 20 20" />
            </svg>
            <input ref={search} value={query} placeholder="Search" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button className="sp-search-clear" onClick={() => setQuery("")} aria-label="Clear">
                <svg width="14" height="14" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" fill="currentColor" />
                  <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#2a2a2c" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </label>
          <nav className="sp-nav">
            {PAGES.map((p, i) => (
              <button
                key={p.id}
                className={`sp-nav-item ${!q && page === p.id ? "on" : ""} ${i === 8 ? "gap" : ""}`}
                onClick={() => {
                  setQuery("");
                  setPage(p.id);
                }}
              >
                <span className="sp-nav-ico" style={{ background: p.color }}>
                  {p.icon}
                </span>
                <span className="sp-nav-label">{p.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <main className="sp-main">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={q ? "search" : page}
              className="sp-scroll"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.25, 0.1, 0.25, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            >
              <div className="sp-content">
                {q ? (
                  <>
                    {PAGES.map((p) => (
                      <section key={p.id} className="sp-result">
                        <h2 className="sp-result-title">
                          <span className="sp-nav-ico sm" style={{ background: p.color }}>
                            {p.icon}
                          </span>
                          {p.label}
                        </h2>
                        <Page id={p.id} />
                      </section>
                    ))}
                    <div className="sp-noresults">No results for “{query.trim()}”</div>
                  </>
                ) : (
                  <>
                    <h1 className="sp-h1">{PAGES.find((p) => p.id === page)!.label}</h1>
                    <Page id={page} />
                  </>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </QueryCtx.Provider>
  );
}

/* ---------- pages ---------- */

function Page({ id }: { id: PageId }) {
  switch (id) {
    case "general":
      return <General />;
    case "tabs":
      return <Tabs />;
    case "system":
      return <SystemPage />;
    case "appearance":
      return <Appearance />;
    case "motion":
      return <MotionPage />;
    case "position":
      return <Position />;
    case "weather":
      return <WeatherPage />;
    case "ai":
      return <Ai />;
    case "shortcuts":
      return <Shortcuts />;
    case "about":
      return <About />;
  }
}

function General() {
  const { settings: s, update } = useSettings();
  return (
    <>
      <Group>
        <Row label="Open at login" hint="Start Islander when you sign in to Windows">
          <Switch on={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
        </Row>
      </Group>
      <Group title="Island">
        <Row label="Expand on hover" hint="When off, click the island to open it">
          <Switch on={s.expandOnHover} onChange={(v) => update({ expandOnHover: v })} />
        </Row>
        <Row label="Keep open" hint="The island stays expanded until you turn this off">
          <Switch on={s.pinned} onChange={(v) => update({ pinned: v })} />
        </Row>
        <Row label="Auto-hide" hint="Tucks the island away when idle; touch the top edge of the screen to bring it back">
          <Switch on={s.autoHide} onChange={(v) => update({ autoHide: v })} />
        </Row>
        <Row label="Hide during fullscreen" hint="Games, fullscreen video and presentations get the whole screen">
          <Switch on={s.hideInFullscreen} onChange={(v) => update({ hideInFullscreen: v })} />
        </Row>
        <Row label="Show in screen recordings" hint="When off, recordings from Controls leave the island out. You still see it, red rim and all.">
          <Switch on={s.showInRecordings} onChange={(v) => update({ showInRecordings: v })} />
        </Row>
      </Group>
      <NearbySettings />
    </>
  );
}

/** Nearby sharing (LocalSend) — on/off, and the name phones see. */
function NearbySettings() {
  const { settings: s, update } = useSettings();
  const [info, setInfo] = useState<{ alias?: string; saveDir?: string; port?: number }>({});
  useEffect(() => {
    invoke<{ alias?: string; saveDir?: string; port?: number }>("localsend_info").then(setInfo).catch(() => {});
  }, [s.nearbySharing, s.nearbyName]);
  return (
    <Group
      title="Nearby sharing"
      footer={`Send Shelf files to phones and computers running the free LocalSend app (localsend.org) on the same Wi-Fi, and receive from them; you're always asked first. Received files go to ${info.saveDir || "your Downloads folder"} and appear on the Shelf. If Windows asks, allow Islander on private networks.`}
    >
      <Row label="Share with nearby devices" hint="Shows nearby phones under the Shelf">
        <Switch on={s.nearbySharing !== false} onChange={(v) => update({ nearbySharing: v })} />
      </Row>
      {s.nearbySharing !== false && (
        <Row label="Name on other devices">
          <TextInput value={s.nearbyName} placeholder={info.alias || "This PC"} align="right" onChange={(v) => update({ nearbyName: v })} />
        </Row>
      )}
    </Group>
  );
}

function Tabs() {
  const { settings: s, update } = useSettings();
  const enabled = s.modules;
  const disabled = ALL_MODULES.map((m) => m.id).filter((id) => !enabled.includes(id));
  const [order, setOrder] = useState(enabled);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setOrder(enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled.join()]);
  const label = (id: ModuleId) => ALL_MODULES.find((m) => m.id === id)!.label;

  const toggle = (id: ModuleId, on: boolean) => {
    // A tab that's switched back on goes after its usual neighbour.
    const next = enabled.filter((m) => m !== id);
    if (on) {
      const ids = ALL_MODULES.map((m) => m.id);
      const before = ids.slice(0, ids.indexOf(id)).reverse().find((m) => next.includes(m));
      next.splice(before ? next.indexOf(before) + 1 : 0, 0, id);
    }
    if (next.length) update({ modules: next });
  };

  return (
    <>
      <Group title="Shown in the island" footer="Drag to change the order. You can also drag icons in the island's tab dock, or scroll over the open island to move between tabs.">
        <Reorder.Group as="div" axis="y" values={order} onReorder={setOrder} className="sp-reorder">
          {order.map((id) => (
            <TabRow
              key={id}
              id={id}
              label={label(id)}
              onDragStart={() => (dragging.current = true)}
              onDragEnd={() => {
                dragging.current = false;
                if (order.join() !== enabled.join()) update({ modules: order });
              }}
              canDisable={enabled.length > 1}
              onToggle={(v) => toggle(id, v)}
            />
          ))}
        </Reorder.Group>
      </Group>
      {disabled.length > 0 && (
        <Group title="Hidden">
          {disabled.map((id) => (
            <Row key={id} label={label(id)} icon={<TabIcon id={id} />}>
              <Switch on={false} onChange={(v) => toggle(id, v)} />
            </Row>
          ))}
        </Group>
      )}
    </>
  );
}

function TabIcon({ id }: { id: ModuleId }) {
  return (
    <span className="sp-row-ico">
      <TabGlyph tab={id} size={15} />
    </span>
  );
}

function TabRow({ id, label, onDragStart, onDragEnd, canDisable, onToggle }: { id: ModuleId; label: string; onDragStart(): void; onDragEnd(): void; canDisable: boolean; onToggle(v: boolean): void }) {
  const controls = useDragControls();
  const q = useContext(QueryCtx);
  if (q && !label.toLowerCase().includes(q)) return null;
  return (
    <Reorder.Item
      as="div"
      value={id}
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="sp-row sp-row-drag"
      whileDrag={{ scale: 1.02, boxShadow: "0 10px 30px rgba(0,0,0,0.45)", backgroundColor: "#3a3a3c", zIndex: 2 }}
      transition={{ type: "spring", stiffness: 600, damping: 45 }}
    >
      <span className="sp-grip" onPointerDown={(e) => controls.start(e)} aria-label="Drag to reorder">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <rect x="1" y="2.5" width="10" height="1.4" rx=".7" />
          <rect x="1" y="5.3" width="10" height="1.4" rx=".7" />
          <rect x="1" y="8.1" width="10" height="1.4" rx=".7" />
        </svg>
      </span>
      <TabIcon id={id} />
      <div className="sp-label">
        <span>{label}</span>
      </div>
      <div className="sp-control">
        <Switch on disabled={!canDisable} onChange={onToggle} />
      </div>
    </Reorder.Item>
  );
}

/** Names chosen so the island picks each model's own animation, exactly as a real connection would. */
const PREVIEW_DEVICES: [string, string][] = [
  ["AirPods Max", "AirPods Max"],
  ["AirPods Pro", "AirPods Pro (2nd gen)"],
  ["AirPods Pro 3", "AirPods Pro 3"],
  ["AirPods Pro 1st", "AirPods Pro (1st gen)"],
  ["AirPods 4 ANC", "AirPods 4 with noise cancelling"],
  ["AirPods 4", "AirPods 4"],
  ["AirPods 3rd", "AirPods (3rd gen)"],
  ["AirPods", "AirPods (2nd gen)"],
  ["AirPods 1st", "AirPods (1st gen)"],
  ["Beats Fit Pro", "Beats Fit Pro"],
  ["WH-1000XM5", "Other headphones"],
];

function DevicePreview() {
  const [pick, setPick] = useState(PREVIEW_DEVICES[0][0]);
  const play = () => {
    const level = 40 + Math.round(Math.random() * 55);
    // Same as a real connection: the popup opens with the charge already in it.
    emit("bt://connected", { id: `preview-${Date.now()}`, name: pick, connected: true, kind: "audio", battery: level, audio: true });
  };
  return (
    <Group title="Bluetooth devices" footer="Plays the connection animation in the island as if this device just connected. Nothing is paired or changed.">
      <Row label="Preview connection">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Select value={pick} options={PREVIEW_DEVICES} onChange={setPick} />
          <button className="sp-btn" onClick={play}>Play</button>
        </div>
      </Row>
    </Group>
  );
}

function SystemPage() {
  const { settings: s, update } = useSettings();
  const [notifyStatus, setNotifyStatus] = useState<string>("");
  useEffect(() => on<string>("notify://status", setNotifyStatus), []);
  return (
    <>
      <Group title="Notifications">
        <Row
          label="Show notifications"
          hint={
            notifyStatus === "denied"
              ? "Windows didn't allow access. Turn on notification access in Windows Settings → Privacy & security → Notifications."
              : notifyStatus === "unavailable"
                ? "Windows' notification listener isn't available on this PC."
                : "New Windows notifications appear as banners in the island. Swipe sideways to dismiss."
          }
        >
          <Switch on={s.notifications} onChange={(v) => update({ notifications: v })} />
        </Row>
        <Row label="Do Not Disturb" hint="No banners from Islander. Timers still ring.">
          <Switch on={s.dnd} onChange={(v) => update({ dnd: v })} />
        </Row>
      </Group>
      <DevicePreview />
      <Group title="Windows" footer="While Islander runs, Windows' own volume popup and notification banners stay hidden and the island shows them instead. Notifications still go to the Notification Center, and Windows gets its popups back when you quit.">
        <Row label="Replace Windows popups">
          <Switch on={s.takeover} onChange={(v) => update({ takeover: v })} />
        </Row>
        <Row label="Volume & lock indicators" hint="Volume, brightness, mute, Caps Lock and Num Lock appear in the island">
          <Switch on={s.hud} onChange={(v) => update({ hud: v })} />
        </Row>
        <Row label="Camera & microphone dots" hint="Green while the camera is in use, orange for the microphone">
          <Switch on={s.privacyDots} onChange={(v) => update({ privacyDots: v })} />
        </Row>
      </Group>
      <Group title="Privacy">
        <Row label="Clipboard history" hint="Keeps your recent copies on this PC only. Password managers are skipped.">
          <Switch on={s.clipboardHistory} onChange={(v) => update({ clipboardHistory: v })} />
        </Row>
      </Group>
    </>
  );
}

function Appearance() {
  const { settings: s, update } = useSettings();
  return (
    <>
      <Group title="Theme">
        <div className="sp-swatches">
          {(
            [
              ["black", "Black", "#000"],
              ["graphite", "Graphite", "#1c1c1e"],
              ["midnight", "Midnight", "#0b1424"],
            ] as [Theme, string, string][]
          ).map(([v, name, c]) => (
            <button key={v} className={`sp-swatch ${s.theme === v ? "on" : ""}`} onClick={() => update({ theme: v })}>
              <span className="sp-swatch-prev" style={{ background: "linear-gradient(160deg,#5b6b8c,#2b2f3d)" }}>
                <span className="sp-swatch-pill" style={{ background: c }} />
              </span>
              <span>{name}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group>
        <Row label="When nothing is playing" stack>
          <Segmented<"notch" | "dot" | "pill">
            value={s.idleStyle}
            options={[
              ["notch", "Notch"],
              ["dot", "Dot"],
              ["pill", "Pill"],
            ]}
            onChange={(v) => update({ idleStyle: v })}
          />
        </Row>
        <Row label="Transparency" value={`${Math.round(s.transparency * 100)}%`} stack>
          <Slider min={0} max={0.6} step={0.05} value={s.transparency} onChange={(v) => update({ transparency: v })} />
        </Row>
        <Row label="Size" value={`${Math.round(s.sizeScale * 100)}%`} stack>
          <Slider min={0.7} max={1.6} step={0.05} value={s.sizeScale} onChange={(v) => update({ sizeScale: v })} />
        </Row>
      </Group>
      <Group footer="Inter comes with Islander. System uses SF Pro if you've installed it, otherwise Segoe UI.">
        <Row label="Font">
          <Segmented<"inter" | "system">
            compact
            value={s.font}
            options={[
              ["inter", "Inter"],
              ["system", "System"],
            ]}
            onChange={(v) => update({ font: v })}
          />
        </Row>
      </Group>
    </>
  );
}

function MotionPage() {
  const { settings: s, update } = useSettings();
  return (
    <>
      <Group>
        <Row label="Style" stack>
          <Segmented<AnimStyle>
            value={s.animStyle}
            options={[
              ["default", "Default"],
              ["bouncy", "Bouncy"],
              ["smooth", "Smooth"],
              ["snappy", "Snappy"],
            ]}
            onChange={(v) => update({ animStyle: v })}
          />
        </Row>
        <Row label="Speed" value={`${s.animSpeed.toFixed(2)}×`} stack>
          <Slider min={0.25} max={2} step={0.05} value={s.animSpeed} onChange={(v) => update({ animSpeed: v })} />
        </Row>
      </Group>
      <Group footer="Match your display's refresh rate for the smoothest waveform and glass. Higher rates use a little more power.">
        <Row label="Frame rate" stack>
          <Segmented<string>
            value={String(s.frameRate)}
            options={[
              ["60", "60 Hz"],
              ["120", "120 Hz"],
              ["144", "144 Hz"],
              ["240", "240 Hz"],
            ]}
            onChange={(v) => update({ frameRate: +v })}
          />
        </Row>
      </Group>
    </>
  );
}

function Position() {
  const { settings: s, update } = useSettings();
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    bridge.listMonitors().then(setMonitors).catch(() => {});
  }, []);
  return (
    <>
      <Group title="Where the island lives" footer="Click a spot, or press and hold the island itself and drag it to any edge of the screen. On the left and right edges it stands upright.">
        <DockPicker />
      </Group>
      <Group>
        <Row label="Display">
          <Select
            value={s.monitor}
            onChange={(v) => update({ monitor: v })}
            options={[
              ["primary", "Primary display"],
              ["follow", "Follow mouse"],
              ...monitors.map((m) => [String(m.index), `${m.label}${m.primary ? " (primary)" : ""}`] as [string, string]),
            ]}
          />
        </Row>
      </Group>
      {s.dock === "top" && s.dockAlong === "center" && (
      <Group title="Fine-tune">
        <Row label="Horizontal offset" value={`${Math.round(s.offsetX)} px`} stack>
          <Slider min={-1600} max={1600} step={1} value={s.offsetX} onChange={(v) => update({ offsetX: v })} />
        </Row>
        <Row label="Vertical offset" value={`${Math.round(s.offsetY)} px`} stack>
          <Slider min={-20} max={300} step={1} value={s.offsetY} onChange={(v) => update({ offsetY: v })} />
        </Row>
        <Row label="Back to the centre">
          <button className="sp-btn" disabled={!s.offsetX && !s.offsetY} onClick={() => update({ offsetX: 0, offsetY: 0 })}>
            Re-centre
          </button>
        </Row>
      </Group>
      )}
    </>
  );
}

function WeatherPage() {
  const { settings: s, update } = useSettings();
  return (
    <Group footer="Leave the city empty to use your approximate location. Weather data by Open-Meteo.">
      <Row label="City">
        <TextInput value={s.weatherCity} placeholder="Automatic" onChange={(v) => update({ weatherCity: v })} align="right" />
      </Row>
      <Row label="Units">
        <Segmented<"C" | "F">
          compact
          value={s.weatherUnit}
          options={[
            ["C", "°C"],
            ["F", "°F"],
          ]}
          onChange={(v) => update({ weatherUnit: v })}
        />
      </Row>
    </Group>
  );
}

function Ai() {
  const { settings: s, update } = useSettings();
  return (
    <>
      <Group footer="Search or Ask works out of the box through Islander's free service (a fair daily limit per PC), which looks up live info on Wikipedia, news headlines and sports scoreboards. Questions go to Google Gemini's free tier, where Google may use them to improve its products, so avoid private information. Optional: add your own key from aistudio.google.com/apikey to use your own quota; it stays on this PC.">
        <Row label="Your own Gemini API key (optional)" stack>
          <SecretInput value={s.aiApiKey} placeholder="Not needed — leave empty to use the free service" onChange={(v) => update({ aiApiKey: v })} />
        </Row>
      </Group>
      <Group footer="Fast uses Gemini 3.5 Flash-Lite (quickest). Smart uses Gemini 3.6 Flash (better reasoning, a little slower). With your own key, live answers use Google Search when your key allows it (it needs billing turned on in AI Studio); otherwise the free service's web lookups are used.">
        <Row label="Model" stack>
          <Segmented<string>
            value={s.aiModel === SMART ? "smart" : s.aiModel === FAST ? "fast" : "custom"}
            options={[
              ["fast", "Fast"],
              ["smart", "Smart"],
              ["custom", "Custom"],
            ]}
            onChange={(v) => {
              if (v === "fast") update({ aiModel: FAST });
              if (v === "smart") update({ aiModel: SMART });
              if (v === "custom" && (s.aiModel === FAST || s.aiModel === SMART)) update({ aiModel: "gemini-" });
            }}
          />
          {s.aiModel !== FAST && s.aiModel !== SMART && <TextInput value={s.aiModel} placeholder={FAST} onChange={(v) => update({ aiModel: v || FAST })} />}
        </Row>
      </Group>
      <Group footer="Voice questions are typed out live by Windows' own speech recognition, which needs Windows' “Online speech recognition” setting. When it's off, Islander sends the recording to Gemini instead, which is slower.">
        <Row label="Fast voice typing" hint="Turn on Online speech recognition in Windows">
          <button className="sp-btn" onClick={() => send("launch", { target: "ms-settings:privacy-speech" })}>Open Speech Settings</button>
        </Row>
      </Group>
      <Group>
        <Row label="Liquid glass" hint="Real refraction of what's behind the panel. Captured on this PC only, never saved or sent.">
          <Switch on={s.aiGlass} onChange={(v) => update({ aiGlass: v })} />
        </Row>
      </Group>
      <Group title="Advanced">
        <Row label="Service URL" hint="Leave empty for Islander's free service. Only change this if you run your own relay." stack>
          <TextInput value={s.aiRelayUrl} placeholder="https://…" onChange={(v) => update({ aiRelayUrl: v })} />
        </Row>
      </Group>
    </>
  );
}

function Shortcuts() {
  const { settings: s, update } = useSettings();
  return (
    <Group footer="Click a shortcut, then press the new keys. Backspace clears it, Esc cancels. Hiding parks the island completely. To bring it back, press the shortcut again or open Islander from the Start menu.">
      <Row label="Search or Ask">
        <HotkeyInput value={s.aiHotkey} onChange={(v) => update({ aiHotkey: v })} />
      </Row>
      <Row label="Hide or show the island">
        <HotkeyInput value={s.hideHotkey} onChange={(v) => update({ hideHotkey: v })} />
      </Row>
    </Group>
  );
}

/** Islander Media Bridge: store buttons, or "Connected" once a browser's extension is talking to the app. */
function ExtensionGroup() {
  const [on, setOn] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const poll = () => connectedBrowsers().then((b) => alive && setOn(b));
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const chromium = on.filter((b) => b !== "firefox");
  return (
    <Group
      title="Browser extension"
      footer="Islander Media Bridge shows what's playing in your browser tabs, with live streams and downloads. Spotify and other Windows apps show up without it. Edge asks once to allow extensions from the Chrome Web Store."
    >
      <Row label="Chrome, Edge, Brave and Opera" hint={chromium.length ? `Showing tabs from ${chromium.map((b) => browserName(b as Browser)).join(", ")}` : "From the Chrome Web Store"}>
        {chromium.length ? <span className="sp-badge ok">Connected</span> : <button className="sp-btn" onClick={() => send("launch", { target: STORE.chrome })}>Add to Chrome</button>}
      </Row>
      <Row label="Firefox" hint={on.includes("firefox") ? "Showing tabs from Firefox" : "From Firefox Add-ons"}>
        {on.includes("firefox") ? <span className="sp-badge ok">Connected</span> : <button className="sp-btn" onClick={() => send("launch", { target: STORE.firefox })}>Add to Firefox</button>}
      </Row>
    </Group>
  );
}

function About() {
  const { reset } = useSettings();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3500);
    return () => clearTimeout(t);
  }, [confirm]);
  return (
    <>
      <div className="sp-about">
        <div className="sp-appicon lg">
          <span />
        </div>
        <div className="sp-about-name">Islander</div>
        <div className="sp-about-ver">Version {APP_VERSION}</div>
        <div className="sp-about-tag">A Dynamic Island for Windows</div>
        <div className="sp-about-by">by aayus</div>
      </div>
      <SoftwareUpdate />
      <ExtensionGroup />
      <Group title="Open source" footer="Islander is free software under the GNU General Public License v3.0 or later: you can read, change and share it, as long as shared versions stay open too.">
        <Row label="Source code" hint="github.com/aayus7/Islander">
          <button className="sp-btn" onClick={() => send("launch", { target: "https://github.com/aayus7/Islander" })}>View on GitHub</button>
        </Row>
      </Group>
      <Group title="Made by" footer="Islander is free and made by one person. If it makes your desktop better, a coffee on Ko-fi helps keep it going.">
        <Row label="aayus" hint="Designed and built Islander: every pixel, animation and line of code">
          <button className="sp-btn kofi" onClick={() => send("launch", { target: "https://ko-fi.com/aayus7" })}>Support on Ko-fi</button>
        </Row>
      </Group>
      <Group title="Credits">
        <Row label="AirPods & Beats animations" hint="From AirPodsDesktop by SpriteOvO, licensed GPL-3.0 (github.com/SpriteOvO/AirPodsDesktop)">
          <span />
        </Row>
        <Row label="Nearby sharing" hint="Works with LocalSend (localsend.org) by implementing its open protocol; LocalSend is Apache-2.0">
          <span />
        </Row>
        <Row label="Inter typeface" hint="By Rasmus Andersson and the Inter Project Authors, SIL Open Font License 1.1">
          <span />
        </Row>
        <Row label="Weather data" hint="Open-Meteo (open-meteo.com), CC BY 4.0">
          <span />
        </Row>
        <Row label="Movie & series posters" hint="Cinemeta and MetaHub, Stremio's open metadata services">
          <span />
        </Row>
      </Group>
      <Group>
        <Row label="Reset all settings" hint="Puts every option back to how it was when Islander was installed">
          <button className={`sp-btn danger ${confirm ? "armed" : ""}`} onClick={() => (confirm ? (reset(), setConfirm(false)) : setConfirm(true))}>
            {confirm ? "Click to Confirm" : "Reset…"}
          </button>
        </Row>
      </Group>
    </>
  );
}

/* ---------- building blocks ---------- */

function Ico({ d, solid, fillHalf }: { d: string; round?: boolean; solid?: boolean; fillHalf?: boolean }) {
  if (fillHalf)
    return (
      <svg width="15" height="15" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="#fff" strokeWidth="2" />
        <path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="#fff" />
      </svg>
    );
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill={solid ? "#fff" : "none"} stroke={solid ? "none" : "#fff"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  return (
    <section className="sp-group">
      {title && <div className="sp-title">{title}</div>}
      <div className="sp-card">{children}</div>
      {footer && <div className="sp-footer">{footer}</div>}
    </section>
  );
}

function Row({ label, value, hint, stack, icon, children }: { label: string; value?: string; hint?: string; stack?: boolean; icon?: ReactNode; children: ReactNode }) {
  const q = useContext(QueryCtx);
  if (q && !`${label} ${hint ?? ""}`.toLowerCase().includes(q)) return null;
  return (
    <div className={`sp-row ${stack ? "stack" : ""}`}>
      {stack ? (
        <>
          <div className="sp-stack-head">
            <span className="sp-label-text">{label}</span>
            {value && <span className="sp-value">{value}</span>}
          </div>
          {hint && <span className="sp-hint">{hint}</span>}
          <div className="sp-control">{children}</div>
        </>
      ) : (
        <>
          {icon}
          <div className="sp-label">
            <span className="sp-label-text">{label}</span>
            {hint && <span className="sp-hint">{hint}</span>}
          </div>
          <div className="sp-control">
            {value && <span className="sp-value">{value}</span>}
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function Switch({ on, onChange, disabled }: { on: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return (
    <button className={`sp-switch ${on ? "on" : ""}`} role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <motion.span layout transition={{ type: "spring", stiffness: 700, damping: 38 }} />
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange, compact }: { value: T; options: [T, string][]; onChange(v: T): void; compact?: boolean }) {
  const i = Math.max(0, options.findIndex(([v]) => v === value));
  return (
    <div className={`sp-seg ${compact ? "compact" : ""}`} style={{ ["--n" as string]: options.length, ["--i" as string]: i }}>
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

/** A native-feeling dropdown: our own popover menu instead of the browser's <select>. */
function Select({ value, options, onChange }: { value: string; options: [string, string][]; onChange(v: string): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const current = options.find(([v]) => v === value)?.[1] ?? options[0]?.[1];
  return (
    <div className="sp-select" ref={ref}>
      <button className="sp-select-btn" onClick={() => setOpen((o) => !o)}>
        <span>{current}</span>
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 5l3-3 3 3M2 9l3 3 3-3" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="sp-menu"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 600, damping: 38 } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
          >
            {options.map(([v, label]) => (
              <button
                key={v}
                className={`sp-menu-item ${v === value ? "on" : ""}`}
                onClick={() => {
                  onChange(v);
                  setOpen(false);
                }}
              >
                <span className="sp-check">{v === value ? "✓" : ""}</span>
                {label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Text field that saves when you leave it (or press Enter), not on every keystroke. */
function TextInput({ value, placeholder, onChange, type = "text", align }: { value: string; placeholder?: string; onChange(v: string): void; type?: string; align?: "right" }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() !== value && onChange(v.trim());
  return (
    <input
      className={`sp-text ${align === "right" ? "right" : ""}`}
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
    <div className="sp-secret">
      <TextInput {...props} type={show ? "text" : "password"} />
      <button className="sp-btn" onClick={() => setShow((x) => !x)}>
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
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if (e.key === "Backspace" || e.key === "Delete") {
        onChange("");
        return setRecording(false);
      }
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; // wait for the real key
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
      if (!mods.length) return; // a global hotkey needs at least one modifier
      const code = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : (KEY_NAMES[e.key] ?? e.code);
      onChange([...mods, code].join("+"));
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);
  const keys = useMemo(() => (value ? value.split("+") : []), [value]);

  return (
    <button className={`sp-hotkey ${recording ? "rec" : ""}`} onClick={() => setRecording((r) => !r)}>
      {recording ? (
        <span className="sp-hotkey-rec">Press keys…</span>
      ) : keys.length ? (
        keys.map((k, i) => (
          <kbd key={i}>{k === "Super" ? "Win" : k}</kbd>
        ))
      ) : (
        <span className="sp-hotkey-none">Not set</span>
      )}
    </button>
  );
}

/** Settings → About → Software Update: checks in the background on its own; this shows
 *  where it's at and lets you check now or install a downloaded update. */
function SoftwareUpdate() {
  const [status, setStatus] = useState("");
  useEffect(() => {
    invoke<string>("update_status").then(setStatus).catch(() => setStatus("dev"));
    return on<string>("update://status", setStatus);
  }, []);
  const [kind, ver] = status.split(":");
  const text =
    kind === "dev"
      ? "Updates are switched off in development builds."
      : kind === "checking"
        ? "Checking for updates…"
        : kind === "downloading"
          ? `Downloading Islander ${ver}…`
          : kind === "ready"
            ? `Islander ${ver} is ready to install.`
            : kind === "installing"
              ? "Installing…"
              : kind === "error"
                ? "Couldn't check for updates. Check your internet connection."
                : kind === "latest"
                  ? `Islander ${APP_VERSION} is up to date.`
                  : "Islander checks for updates automatically.";
  const busy = kind === "checking" || kind === "downloading" || kind === "installing";
  return (
    <Group title="Software update" footer="New versions download in the background and install when you click Restart to Update, or the banner in the island.">
      <Row label={kind === "ready" ? "Update available" : "Automatic updates"} hint={text}>
        {kind === "ready" ? (
          <button className="sp-btn primary" onClick={() => send("update_install")}>
            Restart to Update
          </button>
        ) : (
          <button className="sp-btn" disabled={busy || kind === "dev"} onClick={() => invoke<string>("update_check").then(setStatus).catch(() => setStatus("error"))}>
            {busy ? "Checking…" : "Check for Updates"}
          </button>
        )}
      </Row>
    </Group>
  );
}

/** A little screen with the twelve places the island can dock; the current one glows. */
function DockPicker() {
  const { settings: s, update } = useSettings();
  const q = useContext(QueryCtx);
  if (q && !"position where island lives move dock edge left right top bottom".includes(q)) return null;
  const spots: { dock: Dock; along: DockAlong; label: string }[] = [];
  const names = { top: "Top", bottom: "Bottom", left: "Left", right: "Right" } as const;
  const ends = { start: ["left", "top"], center: ["centre", "middle"], end: ["right", "bottom"] } as const;
  (["top", "bottom", "left", "right"] as Dock[]).forEach((dock) =>
    (["start", "center", "end"] as DockAlong[]).forEach((along) =>
      spots.push({ dock, along, label: `${names[dock]}, ${ends[along][dock === "top" || dock === "bottom" ? 0 : 1]}` }),
    ),
  );
  const W = 260;
  const H = 150;
  const pos = (d: Dock, a: DockAlong) => {
    const horiz = d === "top" || d === "bottom";
    const w = horiz ? 38 : 11;
    const h = horiz ? 11 : 38;
    const span = horiz ? W : H;
    const len = horiz ? w : h;
    const at = a === "start" ? 10 : a === "end" ? span - 10 - len : (span - len) / 2;
    if (d === "top") return { left: at, top: 5, width: w, height: h };
    if (d === "bottom") return { left: at, top: H - 5 - h, width: w, height: h };
    if (d === "left") return { left: 5, top: at, width: w, height: h };
    return { left: W - 5 - w, top: at, width: w, height: h };
  };
  return (
    <div className="sp-row sp-dock-row">
      <div className="sp-dock-screen" style={{ width: W, height: H }}>
        {spots.map((sp) => {
          const on = s.dock === sp.dock && s.dockAlong === sp.along;
          return (
            <button
              key={sp.label}
              title={sp.label}
              className={`sp-dock-spot ${on ? "on" : ""}`}
              style={pos(sp.dock, sp.along)}
              onClick={() => update({ dock: sp.dock, dockAlong: sp.along, offsetX: 0, offsetY: 0, moveTipShown: true })}
            />
          );
        })}
      </div>
      <div className="sp-dock-side">
        <div className="sp-label-text">{spots.find((x) => x.dock === s.dock && x.along === s.dockAlong)?.label ?? "Top, centre"}</div>
        <button className="sp-btn" onClick={() => send("island_move_start", { click: true })}>
          Move Island…
        </button>
        <span className="sp-hint">Then click where it should go. Esc cancels.</span>
      </div>
    </div>
  );
}
