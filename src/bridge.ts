// One interface for the UI, two implementations:
//  - Tauri: real Windows data from the Rust backend
//  - Mock:  fake data so the UI runs in a normal browser for design work
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mock } from "./mock";
import { DEFAULT_SETTINGS, type AppSettings, type MonitorInfo } from "./settings-types";

export interface MediaSession {
  id: string; // AppUserModelId of the source app
  app: string; // friendly app name
  title: string;
  artist: string;
  album: string;
  artwork: string | null; // data: URL
  /** App or site logo (data: URL); null → a letter badge is drawn. */
  icon?: string | null;
  playing: boolean;
  position: number; // seconds, at sampledAt
  duration: number; // seconds (0 = unknown)
  sampledAt: number; // ms since epoch when position was sampled
  canNext: boolean;
  canPrev: boolean;
  canSeek: boolean;
  /** The app is actually making sound right now. */
  audible?: boolean;
  /** Playback speed (1 = normal). */
  rate?: number;
  /** Where the data came from: Windows' media API or the browser extension. */
  source?: "windows" | "extension";
  /** Live stream: show the LIVE bar instead of timestamps. */
  live?: boolean;
}

export interface MediaState {
  sessions: MediaSession[];
  currentId: string | null;
}

export type MediaAction = "toggle" | "next" | "prev" | "open" | `seek:${number}`;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bridge {
  isNative: boolean;
  /** "island" | "settings" (which window this page is running in) */
  windowLabel: string;
  onMedia(cb: (s: MediaState) => void): () => void;
  /** Native only: cursor entered/left the island (the window is click-through elsewhere). */
  onHover(cb: (inside: boolean) => void): () => void;
  /** 0..1 per frequency band, from what the PC is actually playing. */
  onAudio(cb: (levels: number[]) => void): () => void;
  mediaCommand(id: string, action: MediaAction): void;
  /** Tell the backend where the island is (CSS px, relative to the window). */
  setHitRects(island: Rect, bubble: Rect | null): void;
  /** While true, the island stays open and clickable even if the cursor leaves it (dragging). */
  setHold(hold: boolean): void;

  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  resetSettings(): Promise<AppSettings>;
  onSettings(cb: (s: AppSettings) => void): () => void;
  listMonitors(): Promise<MonitorInfo[]>;
  showContextMenu(): void;
  openSettings(): void;

  /** The AI hotkey / menu item asked to open "Search or Ask". */
  onAiOpen(cb: () => void): () => void;
  /** Let the island take keyboard focus (true) or give it back (false). */
  aiFocus(focused: boolean): void;
  /** Liquid glass: stream the screen behind `rect` (CSS px, window-relative). */
  glassStart(r: Rect): void;
  glassUpdate(r: Rect): void;
  glassStop(): void;
  onGlassFrame(cb: (dataUrl: string) => void): () => void;

  /** Audio output devices (speakers, headphones…) and switching the Windows default. */
  listOutputs(): Promise<OutputDevice[]>;
  /** Write a line to the app's console window (debugging). */
  log(msg: string): void;
  setOutput(id: string): Promise<void>;
}

export interface OutputDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function wrapUnlisten(p: Promise<() => void>) {
  return () => void p.then((un) => un());
}

function tauriLabel(): string {
  try {
    // Set by Tauri before any script runs; avoids an async IPC round-trip.
    return (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? "island";
  } catch {
    return "island";
  }
}

const tauriBridge: Bridge = {
  isNative: true,
  windowLabel: isTauri ? tauriLabel() : "island",
  onMedia(cb) {
    const un = wrapUnlisten(listen<MediaState>("media://update", (e) => cb(e.payload)));
    invoke("media_refresh").catch(console.error);
    return un;
  },
  onHover: (cb) => {
    const off = wrapUnlisten(listen<boolean>("island://hover", (e) => cb(e.payload)));
    // The cursor may already be on the island (it starts under the mouse, or the page
    // reloaded): catch up with the current state instead of waiting for the next change.
    invoke<boolean>("hover_state").then((h) => h && cb(true)).catch(() => {});
    return off;
  },
  onAudio: (cb) => wrapUnlisten(listen<number[]>("audio://levels", (e) => cb(e.payload))),
  mediaCommand(id, action) {
    invoke("media_command", { id, action }).catch(console.error);
  },
  setHitRects(island, bubble) {
    invoke("set_hit_rects", { island, bubble }).catch(console.error);
  },
  setHold(hold) {
    invoke("set_hold", { hold }).catch(console.error);
  },
  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (patch) => invoke<AppSettings>("update_settings", { patch }),
  resetSettings: () => invoke<AppSettings>("reset_settings"),
  onSettings: (cb) => wrapUnlisten(listen<AppSettings>("settings://changed", (e) => cb(e.payload))),
  listMonitors: () => invoke<MonitorInfo[]>("list_monitors"),
  showContextMenu() {
    invoke("show_context_menu").catch(console.error);
  },
  openSettings() {
    invoke("open_settings").catch(console.error);
  },
  onAiOpen: (cb) => wrapUnlisten(listen("ai://open", () => cb())),
  aiFocus(focused) {
    invoke("ai_focus", { focused }).catch(console.error);
  },
  glassStart: (r) => void invoke("glass_start", { ...r }).catch(console.error),
  glassUpdate: (r) => void invoke("glass_update", { ...r }).catch(console.error),
  glassStop: () => void invoke("glass_stop").catch(console.error),
  onGlassFrame: (cb) => wrapUnlisten(listen<string>("glass://frame", (e) => cb(e.payload))),
  listOutputs: () => invoke<OutputDevice[]>("list_outputs"),
  log: (msg) => void invoke("ui_log", { msg }).catch(() => {}),
  setOutput: (id) => invoke("set_output", { id }),
};

/* ---------- mock (browser preview) ---------- */

const mockOutputs: OutputDevice[] = [
  { id: "spk", name: "Speakers (Realtek(R) Audio)", isDefault: true },
  { id: "hp", name: "Headphones (WH-1000XM5)", isDefault: false },
  { id: "mon", name: "LG ULTRAGEAR (NVIDIA High Definition Audio)", isDefault: false },
];

let mockSettings: AppSettings = { ...DEFAULT_SETTINGS };
const settingsListeners = new Set<(s: AppSettings) => void>();
function setMockSettings(s: AppSettings) {
  mockSettings = s;
  settingsListeners.forEach((l) => l(s));
  return Promise.resolve(s);
}

const mockBridge: Bridge = {
  isNative: false,
  windowLabel: typeof location !== "undefined" && (location.hash === "#settings" || location.hash === "#fsvol") ? location.hash.slice(1) : "island",
  onMedia: (cb) => mock.subscribe(cb),
  // The preview has no native hit-test; the showcase stage plays that part on its demo bus.
  onHover: (cb) => {
    let off = () => {};
    void import("./lib/native").then((n) => (off = n.on<boolean>("island://hover", cb)));
    return () => off();
  },
  onAudio: (cb) => mock.subscribeAudio(cb),
  mediaCommand: (id, action) => mock.command(id, action),
  // Kept for the showcase stage, which hit-tests like the native side does.
  setHitRects: (island, bubble) => {
    (window as unknown as { __hitRects: unknown }).__hitRects = { island, bubble };
  },
  setHold: () => {},
  getSettings: () => Promise.resolve(mockSettings),
  updateSettings: (patch) => setMockSettings({ ...mockSettings, ...patch }),
  resetSettings: () => setMockSettings({ ...DEFAULT_SETTINGS }),
  onSettings(cb) {
    settingsListeners.add(cb);
    return () => void settingsListeners.delete(cb);
  },
  listMonitors: () =>
    Promise.resolve([
      { index: 0, label: "Display 1 — 2560×1440", primary: true },
      { index: 1, label: "Display 2 — 1920×1080", primary: false },
    ]),
  showContextMenu: () => {},
  openSettings: () => window.open("#settings", "_blank"),
  onAiOpen(cb) {
    // Preview: same hotkey as the app, plus the panel button.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.code === "Space") cb();
    };
    const onEvt = () => cb();
    window.addEventListener("keydown", onKey);
    window.addEventListener("island:ai-open", onEvt);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("island:ai-open", onEvt);
    };
  },
  aiFocus: () => {},
  glassStart: () => {},
  glassUpdate: () => {},
  glassStop: () => {},
  onGlassFrame: () => () => {},
  listOutputs: () => Promise.resolve(mockOutputs.map((d) => ({ ...d }))),
  log: (msg) => console.log(msg),
  setOutput(id) {
    mockOutputs.forEach((d) => (d.isDefault = d.id === id));
    return Promise.resolve();
  },
};

export const bridge: Bridge = isTauri ? tauriBridge : mockBridge;
