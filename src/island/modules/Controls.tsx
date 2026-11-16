// Controls: Control Center-style toggles (Focus/DND, Mute, Appearance, Screenshot,
// Lock, Sleep) and a launcher for pinned apps, folders and URLs.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { call, send } from "../../lib/native";
import { persistent, uid, useStore } from "../../lib/persist";
import { useSettings } from "../../lib/settings";
import { keyboardProps } from "./Notes";
import { FileBadge } from "./Shelf";
import { Glyph } from "./ui";

interface Pin {
  id: string;
  target: string; // path or URL
  name: string;
  icon: string | null;
  kind: "app" | "folder" | "file" | "url";
}

const pinsStore = persistent<Pin[]>("launcher", []);

export function ControlsPanel({ width, height }: { width: number; height: number }) {
  const { settings, update } = useSettings();
  const [sys, setSys] = useState({ muted: false, dark: true });
  useEffect(() => {
    call<{ muted: boolean; dark: boolean }>("sys_state", undefined, { muted: false, dark: true }).then(setSys).catch(() => {});
  }, []);

  // Dropping files/apps here pins them instead of shelving them.
  useEffect(() => {
    const onDrop = (e: Event) => {
      e.preventDefault();
      const paths = (e as CustomEvent<string[]>).detail;
      paths.forEach((p) => addPin(p));
    };
    window.addEventListener("island:drop", onDrop);
    return () => window.removeEventListener("island:drop", onDrop);
  }, []);

  return (
    <div className="mod" style={{ width, height }}>
      <div className="cc-grid">
        <Toggle label="Silence" on={settings.dnd} tint="#5e5ce6" onClick={() => update({ dnd: !settings.dnd })} icon={<MoonIcon />} />
        <Toggle
          label={sys.muted ? "Unmute" : "Mute"}
          on={sys.muted}
          tint="#ff453a"
          onClick={() => call<boolean>("sys_mute_toggle", undefined, !sys.muted).then((muted) => setSys((s) => ({ ...s, muted })))}
          icon={<MuteIcon muted={sys.muted} />}
        />
        <Toggle
          label={sys.dark ? "Dark" : "Light"}
          on={sys.dark}
          tint="#fff"
          dark
          onClick={() => call<boolean>("sys_theme_toggle", undefined, !sys.dark).then((dark) => setSys((s) => ({ ...s, dark })))}
          icon={<AppearanceIcon />}
        />
        <Toggle label="Screenshot" onClick={() => send("sys_screenshot")} icon={<ScreenshotIcon />} />
        <Toggle label="Lock" onClick={() => send("sys_lock")} icon={<LockIcon />} />
        <Toggle label="Sleep" onClick={() => send("sys_sleep")} icon={<SleepIcon />} />
      </div>
      <Launcher />
    </div>
  );
}

function Toggle({ label, on, tint, dark, onClick, icon }: { label: string; on?: boolean; tint?: string; dark?: boolean; onClick(): void; icon: React.ReactNode }) {
  return (
    <div className="cc-cell">
      <motion.button
        className="cc-btn"
        title={label}
        initial={false}
        animate={{ backgroundColor: on && tint ? tint : "rgba(118,118,128,0.28)", color: on && dark ? "#000" : "#fff" }}
        whileTap={{ scale: 0.88 }}
        transition={{ duration: 0.22 }}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {icon}
      </motion.button>
      <span className="cc-label">{label}</span>
    </div>
  );
}

/* ---------- launcher ---------- */

function kindOf(target: string): Pin["kind"] {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return "url";
  if (/\.(exe|lnk|appref-ms|url)$/i.test(target)) return "app";
  if (!/\.[a-z0-9]{1,6}$/i.test(target)) return "folder";
  return "file";
}

function nameOf(target: string) {
  if (kindOf(target) === "url") {
    try {
      return new URL(target).hostname.replace(/^www\./, "");
    } catch {
      return target;
    }
  }
  const base = target.split(/[\\/]/).filter(Boolean).pop() ?? target;
  return base.replace(/\.(exe|lnk|appref-ms|url)$/i, "");
}

async function addPin(raw: string) {
  let target = raw.trim();
  if (!target) return;
  if (!/[\\/]/.test(target) && /\.[a-z]{2,}/i.test(target) && !/^[a-z]+:\/\//i.test(target)) target = `https://${target}`;
  const kind = kindOf(target);
  let icon: string | null = null;
  if (kind === "url") {
    try {
      icon = `https://www.google.com/s2/favicons?sz=64&domain=${new URL(target).hostname}`;
    } catch {
      /* not a URL after all */
    }
  } else {
    icon = await call<string | null>("file_icon", { path: target }, null).catch(() => null);
  }
  pinsStore.set((ps) => (ps.some((p) => p.target === target) ? ps : [...ps, { id: uid(), target, name: nameOf(target), icon, kind }].slice(0, 12)));
}

function Launcher() {
  const pins = useStore(pinsStore);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <div className="launcher">
      <div className="launcher-head">
        <span className="mod-title" style={{ fontSize: 13 }}>
          Pinned
        </span>
        <span className="dim" style={{ fontSize: 11.5 }}>
          Drop apps or folders here
        </span>
      </div>
      <div className="launcher-row">
        <AnimatePresence initial={false}>
          {pins.map((p) => (
            <motion.div
              key={p.id}
              layout
              className="app"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.15 } }}
              transition={{ type: "spring", stiffness: 420, damping: 28 }}
              title={p.target}
            >
              <motion.button
                className="app-icon"
                whileTap={{ scale: 0.86 }}
                onClick={(e) => {
                  e.stopPropagation();
                  send("launch", { target: p.target });
                }}
              >
                {p.icon ? (
                  <img src={p.icon} alt="" draggable={false} />
                ) : p.kind === "folder" ? (
                  <span style={{ color: "#64d2ff" }}>
                    <Glyph.folder size={26} />
                  </span>
                ) : (
                  <FileBadge ext={p.target.split(".").pop() ?? ""} />
                )}
              </motion.button>
              <button
                className="app-remove"
                title="Unpin"
                onClick={(e) => {
                  e.stopPropagation();
                  pinsStore.set((ps) => ps.filter((x) => x.id !== p.id));
                }}
              >
                <Glyph.x size={8} />
              </button>
              <span className="app-name">{p.name}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        {adding ? (
          <motion.input
            className="pin-input"
            autoFocus
            initial={{ opacity: 0, width: 44 }}
            animate={{ opacity: 1, width: 170 }}
            placeholder="URL or path, then Enter"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                addPin(draft);
                setDraft("");
                setAdding(false);
              }
              if (e.key === "Escape") setAdding(false);
            }}
            {...keyboardProps()}
            onBlur={() => {
              setAdding(false);
              keyboardProps().onBlur();
            }}
          />
        ) : (
          pins.length < 12 && (
            <div className="app">
              <motion.button
                className="app-icon add"
                whileTap={{ scale: 0.86 }}
                title="Pin a URL or path"
                onClick={(e) => {
                  e.stopPropagation();
                  setAdding(true);
                }}
              >
                <Glyph.plus size={18} />
              </motion.button>
              <span className="app-name dim">Add</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/* ---------- glyphs ---------- */

const Svg = ({ children, fill }: { children: React.ReactNode; fill?: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const MoonIcon = () => (
  <Svg fill>
    <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z" />
  </Svg>
);
const MuteIcon = ({ muted }: { muted: boolean }) => (
  <Svg>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor" />
    {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <path d="M15.5 9a4 4 0 0 1 0 6M18.2 6.5a7.5 7.5 0 0 1 0 11" />}
  </Svg>
);
const AppearanceIcon = () => (
  <Svg>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
  </Svg>
);
const ScreenshotIcon = () => (
  <Svg>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
const LockIcon = () => (
  <Svg>
    <rect x="5" y="10.5" width="14" height="10" rx="2.4" fill="currentColor" stroke="none" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Svg>
);
const SleepIcon = () => (
  <Svg>
    <path d="M17.5 14.2A6.6 6.6 0 0 1 9.8 6.5a6.6 6.6 0 1 0 7.7 7.7z" fill="currentColor" stroke="none" />
    <path d="M15 3.5h4l-4 4.5h4" strokeWidth="1.8" />
  </Svg>
);
