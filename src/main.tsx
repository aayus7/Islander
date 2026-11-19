/// <reference types="vite/client" />
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bridge, isTauri } from "./bridge";
import { SettingsProvider } from "./lib/settings";
import "./styles.css";
import { installSmoothScroll } from "./lib/smoothScroll";

const isSettings = bridge.windowLabel === "settings";
const isZones = bridge.windowLabel === "zones";
document.documentElement.classList.toggle("native", isTauri);
document.documentElement.classList.toggle("settings-window", isSettings);
document.documentElement.classList.toggle("zones-window", isZones);

// Feel like a desktop app, not a web page: no browser right-click menu (text fields keep
// theirs for copy/paste), no stray drags of pictures or links.
if (isTauri) {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest("input, textarea, [contenteditable]")) e.preventDefault();
  });
  document.addEventListener("dragstart", (e) => {
    if ((e.target as HTMLElement).closest?.("img, a")) e.preventDefault();
  });
}
// Release builds: switch off the browser's own shortcuts (reload, print, find, zoom,
// view-source, devtools, back/forward…) so nothing can turn the app into a web page.
if (isTauri && import.meta.env.PROD) {
  const blocked = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (["f5", "f7", "f12", "f3", "browserback", "browserforward", "browserrefresh"].includes(k)) return true;
    if (e.altKey && (k === "arrowleft" || k === "arrowright" || k === "home")) return true;
    if (ctrl && e.shiftKey && ["i", "j", "c", "r", "delete"].includes(k)) return true;
    if (ctrl && ["r", "p", "u", "s", "g", "j", "h", "o", "n", "t", "w", "+", "=", "-", "_", "0"].includes(k)) return true;
    if (ctrl && k === "f" && bridge.windowLabel !== "settings") return true;
    return false;
  };
  window.addEventListener("keydown", (e) => blocked(e) && e.preventDefault(), true);
  // Mouse back/forward buttons.
  window.addEventListener("mouseup", (e) => (e.button === 3 || e.button === 4) && e.preventDefault(), true);
  // Ctrl+wheel page zoom.
  window.addEventListener("wheel", (e) => e.ctrlKey && e.preventDefault(), { passive: false, capture: true });
}

// Development: after code changes, reload the whole window instead of patching it
// in place, so a half-applied update can never leave the island in a broken state.
if (import.meta.hot) {
  let t = 0;
  import.meta.hot.on("vite:afterUpdate", () => {
    clearTimeout(t);
    t = window.setTimeout(() => location.reload(), 250);
  });
}

installSmoothScroll();

// Each window only loads the code it shows: the island never parses the Settings app, the
// drop-zone overlay or the browser preview, so it starts (and first opens) faster.
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const Zones = lazy(() => import("./Zones").then((m) => ({ default: m.Zones })));
const Preview = lazy(() => import("./Preview").then((m) => ({ default: m.Preview })));

createRoot(document.getElementById("root")!).render(
  <Suspense fallback={null}>
    {isZones ? <Zones /> : <SettingsProvider>{isSettings ? <SettingsPage /> : isTauri ? <App /> : <Preview />}</SettingsProvider>}
  </Suspense>,
);
