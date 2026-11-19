// Controls: Windows Quick Settings, built like iOS Control Center.
//
//  ┌ (Wi-Fi) Wi-Fi ───── › ┐ ┌──┐ ┌──┐
//  │         BELL508       │ │  │ │  │   tall iOS sliders:
//  ├ (BT)  Bluetooth ──── › ┤ │██│ │██│   brightness, volume
//  └         Jet           ┘ └☀─┘ └🔊┘
//   ✈  ☾  ◐  ⌗  🔒  ☾z  ▦                 round toggles
//
// Tiles: the icon toggles the radio, the rest opens its page (iOS Settings-style
// grouped lists). Everything is event-driven from Windows, so it changes the
// instant Windows' own Quick Settings would.
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { cancelCountdown, startRecording, stopRecording, useScreenRec } from "../../lib/screenrec";
import { RecordGlyph } from "./ScreenRec";
import { useCallback, useEffect, useRef, useState } from "react";
import { call, on, send } from "../../lib/native";
import { persistent, uid, useStore } from "../../lib/persist";
import { useSettings } from "../../lib/settings";
import { BatteryGlyph, type BtDevice, DeviceIcon, modelOf, subtitleOf } from "./Devices";
import { keyboardProps } from "./Notes";
import { FileBadge } from "./Shelf";
import { Glyph } from "./ui";
import { AppearanceIcon, BtIcon, GridIcon, LockIcon, MoonIcon, PlaneIcon, ScreenshotIcon, SleepIcon, WifiIcon } from "./ccIcons";

interface Pin {
  id: string;
  target: string; // path or URL
  name: string;
  icon: string | null;
  kind: "app" | "folder" | "file" | "url";
}

const pinsStore = persistent<Pin[]>("launcher", []);

type Page = "main" | "wifi" | "bt" | "pins";
let pinsOpen = false;
/** Is the Pinned (launcher) page showing? File drops pin there instead of shelving. */
export const pinsPageOpen = () => pinsOpen;
/** How much taller the island gets on a sub-page (room for a list). */
export const CONTROLS_PAGE_EXTRA = 74;

const BLUE = "#0a84ff";
const ORANGE = "#ff9f0a";
const SPRING = { type: "spring", stiffness: 520, damping: 38 } as const;

interface WifiNet {
  ssid: string;
  bars: number;
  secure: boolean;
  connected: boolean;
  saved: boolean;
}
interface WifiState {
  available: boolean;
  on: boolean;
  connected: string | null;
  networks: WifiNet[];
  error: string | null;
}
interface BtState {
  available: boolean;
  on: boolean;
  devices: BtDevice[];
}

// Browser preview data (no backend there).
const MOCK_WIFI: WifiState = {
  available: true,
  on: true,
  connected: "BELL508",
  networks: [
    { ssid: "BELL508", bars: 4, secure: true, connected: true, saved: true },
    { ssid: "Home-5G", bars: 3, secure: true, connected: false, saved: false },
    { ssid: "Starbucks WiFi", bars: 2, secure: false, connected: false, saved: false },
    { ssid: "TP-Link_7C21", bars: 1, secure: true, connected: false, saved: false },
  ],
  error: null,
};
const MOCK_BT: BtState = {
  available: true,
  on: true,
  devices: [
    { id: "1", name: "Jet", connected: true, kind: "headphones", battery: 80, audio: true },
    { id: "2", name: "Aayush's AirPods Pro", connected: false, kind: "earbuds", battery: null, audio: true },
    { id: "3", name: "AirPods Max", connected: false, kind: "headphones", battery: null, audio: true },
    { id: "4", name: "MX Master 3S", connected: true, kind: "mouse", battery: 55, audio: false },
  ],
};

/* ---------------- live state (shared, event-driven) ---------------- */

// Module-level so the tab opens instantly with the right state, and every
// Windows event lands even while the tab is closed.
function liveStore<T>(event: string, load: () => Promise<T>) {
  let value: T | null = null;
  const subs = new Set<(v: T) => void>();
  let started = false;
  const set = (v: T) => {
    value = v;
    subs.forEach((f) => f(v));
  };
  const start = () => {
    if (started) return;
    started = true;
    on<T>(event, set);
    load().then(set).catch(() => {});
  };
  return {
    get: () => value,
    set,
    refresh: () => load().then(set).catch(() => {}),
    use(): T | null {
      start();
      const [v, setV] = useState<T | null>(value);
      useEffect(() => {
        subs.add(setV);
        setV(value);
        return () => void subs.delete(setV);
      }, []);
      return v;
    },
  };
}

const wifiStore = liveStore<WifiState>("wifi://state", () => call<WifiState>("wifi_state", { scan: false }, MOCK_WIFI));
const btStore = liveStore<BtState>("bt://state", () => call<BtState>("bt_state", undefined, MOCK_BT));
const airplaneStore = liveStore<boolean>("airplane://state", () => call<boolean>("airplane_state", undefined, false));

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export function ControlsPanel({ width, height, onExtraHeight, initialPage = "main" }: { width: number; height: number; onExtraHeight?(px: number): void; initialPage?: Page }) {
  const [page, setPage] = useState<Page>(initialPage);
  const wifi = wifiStore.use();
  const bt = btStore.use();

  useEffect(() => {
    onExtraHeight?.(page === "main" ? 0 : CONTROLS_PAGE_EXTRA);
  }, [page, onExtraHeight]);
  useEffect(() => {
    pinsOpen = page === "pins";
    return () => {
      pinsOpen = false;
    };
  }, [page]);
  useEffect(() => () => onExtraHeight?.(0), [onExtraHeight]);

  // Dropping files/apps here pins them instead of shelving them.
  useEffect(() => {
    const onDrop = (e: Event) => {
      if (!pinsOpen) return; // everywhere else, drops go to the Shelf
      e.preventDefault();
      const paths = (e as CustomEvent<string[]>).detail;
      paths.forEach((p) => addPin(p));
      setPage("pins");
    };
    window.addEventListener("island:drop", onDrop);
    return () => window.removeEventListener("island:drop", onDrop);
  }, []);

  // Optimistic: the switch moves now; Windows' event confirms a moment later.
  const toggleWifi = () => {
    if (!wifi) return;
    const next = !wifi.on;
    wifiStore.set({ ...wifi, on: next, connected: next ? wifi.connected : null, networks: next ? wifi.networks : [] });
    call("wifi_set", { on: next }).catch(() => wifiStore.refresh());
  };
  const [btErr, setBtErr] = useState<string | null>(null);
  const toggleBt = () => {
    if (!bt) return;
    // Windows isn't exposing the radio (adapter switched off in Windows, driver still
    // starting…): show the Bluetooth page, which explains and links to Windows' settings.
    if (!bt.available) return setPage("bt");
    const next = !bt.on;
    setBtErr(null);
    btStore.set({ ...bt, on: next, devices: bt.devices.map((d) => ({ ...d, connected: next && d.connected })) });
    call("bt_set", { on: next }).catch((e) => {
      btStore.refresh();
      setBtErr(String(e));
      setPage("bt");
    });
  };

  const back = () => setPage("main");
  const forward = page !== "main";

  return (
    <div
      className="mod cc"
      style={{ width, height: height + (page === "main" ? 0 : CONTROLS_PAGE_EXTRA) }}
      // Inside Wi-Fi / Bluetooth / Pinned the wheel only scrolls — it never flips tabs
      // (even when the list is short enough not to scroll). Back returns to the tabs.
      onWheel={page === "main" ? undefined : (e) => e.stopPropagation()}
    >
      <AnimatePresence mode="popLayout" initial={false} custom={forward}>
        <motion.div
          key={page}
          className="cc-page"
          custom={forward}
          variants={{
            // iOS push: the new page slides in from the right, the old one drifts left.
            in: (f: boolean) => ({ x: f ? 48 : -48, opacity: 0, filter: "blur(6px)" }),
            show: { x: 0, opacity: 1, filter: "blur(0px)" },
            out: (f: boolean) => ({ x: f ? -48 : 48, opacity: 0, filter: "blur(6px)" }),
          }}
          initial="in"
          animate="show"
          exit="out"
          transition={{ type: "spring", stiffness: 380, damping: 34, opacity: { duration: 0.2 }, filter: { duration: 0.22 } }}
        >
          {page === "main" && <Main wifi={wifi} bt={bt} onWifi={toggleWifi} onBt={toggleBt} open={setPage} />}
          {page === "wifi" && <WifiPage st={wifi} onBack={back} onToggle={toggleWifi} />}
          {page === "bt" && <BtPage st={bt} onBack={back} onToggle={toggleBt} toggleErr={btErr} />}
          {page === "pins" && (
            <>
              <PageHead title="Pinned" onBack={back} />
              <Launcher />
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ---------------- main page ---------------- */

function Main({ wifi, bt, onWifi, onBt, open }: { wifi: WifiState | null; bt: BtState | null; onWifi(): void; onBt(): void; open(p: Page): void }) {
  const { settings, update } = useSettings();
  const [sys, setSys] = useState({ muted: false, dark: true });
  const airplane = airplaneStore.use() ?? false;
  useEffect(() => {
    call<{ muted: boolean; dark: boolean }>("sys_state", undefined, { muted: false, dark: true }).then(setSys).catch(() => {});
  }, []);

  const wifiBars = wifi?.networks.find((n) => n.connected)?.bars ?? 4;
  const wifiSub = !wifi ? " " : !wifi.available ? "Unavailable" : !wifi.on ? "Off" : (wifi.connected ?? "Not Connected");
  const btConnected = bt?.devices.filter((d) => d.connected) ?? [];
  const btSub = !bt ? " " : !bt.available ? "Unavailable" : !bt.on ? "Off" : btConnected.length === 1 ? btConnected[0].name : btConnected.length > 1 ? `${btConnected.length} Devices` : "Not Connected";

  return (
    <>
      <div className="cc-top">
        <div className="cc-tiles">
          <Tile label="Wi-Fi" sub={wifiSub} on={!!wifi?.on} disabled={wifi ? !wifi.available : false} icon={(p) => <WifiIcon play={p} bars={wifi?.connected ? wifiBars : 4} />} onToggle={onWifi} onOpen={() => open("wifi")} />
          <Tile label="Bluetooth" sub={btSub} on={!!bt?.on} icon={(p) => <BtIcon play={p} />} onToggle={onBt} onOpen={() => open("bt")} />
        </div>
        <BrightnessSlider />
        <VolumeSlider muted={sys.muted} onMuted={(muted) => setSys((s) => ({ ...s, muted }))} />
      </div>
      <div className="cc-row">
        <Round
          label="Airplane Mode"
          on={airplane}
          tint={ORANGE}
          icon={(p) => <PlaneIcon play={p} />}
          onClick={() => {
            const next = !airplane;
            airplaneStore.set(next);
            call("airplane_set", { on: next }).catch(() => airplaneStore.refresh());
          }}
        />
        <Round label="Do Not Disturb" on={settings.dnd} tint="#5e5ce6" onClick={() => update({ dnd: !settings.dnd })} icon={(p) => <MoonIcon play={p} />} />
        <Round
          label={sys.dark ? "Dark Mode" : "Light Mode"}
          on={sys.dark}
          tint="#fff"
          dark
          onClick={() => {
            setSys((s) => ({ ...s, dark: !s.dark }));
            call<boolean>("sys_theme_toggle", undefined, !sys.dark).then((dark) => setSys((s) => ({ ...s, dark })));
          }}
          icon={(p) => <AppearanceIcon play={p} dark={sys.dark} />}
        />
        <Round label="Screenshot" onClick={() => send("sys_screenshot")} icon={(p) => <ScreenshotIcon play={p} />} />
        <RecordRound />
        <Round label="Lock" onClick={() => send("sys_lock")} icon={(p) => <LockIcon play={p} />} />
        <Round label="Sleep" onClick={() => send("sys_sleep")} icon={(p) => <SleepIcon play={p} />} />
        <Round label="Pinned apps" onClick={() => open("pins")} icon={(p) => <GridIcon play={p} />} />
      </div>
    </>
  );
}

/**
 * Screen Recording, like iOS Control Center: tap for a 3-2-1 countdown (shown on the button
 * and in the island), then it records; tap again to stop. Turns red while recording.
 */
function RecordRound() {
  const r = useScreenRec();
  const live = r.phase === "recording" || r.phase === "paused" || r.phase === "starting" || r.phase === "saving";
  const counting = r.phase === "countdown";
  return (
    <motion.button
      className="cc-round"
      title={counting ? "Cancel" : live ? "Stop screen recording" : "Screen Recording"}
      initial={false}
      animate={{ backgroundColor: live || counting ? "rgba(255,59,48,1)" : "rgba(255,255,255,0.10)", color: "#fff" }}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.84 }}
      transition={{ duration: 0.22, scale: SPRING }}
      onClick={(e) => {
        stop(e);
        if (counting) cancelCountdown();
        else if (live) void stopRecording();
        else startRecording();
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {counting ? (
          <motion.span
            key={`n${r.count}`}
            style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}
            initial={{ opacity: 0, scale: 1.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
          >
            {r.count}
          </motion.span>
        ) : (
          <motion.span key="glyph" style={{ display: "flex" }} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}>
            <RecordGlyph size={18} dot={live ? "#fff" : "#ff3b30"} />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

/** Quick Settings tile: icon disc (toggles) + label/status (opens the page) + chevron. */
function Tile({ label, sub, on: isOn, disabled, icon, onToggle, onOpen }: { label: string; sub: string; on: boolean; disabled?: boolean; icon: (play: number) => React.ReactNode; onToggle(): void; onOpen(): void }) {
  const [play, setPlay] = useState(0);
  return (
    <motion.div
      className={`cc-tile ${disabled ? "disabled" : ""} ${isOn ? "on" : ""}`}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={SPRING}
      onClick={(e) => {
        stop(e);
        if (!disabled) onOpen();
      }}
    >
      <motion.button
        className="cc-tile-ic"
        title={isOn ? `Turn ${label} off` : `Turn ${label} on`}
        initial={false}
        animate={{
          backgroundColor: isOn ? BLUE : "rgba(255,255,255,0.12)",
          boxShadow: isOn ? "0 0 18px rgba(10,132,255,0.5), inset 0 1px 0 rgba(255,255,255,0.28)" : "0 0 0px rgba(10,132,255,0), inset 0 1px 0 rgba(255,255,255,0.06)",
        }}
        whileHover={{ scale: 1.07 }}
        whileTap={{ scale: 0.86 }}
        transition={{ duration: 0.22, scale: SPRING }}
        onClick={(e) => {
          stop(e);
          if (disabled) return;
          setPlay((p) => p + 1);
          onToggle();
        }}
      >
        {icon(play)}
      </motion.button>
      <div className="cc-tile-text">
        <span className="cc-tile-label">{label}</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={sub}
            className="cc-tile-sub"
            initial={{ opacity: 0, y: 6, filter: "blur(3px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -6, filter: "blur(3px)" }}
            transition={{ duration: 0.24, ease: [0.25, 0.1, 0.25, 1] }}
          >
            {sub}
          </motion.span>
        </AnimatePresence>
      </div>
      <span className="cc-chev">
        <Chevron />
      </span>
    </motion.div>
  );
}

function Round({ label, on: isOn, tint, dark, onClick, icon }: { label: string; on?: boolean; tint?: string; dark?: boolean; onClick(): void; icon: (play: number) => React.ReactNode }) {
  const [play, setPlay] = useState(0);
  return (
    <motion.button
      className={`cc-round ${isOn ? "on" : ""}`}
      title={label}
      initial={false}
      animate={{ backgroundColor: isOn && tint ? tint : "rgba(255,255,255,0.10)", color: isOn && dark ? "#000" : "#fff" }}
      whileHover={{ scale: 1.08 }}
      whileTap={{ scale: 0.84 }}
      transition={{ duration: 0.22, scale: SPRING }}
      onClick={(e) => {
        stop(e);
        setPlay((p) => p + 1);
        onClick();
      }}
    >
      {icon(play)}
    </motion.button>
  );
}

/* ---------------- iOS vertical sliders ---------------- */

/**
 * Control Center slider: a tall rounded module that fills with white from the
 * bottom. Drag anywhere (relative, like iOS — it doesn't jump to the pointer),
 * scroll to nudge; dragging past either end stretches it like rubber, and the
 * glyph turns dark once the fill reaches it.
 */
function VSlider({ value, onChange, onCommit, icon, disabled, title }: { value: number; onChange(v: number): void; onCommit?(v: number): void; icon: (v: number) => React.ReactNode; disabled?: boolean; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; v: number; h: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  // Jelly physics: `st` = how far it's stretched past an end (0..1, goes a little
  // negative while it wobbles back), `lean` = sideways pull, `press` = squeeze.
  const originY = useMotionValue(1); // stretch away from this end
  const st = useMotionValue(0);
  const lean = useMotionValue(0);
  const press = useMotionValue(0);
  // Less room above (the island's edge) than below, so it stretches up a bit less.
  const scaleY = useTransform([st, press, originY], ([s, p, o]: number[]) => (1 + s * (o === 1 ? 0.06 : 0.08)) * (1 + p * 0.02));
  const scaleX = useTransform([st, press], ([s, p]: number[]) => (1 - s * 0.045) * (1 + p * 0.03));
  const skewX = useTransform(lean, (l) => l * -0.2);
  const JELLY = { type: "spring", stiffness: 380, damping: 17 } as const;
  const pct = Math.min(1, Math.max(0, value));
  const covered = pct > 0.2; // the fill reaches the glyph
  const release = () => {
    animate(st, 0, { ...JELLY, velocity: st.getVelocity() });
    animate(lean, 0, { ...JELLY, velocity: lean.getVelocity() });
    animate(press, 0, { type: "spring", stiffness: 420, damping: 24 });
  };
  /** A little "boing" when the wheel pushes past an end. */
  const bump = (top: boolean) => {
    originY.set(top ? 1 : 0);
    animate(st, [st.get(), 0.22, 0], { duration: 0.5, times: [0, 0.25, 1], ease: ["easeOut", (t) => 1 - Math.cos(t * Math.PI * 2.5) * Math.exp(-t * 4.5)] });
  };
  return (
    <motion.div
      ref={ref}
      className={`cc-vslider ${disabled ? "disabled" : ""} ${dragging ? "drag" : ""}`}
      title={title}
      style={{ scaleY, scaleX, skewX, x: lean, originY, originX: 0.5 }}
      onClick={stop}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      data-no-lift="" onPointerDown={(e) => {
        stop(e);
        if (disabled || e.button !== 0) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointer */
        }
        const r = ref.current!.getBoundingClientRect();
        drag.current = { x: e.clientX, y: e.clientY, v: pct, h: r.height, w: r.width };
        setDragging(true);
        animate(press, 1, { type: "spring", stiffness: 520, damping: 26 });
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const raw = d.v + (d.y - e.clientY) / d.h;
        const over = raw > 1 ? raw - 1 : raw < 0 ? -raw : 0;
        if (over > 0) originY.set(raw > 1 ? 1 : 0);
        // Rubber-band resistance: easy at first, firmer the further you pull.
        st.set(1 - Math.exp(-over * 3.2));
        // Sideways tug, also with resistance.
        const dx = e.clientX - d.x;
        lean.set(Math.sign(dx) * 3 * (1 - Math.exp(-Math.abs(dx) / 70)));
        onChange(Math.min(1, Math.max(0, raw)));
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        setDragging(false);
        release();
        onCommit?.(pct);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        release();
      }}
      onWheel={(e) => {
        e.stopPropagation();
        if (disabled) return;
        const up = e.deltaY < 0;
        if ((up && pct >= 1) || (!up && pct <= 0)) {
          if (st.get() < 0.05) bump(up);
          return;
        }
        const v = Math.min(1, Math.max(0, pct + (up ? 0.04 : -0.04)));
        onChange(v);
        onCommit?.(v);
      }}
    >
      <motion.div className="cc-vfill" initial={false} animate={{ height: `${pct * 100}%` }} transition={dragging ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 38 }} />
      <AnimatePresence>
        {(dragging || hover) && !disabled && (
          <motion.span
            className="cc-vpct"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, color: pct > 0.84 ? "#1c1c1e" : "rgba(255,255,255,0.9)" }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.16 }}
          >
            {Math.round(pct * 100)}
          </motion.span>
        )}
      </AnimatePresence>
      <motion.span className="cc-vicon" initial={false} animate={{ color: covered ? "#1c1c1e" : "#ffffff" }} transition={{ duration: 0.15 }}>
        {icon(pct)}
      </motion.span>
    </motion.div>
  );
}

/** Sends at most one update per frame while dragging. */
function useThrottled(cmd: string, key: string) {
  const pending = useRef<number | null>(null);
  const raf = useRef(0);
  return (v: number) => {
    pending.current = v;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (pending.current != null) send(cmd, { [key]: pending.current });
    });
  };
}

let lastVolume = 0.5;
let lastBrightness: number | null = 0.8;

function VolumeSlider({ muted, onMuted }: { muted: boolean; onMuted(m: boolean): void }) {
  const [v, setV] = useState(lastVolume);
  const dragging = useRef(false);
  const push = useThrottled("volume_set", "level");
  useEffect(() => {
    call<{ level: number; muted: boolean }>("volume_get", undefined, { level: 0.62, muted: false })
      .then((r) => {
        lastVolume = r.level;
        setV(r.level);
        onMuted(r.muted);
      })
      .catch(() => {});
    // Keep in sync with the volume keys and Windows' own mixer.
    return on<{ kind: string; value: number; on: boolean }>("hud://show", (h) => {
      if (dragging.current) return;
      if (h.kind === "volume") setV((lastVolume = h.value));
      if (h.kind === "volume" || h.kind === "mute") onMuted(h.on);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shown = muted ? 0 : v;
  return (
    <VSlider
      value={shown}
      title={`Volume ${Math.round(shown * 100)}%`}
      icon={(x) => <SpeakerIcon level={x} />}
      onChange={(x) => {
        dragging.current = true;
        setV((lastVolume = x));
        if (muted && x > 0) onMuted(false);
        push(Math.round(x * 100) / 100);
      }}
      onCommit={(x) => {
        dragging.current = false;
        send("volume_set", { level: Math.round(x * 100) / 100 });
      }}
    />
  );
}

function BrightnessSlider() {
  const [v, setV] = useState<number | null>(lastBrightness);
  const push = useThrottled("brightness_set", "level");
  useEffect(() => {
    call<number | null>("brightness_get", undefined, 80)
      .then((b) => setV((lastBrightness = b == null ? null : b / 100)))
      .catch(() => setV(null));
  }, []);
  const supported = v != null;
  return (
    <VSlider
      value={supported ? v : 1}
      disabled={!supported}
      title={supported ? `Brightness ${Math.round(v * 100)}%` : "This display doesn't let Windows change its brightness"}
      icon={(x) => <SunIcon level={x} />}
      onChange={(x) => {
        setV((lastBrightness = x));
        push(Math.round(x * 100));
      }}
      onCommit={(x) => send("brightness_set", { level: Math.round(x * 100) })}
    />
  );
}

/* ---------------- sub-pages ---------------- */

function PageHead({ title, onBack, children }: { title: string; onBack(): void; children?: React.ReactNode }) {
  return (
    <div className="cc-head">
      <motion.button
        className="cc-back"
        title="Back"
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.86 }}
        transition={SPRING}
        onClick={(e) => {
          stop(e);
          onBack();
        }}
      >
        <Chevron left />
      </motion.button>
      <span className="cc-title">{title}</span>
      <div className="cc-head-right">{children}</div>
    </div>
  );
}

/** iOS switch: the knob stretches while pressed. */
function Switch({ on: isOn, onChange }: { on: boolean; onChange(): void }) {
  const [press, setPress] = useState(false);
  return (
    <motion.button
      className="ios-switch"
      initial={false}
      animate={{ backgroundColor: isOn ? "#30d158" : "rgba(120,120,128,0.36)" }}
      transition={{ duration: 0.22 }}
      data-no-lift="" onPointerDown={(e) => {
        stop(e);
        setPress(true);
      }}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      onClick={(e) => {
        stop(e);
        onChange();
      }}
    >
      <motion.span
        className="ios-switch-knob"
        initial={false}
        animate={{ left: isOn ? (press ? 14 : 19) : 2, width: press ? 26 : 21 }}
        transition={{ type: "spring", stiffness: 640, damping: 36 }}
      />
    </motion.button>
  );
}

/** iOS activity indicator. */
function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="cc-spin" width={size} height={size} viewBox="0 0 24 24">
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x="10.8" y="1.5" width="2.4" height="6.2" rx="1.2" fill="currentColor" opacity={0.18 + (i / 8) * 0.82} transform={`rotate(${i * 45} 12 12)`} />
      ))}
    </svg>
  );
}

/** Scrolling list that fades out at the bottom while there's more below. */
function ScrollList({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const check = () => {
    const el = ref.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  };
  useEffect(check);
  return (
    <div ref={ref} className={`cc-list ${more ? "fade" : ""}`} onScroll={check}>
      {children}
    </div>
  );
}

const Section = ({ title, children }: { title?: string; children: React.ReactNode }) => (
  <div className="cc-section">
    {title && <span className="cc-section-title">{title}</span>}
    <div className="cc-group">{children}</div>
  </div>
);

const Note = ({ children }: { children: React.ReactNode }) => (
  <motion.div className="cc-note" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
    {children}
  </motion.div>
);

type JoinState = { ssid: string; phase: "joining" | "password" | "wrong" | "failed" | "menu" } | null;

function WifiPage({ st, onBack, onToggle }: { st: WifiState | null; onBack(): void; onToggle(): void }) {
  const [join, setJoin] = useState<JoinState>(null);
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [scanning, setScanning] = useState(true);
  useEffect(() => {
    // The cached list shows right away; a fresh scan refines it.
    call<WifiState>("wifi_state", { scan: true }, MOCK_WIFI)
      .then(wifiStore.set)
      .catch(() => {})
      .finally(() => setScanning(false));
  }, []);

  const connect = useCallback(async (n: WifiNet, password: string | null) => {
    // A secured network Windows doesn't know yet: ask for the password first, like iOS.
    if (!password && n.secure && !n.saved) {
      setPw("");
      setJoin({ ssid: n.ssid, phase: "password" });
      return;
    }
    setJoin({ ssid: n.ssid, phase: "joining" });
    try {
      const r = await call<string>("wifi_connect", { ssid: n.ssid, password }, password === "wrong" ? "wrong_password" : "connected");
      if (r === "connected") {
        setJoin(null);
        setPw("");
        const cur = wifiStore.get();
        if (cur) wifiStore.set({ ...cur, connected: n.ssid, networks: cur.networks.map((x) => ({ ...x, connected: x.ssid === n.ssid, saved: x.saved || x.ssid === n.ssid })) });
      } else {
        if (r === "wrong_password") setPw("");
        setJoin({ ssid: n.ssid, phase: r === "needs_password" ? "password" : r === "wrong_password" ? "wrong" : "failed" });
      }
    } catch {
      setJoin({ ssid: n.ssid, phase: "failed" });
    }
  }, []);

  const nets = st?.networks ?? [];
  const current = nets.filter((n) => n.connected);
  const mine = nets.filter((n) => !n.connected && n.saved);
  const others = nets.filter((n) => !n.connected && !n.saved);

  const row = (n: WifiNet) => {
    const j = join?.ssid === n.ssid ? join : null;
    return (
      <motion.div key={n.ssid} layout="position" transition={SPRING} className="cc-row-wrap">
        <button
          className={`cc-item ${n.connected ? "current" : ""}`}
          onClick={(e) => {
            stop(e);
            if (j?.phase === "joining") return;
            if (n.connected) setJoin(j?.phase === "menu" ? null : { ssid: n.ssid, phase: "menu" });
            else if (j && j.phase !== "failed") setJoin(null);
            else connect(n, null);
          }}
        >
          <span className="cc-check">
            <AnimatePresence initial={false}>
              {n.connected && (
                <motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={SPRING} style={{ display: "flex" }}>
                  <Glyph.check size={14} />
                </motion.span>
              )}
            </AnimatePresence>
          </span>
          <span className="cc-item-name">{n.ssid}</span>
          {j?.phase === "joining" && <Spinner size={14} />}
          {n.secure && (
            <span className="cc-item-ic">
              <LockSmall />
            </span>
          )}
          <span className="cc-item-ic">
            <WifiGlyph bars={n.bars} size={16} />
          </span>
        </button>
        <AnimatePresence initial={false}>
          {j && j.phase !== "joining" && (
            <motion.div
              className="cc-expand"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 40, opacity: { duration: 0.16 } }}
            >
              {j.phase === "menu" ? (
                <div className="cc-expand-row">
                  <span className="cc-expand-note">Connected{n.secure ? " · Secured" : ""}</span>
                  <button
                    className="cc-pill danger"
                    onClick={(e) => {
                      stop(e);
                      setJoin(null);
                      const cur = wifiStore.get();
                      if (cur) wifiStore.set({ ...cur, connected: null, networks: cur.networks.map((x) => ({ ...x, connected: false })) });
                      call("wifi_disconnect").catch(() => wifiStore.refresh());
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              ) : j.phase === "failed" ? (
                <div className="cc-expand-row">
                  <span className="cc-expand-note">Couldn't join “{n.ssid}”</span>
                  <button className="cc-pill" onClick={(e) => (stop(e), connect(n, n.secure && pw ? pw : null))}>
                    Try Again
                  </button>
                </div>
              ) : (
                <form
                  className="cc-expand-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (pw.length >= 8) connect(n, pw);
                  }}
                >
                  <motion.div className="cc-input-wrap" animate={j.phase === "wrong" ? { x: [0, -7, 6, -4, 3, 0] } : { x: 0 }} transition={{ duration: 0.4 }}>
                    <input
                      className={`cc-input ${j.phase === "wrong" ? "bad" : ""}`}
                      type={show ? "text" : "password"}
                      autoFocus
                      spellCheck={false}
                      placeholder={j.phase === "wrong" ? "Incorrect password" : "Password"}
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      onClick={stop}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setJoin(null);
                      }}
                      {...keyboardProps()}
                    />
                    <button type="button" className="cc-eye" title={show ? "Hide password" : "Show password"} onClick={(e) => (stop(e), setShow((s) => !s))}>
                      <EyeIcon open={show} />
                    </button>
                  </motion.div>
                  <button type="submit" className="cc-pill blue" disabled={pw.length < 8} onClick={stop}>
                    Join
                  </button>
                </form>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  };

  return (
    <>
      <PageHead title="Wi-Fi" onBack={onBack}>
        {scanning && st?.on && <Spinner />}
        {st?.available && <Switch on={st.on} onChange={onToggle} />}
      </PageHead>
      <ScrollList>
        {!st ? null : !st.available ? (
          <Note>This PC doesn't have Wi-Fi.</Note>
        ) : !st.on ? (
          <Note>Wi-Fi is off. Turn it on to see networks.</Note>
        ) : st.error ? (
          <Note>
            {st.error}
            <button className="cc-link" onClick={(e) => (stop(e), send("launch", { target: "ms-settings:privacy-location" }))}>
              Open Location Settings
            </button>
          </Note>
        ) : (
          <>
            {current.length > 0 && <Section>{current.map(row)}</Section>}
            {mine.length > 0 && <Section title="My Networks">{mine.map(row)}</Section>}
            {others.length > 0 && <Section title={mine.length || current.length ? "Other Networks" : "Networks"}>{others.map(row)}</Section>}
            {!nets.length && !scanning && <Note>No networks found.</Note>}
          </>
        )}
        <button className="cc-link foot" onClick={(e) => (stop(e), send("launch", { target: "ms-settings:network-wifi" }))}>
          Wi-Fi Settings…
        </button>
      </ScrollList>
    </>
  );
}

type Busy = { id: string; connect: boolean; since: number } | null;

function BtPage({ st, onBack, onToggle, toggleErr }: { st: BtState | null; onBack(): void; onToggle(): void; toggleErr: string | null }) {
  const [busy, setBusy] = useState<Busy>(null);
  const [err, setErr] = useState<string | null>(null);

  // Done the moment Windows reports the state we asked for (or after 15 s).
  useEffect(() => {
    if (!busy) return;
    const d = st?.devices.find((x) => x.id === busy.id);
    if (d && d.connected === busy.connect) {
      setBusy(null);
      return;
    }
    const t = window.setTimeout(
      () => {
        setBusy(null);
        if (busy.connect) setErr("Couldn't connect. Make sure it's on and nearby.");
      },
      Math.max(0, 15000 - (Date.now() - busy.since)),
    );
    return () => clearTimeout(t);
  }, [busy, st]);

  const tap = async (d: BtDevice) => {
    if (busy) return;
    if (!d.audio) {
      send("launch", { target: "ms-settings:bluetooth" });
      return;
    }
    setErr(null);
    setBusy({ id: d.id, connect: !d.connected, since: Date.now() });
    try {
      await call("bt_connect", { name: d.name, connect: !d.connected });
    } catch (e) {
      setBusy(null);
      setErr(String(e));
    }
  };

  return (
    <>
      <PageHead title="Bluetooth" onBack={onBack}>
        {st?.available && <Switch on={st.on} onChange={onToggle} />}
      </PageHead>
      <ScrollList>
        {!st ? null : !st.available ? (
          <Note>
            Windows isn't showing Bluetooth right now. It may be switched off in Windows, or this PC may not have it.
            <button className="cc-pill-btn" onClick={(e) => (stop(e), send("launch", { target: "ms-settings:bluetooth" }))}>
              Open Bluetooth Settings
            </button>
          </Note>
        ) : !st.on ? (
          <Note>
            Bluetooth is off. Turn it on to use your headphones, mice and more.
            <button className="cc-pill-btn" onClick={(e) => (stop(e), onToggle())}>
              Turn On Bluetooth
            </button>
          </Note>
        ) : !st.devices.length ? (
          <Note>No paired devices yet. Pair one in Bluetooth Settings.</Note>
        ) : (
          <Section title="My Devices">
            {st.devices.map((d) => {
              const model = modelOf(d.name, d.kind);
              const b = busy?.id === d.id ? busy : null;
              const live = b ? b.connect : d.connected;
              const sub = b ? (b.connect ? "Connecting…" : "Disconnecting…") : d.connected ? "Connected" : subtitleOf(model, d.name);
              return (
                <motion.button key={d.id} layout="position" transition={SPRING} className="cc-item dev" onClick={(e) => (stop(e), tap(d))} title={d.audio ? (d.connected ? "Disconnect" : "Connect") : "Open Bluetooth settings"}>
                  <motion.span
                    className="cc-dev-ic"
                    initial={false}
                    animate={{ backgroundColor: live ? BLUE : "rgba(255,255,255,0.12)", boxShadow: live && !b ? "0 0 14px rgba(10,132,255,0.45)" : "0 0 0px rgba(10,132,255,0)" }}
                    transition={{ duration: 0.25 }}
                  >
                    <DeviceIcon model={model} size={20} />
                  </motion.span>
                  <span className="cc-dev-text">
                    <span className="cc-item-name">{d.name}</span>
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span key={sub} className={`cc-dev-sub ${d.connected && !b ? "on" : ""}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
                        {sub}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  {b ? (
                    <Spinner size={14} />
                  ) : (
                    d.connected &&
                    d.battery != null && (
                      <span className="cc-dev-bat">
                        {d.battery}%
                        <BatteryGlyph level={d.battery} color={d.battery <= 20 ? "#ff453a" : "#fff"} width={23} />
                      </span>
                    )
                  )}
                </motion.button>
              );
            })}
          </Section>
        )}
        {(err || toggleErr) && <div className="cc-note bad">{err || toggleErr}</div>}
        <button className="cc-link foot" onClick={(e) => (stop(e), send("launch", { target: "ms-settings:bluetooth" }))}>
          Bluetooth Settings…
        </button>
      </ScrollList>
    </>
  );
}

const EyeIcon = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
    {!open && <path d="M4 20L20 4" />}
  </svg>
);

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
      <span className="dim" style={{ fontSize: 12 }}>
        Drop apps, files or folders here, or add a URL.
      </span>
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

const WifiGlyph = ({ bars, size = 16 }: { bars: number; size?: number }) => {
  // 3 arcs + dot; arcs above the signal level are dimmed, like iOS.
  const lit = (n: number) => (bars === 0 || bars >= n ? 1 : 0.28);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M2.5 9.2a13.6 13.6 0 0 1 19 0" opacity={lit(4)} />
      <path d="M5.9 12.7a8.8 8.8 0 0 1 12.2 0" opacity={lit(3)} />
      <path d="M9.3 16.1a4 4 0 0 1 5.4 0" opacity={lit(2)} />
      <circle cx="12" cy="19.6" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
};
const Chevron = ({ left }: { left?: boolean }) => (
  <svg width="9" height="14" viewBox="0 0 9 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d={left ? "M7 1.5L1.8 7 7 12.5" : "M2 1.5L7.2 7 2 12.5"} />
  </svg>
);
const SpeakerIcon = ({ level }: { level: number }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 9.5v5h3.5L11.5 18.5v-13L7 9.5z" fill="currentColor" />
    {level <= 0.001 ? (
      <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
    ) : (
      <>
        <path d="M15 9a4 4 0 0 1 0 6" opacity={level > 0.02 ? 1 : 0.3} />
        <path d="M17.8 6.4a7.6 7.6 0 0 1 0 11.2" opacity={level > 0.45 ? 1 : 0.3} />
      </>
    )}
  </svg>
);
const SunIcon = ({ level = 1 }: { level?: number }) => (
  // Rays grow with the brightness, like iOS.
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round">
    <circle cx="12" cy="12" r={3.4 + level * 0.8} fill="currentColor" stroke="none" />
    <g style={{ transform: `scale(${0.82 + level * 0.18})`, transformOrigin: "12px 12px" }}>
      <path d="M12 2.5v1.8M12 19.7v1.8M2.5 12h1.8M19.7 12h1.8M5.3 5.3l1.3 1.3M17.4 17.4l1.3 1.3M5.3 18.7l1.3-1.3M17.4 6.6l1.3-1.3" />
    </g>
  </svg>
);
const LockSmall = () => (
  <svg width="11" height="13" viewBox="0 0 11 13" fill="currentColor">
    <rect x="0.5" y="5.5" width="10" height="7" rx="1.8" />
    <path d="M2.6 5.6V4a2.9 2.9 0 0 1 5.8 0v1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
