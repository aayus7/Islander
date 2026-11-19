// Mirrors `Settings` in src-tauri/src/settings.rs (camelCase).
import type { AnimStyle } from "./lib/springs";

export type Theme = "black" | "graphite" | "midnight";

export interface AppSettings {
  animStyle: AnimStyle;
  animSpeed: number;
  sizeScale: number;
  offsetX: number;
  offsetY: number;
  monitor: string; // "primary" | "follow" | "0" | "1" ...
  expandOnHover: boolean;
  pinned: boolean;
  theme: Theme;
  transparency: number;
  hideHotkey: string;
  idleStyle: "notch" | "dot" | "pill";
  aiHotkey: string;
  aiApiKey: string;
  aiModel: string;
  aiRelayUrl: string;
  aiGlass: boolean;
  /** Show the island in Islander's own screen recordings. */
  showInRecordings: boolean;
  deviceId: string;

  // ---- modules & workspace ----
  /** Enabled tabs, in order. */
  modules: ModuleId[];
  weatherCity: string;
  weatherUnit: "C" | "F";
  clipboardHistory: boolean;

  // ---- system ----
  /** Volume / brightness / Caps & Num Lock pills. */
  hud: boolean;
  /** Green (camera) / orange (mic) dots beside the island. */
  privacyDots: boolean;
  /** Show Windows notifications in the island. */
  notifications: boolean;
  /** Island-only Do Not Disturb: no banners while on. */
  dnd: boolean;
  /** Get out of the way while a fullscreen game or video is in front. */
  hideInFullscreen: boolean;
  /** Tuck the island away until the cursor touches the top edge. */
  autoHide: boolean;
  /** Animation target frame rate for live visuals (waveform, glass). */
  frameRate: number;
  /** Replace Windows' volume flyout and notification banners with the island's. */
  takeover: boolean;
  launchAtLogin: boolean;
  /** Screen edge the island lives on, and where along it. */
  dock: Dock;
  dockAlong: DockAlong;
  /** The one-time "you can move the island" tip was shown. */
  moveTipShown: boolean;
  /** "inter" = bundled Inter (default); "system" = SF Pro if installed, else Segoe UI. */
  font: "inter" | "system";
  /** Nearby sharing (LocalSend) in the Shelf. */
  nearbySharing: boolean;
  /** Name other devices see ("" = this PC's name). */
  nearbyName: string;
}

export type Dock = "top" | "bottom" | "left" | "right";
export type DockAlong = "start" | "center" | "end";

export type ModuleId = "ai" | "media" | "today" | "weather" | "clock" | "notes" | "shelf" | "clipboard" | "stats" | "controls";
export const ALL_MODULES: { id: ModuleId; label: string }[] = [
  { id: "ai", label: "Search or Ask" },
  { id: "media", label: "Now Playing" },
  { id: "controls", label: "Controls & Launcher" },
  { id: "today", label: "Today" },
  { id: "weather", label: "Weather" },
  { id: "clock", label: "Timer & Focus" },
  { id: "notes", label: "Notes & To-Do" },
  { id: "shelf", label: "File Shelf" },
  { id: "clipboard", label: "Clipboard" },
  { id: "stats", label: "System Monitor" },
];

export const DEFAULT_SETTINGS: AppSettings = {
  animStyle: "default",
  animSpeed: 1,
  sizeScale: 1,
  offsetX: 0,
  offsetY: 0,
  monitor: "primary",
  expandOnHover: true,
  pinned: false,
  theme: "black",
  transparency: 0,
  hideHotkey: "Ctrl+Alt+D",
  idleStyle: "notch",
  aiHotkey: "Ctrl+Alt+Space",
  aiApiKey: "",
  aiModel: "gemini-3.5-flash-lite",
  aiRelayUrl: "",
  aiGlass: true,
  showInRecordings: true,
  deviceId: "0123456789abcdef0123456789abcdef",
  modules: ALL_MODULES.map((m) => m.id),
  weatherCity: "",
  weatherUnit: "C",
  clipboardHistory: true,
  hud: true,
  privacyDots: true,
  notifications: true,
  dnd: false,
  hideInFullscreen: true,
  autoHide: false,
  frameRate: 60,
  takeover: true,
  launchAtLogin: true,
  dock: "top",
  dockAlong: "center",
  moveTipShown: false,
  font: "inter",
  nearbySharing: true,
  nearbyName: "",
};

export const THEME_RGB: Record<Theme, [number, number, number]> = {
  black: [0, 0, 0],
  graphite: [28, 28, 30],
  midnight: [12, 18, 44],
};

export function islandColor(s: Pick<AppSettings, "theme" | "transparency">) {
  const [r, g, b] = THEME_RGB[s.theme] ?? THEME_RGB.black;
  return `rgba(${r}, ${g}, ${b}, ${1 - s.transparency})`;
}

export interface MonitorInfo {
  index: number;
  label: string;
  primary: boolean;
}
