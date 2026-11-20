// The real island for the website's hero: the browser-preview build on a transparent page,
// hit-tested like the native app, cycling through real activities. Nothing here ships in the app.
(window as unknown as { __stageHover: boolean }).__stageHover = true;
const css = document.createElement("style");
css.textContent = "html,body{background:transparent!important;margin:0;overflow:hidden}.preview{background:none!important}.preview::before,.panel{display:none!important}";
document.head.appendChild(css);

const { mock } = await import("../src/mock");
const { bridge } = await import("../src/bridge");
const { weatherStore } = await import("../src/lib/weather");
const { todoStore } = await import("../src/island/modules/Notes");
const native = await import("../src/lib/native");
void native.on("__init", () => {});
type Bus = { emit(e: string, p?: unknown): void; handle(c: string, f: (a?: Record<string, unknown>) => unknown): void };
const bus = (window as unknown as { __islandDemo: Bus }).__islandDemo;

mock.stage([]);
await bridge.updateSettings({ moveTipShown: true, idleStyle: "pill", modules: ["ai", "controls", "today", "weather", "clock", "notes", "shelf", "clipboard", "stats"] } as never);
weatherStore.set({ key: "|C", error: "", data: Object.assign({"city": "Toronto", "temp": -1, "high": 2, "low": -5, "code": 71, "isDay": true, "unit": "C", "hourly": [], "feels": -6, "humidity": 84, "dewPoint": -3, "wind": 21, "windDir": 290, "gust": 44, "windUnit": "km/h", "uv": 1, "pressure": 1009, "visibility": 6000, "precip": 0.4, "utcOffset": -18000, "sunrise": "2026-11-19T07:14", "sunset": "2026-11-19T16:49", "tomorrowSunrise": "2026-11-20T07:15", "hours": [{"t": "2026-11-19T09:00", "temp": -1, "code": 71, "isDay": true, "pop": 70}, {"t": "2026-11-19T10:00", "temp": 0, "code": 71, "isDay": true, "pop": 70}, {"t": "2026-11-19T11:00", "temp": 0, "code": 71, "isDay": true, "pop": 70}, {"t": "2026-11-19T12:00", "temp": 1, "code": 71, "isDay": true, "pop": 70}, {"t": "2026-11-19T13:00", "temp": 1, "code": 71, "isDay": true, "pop": 70}, {"t": "2026-11-19T14:00", "temp": 1, "code": 71, "isDay": true, "pop": 70}, {"t": "2026-11-19T15:00", "temp": 0, "code": 3, "isDay": true, "pop": 15}, {"t": "2026-11-19T16:00", "temp": -1, "code": 3, "isDay": true, "pop": 15}, {"t": "2026-11-19T17:00", "temp": -2, "code": 3, "isDay": false, "pop": 15}, {"t": "2026-11-19T18:00", "temp": -2, "code": 3, "isDay": false, "pop": 15}, {"t": "2026-11-19T19:00", "temp": -3, "code": 3, "isDay": false, "pop": 15}, {"t": "2026-11-19T20:00", "temp": -3, "code": 3, "isDay": false, "pop": 15}, {"t": "2026-11-19T21:00", "temp": -3, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-19T22:00", "temp": -4, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-19T23:00", "temp": -4, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T00:00", "temp": -4, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T01:00", "temp": -5, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T02:00", "temp": -5, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T03:00", "temp": -5, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T04:00", "temp": -5, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T05:00", "temp": -4, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T06:00", "temp": -3, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T07:00", "temp": -2, "code": 2, "isDay": false, "pop": 15}, {"t": "2026-11-20T08:00", "temp": -1, "code": 2, "isDay": true, "pop": 15}, {"t": "2026-11-20T09:00", "temp": 0, "code": 2, "isDay": true, "pop": 15}], "days": [{"date": "2026-11-19", "max": 2, "min": -5, "code": 71, "pop": 70, "uv": 1, "precipSum": 2.1}, {"date": "2026-11-20", "max": 3, "min": -3, "code": 3, "pop": 20, "uv": 1, "precipSum": 0}, {"date": "2026-11-21", "max": 6, "min": 0, "code": 61, "pop": 60, "uv": 1, "precipSum": 2.1}, {"date": "2026-11-22", "max": 4, "min": -2, "code": 2, "pop": 10, "uv": 1, "precipSum": 0}, {"date": "2026-11-23", "max": 1, "min": -6, "code": 73, "pop": 80, "uv": 1, "precipSum": 2.1}, {"date": "2026-11-24", "max": -1, "min": -7, "code": 0, "pop": 0, "uv": 1, "precipSum": 0}, {"date": "2026-11-25", "max": 3, "min": -4, "code": 3, "pop": 10, "uv": 1, "precipSum": 0}]}, { at: Date.now() }) } as never);
todoStore.set([
  { id: "t1", text: "Ship Islander 1.0", done: false, at: 1 },
  { id: "t2", text: "Record the launch video", done: true, at: 2 },
  { id: "t3", text: "Reply to kai about the wallpaper", done: false, at: 3 },
] as never);

const M = "media/";
const photos = [1, 2, 3].map((i) => ({ name: `IMG_482${i}.JPG`, size: 3_200_000 + i * 180_000, fileType: "image/jpeg", preview: M + `thumb${i}.jpg` }));
let shelf: unknown[] = [];
bus.handle("shelf_list", () => shelf);
bus.handle("shelf_elevated", () => false);
bus.handle("localsend_peers", () => [
  { fingerprint: "a", alias: "Aayush's iPhone", deviceModel: "iPhone", deviceType: "mobile", ip: "192.168.1.20", port: 53317, https: true },
  { fingerprint: "b", alias: "Pixel 9", deviceModel: "Google", deviceType: "mobile", ip: "192.168.1.21", port: 53317, https: true },
]);

/* downloads */
type Dl = { id: string; name: string; path: string; received: number; total: number; state: string; browser: string; speed: number };
const dls = new Map<string, Dl>();
const push = () => bus.emit("downloads://update", [...dls.values()]);
function download(id: string, name: string, total: number, ms: number, browser: string, from = 0, onDone?: () => void) {
  const d: Dl = { id, name, path: "C:\\Users\\you\\Downloads\\" + name, received: from * total, total, state: "in_progress", browser, speed: 0 };
  dls.set(id, d);
  push();
  const start = performance.now();
  let last = d.received, lastT = start;
  const tick = setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / ms);
    const now = performance.now();
    d.received = Math.max(last, (from + (1 - from) * (t + 0.03 * Math.sin(t * 9))) * total);
    d.speed = ((d.received - last) / Math.max(1, now - lastT)) * 1000;
    last = d.received; lastT = now;
    if (t >= 1) { clearInterval(tick); d.state = "complete"; d.received = total; d.speed = 0; onDone?.(); }
    push();
  }, 250);
}

/* the phone's request: accept by clicking, or it accepts itself */
let pending = false;
function accept() {
  if (!pending) return;
  pending = false;
  bus.emit("localsend://incoming-closed", "rq");
  setTimeout(() => download("ls", "IMG_4821.JPG (+2 more)", photos.reduce((a, p) => a + p.size, 0), 2600, "from:Aayush's iPhone", 0, () => {
    shelf = photos.map((p, i) => ({ id: "s" + i, path: "C:\\x\\" + p.name, name: p.name, kind: "image", size: p.size, thumb: p.preview, ext: "jpg" }));
    bus.emit("shelf://changed", shelf);
  }), 300);
}
bus.handle("localsend_respond", (a) => { if (a?.accept) accept(); else { pending = false; bus.emit("localsend://incoming-closed", "rq"); } });

/* Safari (and every iOS browser) can't draw transparent WebM, so it would show the key colour.
   There the device clip plays as an animated WebP with alpha instead, matching the video's motion. */
const ua = navigator.userAgent;
const webkit = /iPhone|iPad|iPod/.test(ua) || (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\/|OPR/.test(ua));
if (webkit || location.hash === "#webp") {
  const css2 = document.createElement("style");
  css2.textContent = "@keyframes devIn{from{opacity:0;transform:scale(var(--s0))}to{opacity:1;transform:scale(var(--s1)) translateY(var(--y))}}img.dev-video{animation:devIn .5s cubic-bezier(.2,.9,.25,1.1) .1s both}";
  document.head.appendChild(css2);
  const swap = (v: HTMLVideoElement) => {
    if (v.dataset.swapped) return;
    v.dataset.swapped = "1";
    const src = v.getAttribute("src") || "";
    const max = /airpods-max/.test(src);
    const img = document.createElement("img");
    img.className = "dev-video";
    img.alt = "";
    img.src = src.replace(/\.webm$/, ".webp");
    img.style.setProperty("--s0", String(0.85 * (max ? 1.5 : 1)));
    img.style.setProperty("--s1", String(max ? 1.5 : 1));
    img.style.setProperty("--y", max ? "3.4px" : "0px");
    v.removeAttribute("src");
    v.load();
    v.style.display = "none";
    v.after(img);
  };
  new MutationObserver(() => document.querySelectorAll<HTMLVideoElement>("video.dev-video").forEach(swap)).observe(document.documentElement, { childList: true, subtree: true });
}

/* native-style hover: only over the island's real shape (or its tab dock) */
let hovering = false, lastHover = -1e9, px = -1, py = -1;
type R = { x: number; y: number; w: number; h: number };
function hit() {
  const hr = (window as unknown as { __hitRects?: { island: R; bubble: R | null } }).__hitRects;
  const box = document.querySelector(".island")?.getBoundingClientRect();
  let inside = false;
  if (hr && box) {
    const left = box.left + box.width / 2 - 280;
    const inR = (r: R | null) => !!r && px >= left + r.x && px <= left + r.x + r.w && py >= r.y && py <= r.y + r.h;
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    // the island, its dock and the gap between them act as one surface
    const span = dock && dock.width > 0 ? { x: Math.min(left + hr.island.x, dock.left) - left, y: hr.island.y, w: Math.max(hr.island.w, dock.width), h: dock.bottom - hr.island.y } : null;
    inside = inR(hr.island) || inR(hr.bubble) || (!!span && px >= left + span.x && px <= left + span.x + span.w && py >= span.y && py <= span.y + span.h);
  }
  if (inside) lastHover = performance.now();
  // tell the website where the island is, so the page stays clickable everywhere else
  if (hr && box) {
    const left = box.left + box.width / 2 - 280;
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    const r = { x: left + hr.island.x, y: hr.island.y, w: hr.island.w, h: hr.island.h };
    if (dock && dock.width > 0) { const x0 = Math.min(r.x, dock.left), x1 = Math.max(r.x + r.w, dock.right); r.x = x0; r.w = x1 - x0; r.h = dock.bottom - r.y; }
    if (hr.bubble) { r.h = Math.max(r.h, hr.bubble.y + hr.bubble.h - r.y); }
    parent.postMessage({ island: true, hover: inside, rect: r, open: hr.island.h > 70 }, "*");
  }
  if (inside !== hovering) { hovering = inside; bus.emit("island://hover", inside); }
}
addEventListener("message", (e) => { if (e.source === parent && e.data?.pt) { px = e.data.pt[0]; py = e.data.pt[1]; hit(); } });
/* Over the island the wheel belongs to it (tabs, lists), as on the desktop: never let it
   fall through and scroll the website. Lists inside still scroll by themselves. */
function canScroll(el: Element | null, dx: number, dy: number) {
  for (; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (Math.abs(dy) >= Math.abs(dx) && /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) {
      if ((dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop) > 1) return true;
    }
    if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) {
      const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      if ((d > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft) > 1) return true;
    }
  }
  return false;
}
addEventListener("wheel", (e) => {
  if (!e.defaultPrevented && !canScroll(e.target as Element, e.deltaX, e.deltaY)) e.preventDefault();
}, { passive: false });
/* Report the island's live drawn height every frame it changes, so the website can move its
   headline in step with the real spring rather than guessing a duration. */
let lastShape = -1;
(function shapeLoop() {
  const path = document.querySelector(".island svg path");
  if (path) {
    // how far down the open island reaches: its shape, plus the tab dock as it fades in or out
    let h = path.getBoundingClientRect().bottom;
    const dock = document.querySelector<HTMLElement>(".dock");
    if (dock) {
      const r = dock.getBoundingClientRect();
      const o = +getComputedStyle(dock).opacity || 0;
      if (r.height > 0) h = Math.max(h, h + (r.bottom - h) * o);
    }
    h = Math.round(h * 10) / 10;
    if (h !== lastShape) { lastShape = h; parent.postMessage({ island: true, shape: h, hover: hovering }, "*"); }
  }
  requestAnimationFrame(shapeLoop);
})();
addEventListener("pointermove", (e) => { px = e.clientX; py = e.clientY; hit(); });
addEventListener("pointerleave", () => { px = py = -1; hit(); });
document.addEventListener("mouseleave", () => { px = py = -1; hit(); });
setInterval(hit, 80);

/* the loop: real activities, paused while someone is exploring the island */
const steps: [number, () => void][] = [
  [1400, () => bus.emit("notify://new", { id: "n" + Date.now(), app: "Discord", title: "maya", body: "are we still on for tonight?", avatar: M + "av-maya.png", avatarRound: true, icon: null, attachment: null, aumid: "" })],
  [6600, () => { pending = true; bus.emit("localsend://incoming", { id: "rq", alias: "Aayush's iPhone", deviceModel: "iPhone", deviceType: "mobile", files: photos, total: photos.reduce((a, p) => a + p.size, 0) }); }],
  [3600, () => accept()],
  [9800, () => download("idm", "ubuntu-24.04.1-desktop-amd64.iso", 6_114_000_000, 5200, "IDM", 0.62)],
  [12500, () => bus.emit("bt://connected", { id: "AirPods Pro", name: "AirPods Pro", connected: true, kind: "earbuds", battery: 82, audio: true })],
  [5200, () => { for (let i = 0; i < 7; i++) setTimeout(() => bus.emit("hud://show", { kind: "volume", value: 0.38 + i * 0.06, on: false }), i * 110); }],
  [4200, () => { dls.clear(); push(); shelf = []; bus.emit("shelf://changed", shelf); }],
];
let i = 0;
function next() {
  const [wait, run] = steps[i];
  const go = () => { if (hovering || performance.now() - lastHover < 2500) { setTimeout(go, 600); return; } run(); i = (i + 1) % steps.length; next(); };
  setTimeout(go, wait);
}
await import("../src/main");
// island.html?still: no cycle (for testing)
if (!location.search.includes("still")) next();
