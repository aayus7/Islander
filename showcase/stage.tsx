// Showcase stage: the real island (browser preview build) on a desktop, driven by the
// recorder (showcase/record.py) through window.__stage. Nothing here ships in the app.
import "./stage.css";
(window as unknown as { __stageHover: boolean }).__stageHover = true;

const { mock } = await import("../src/mock");
const { bridge } = await import("../src/bridge");
const { weatherStore } = await import("../src/lib/weather");
const { pushBanner } = await import("../src/island/modules/Banners");
const { todoStore } = await import("../src/island/modules/Notes");

// Demo bus (created by lib/native on first use; make sure it exists now).
const native = await import("../src/lib/native");
void native.on("__init", () => {});
const bus = (window as unknown as { __islandDemo: { emit(e: string, p?: unknown): void; handle(c: string, f: (a?: Record<string, unknown>) => unknown): void } }).__islandDemo;

await bridge.updateSettings({ moveTipShown: true });

const cursorEl = document.getElementById("cursor")!;
let cx = -40, cy = -40, pressed = false;
function drawCursor() {
  cursorEl.style.transform = `translate(${cx - 2}px, ${cy - 1.5}px) scale(${pressed ? 0.88 : 1})`;
}
drawCursor();

// Like the native hit-test: hovering means the cursor is over the island's shape (or its dock).
let hovering = false;
type R = { x: number; y: number; w: number; h: number };
function hitTest() {
  // The island reports its shape in window coordinates (a 560 px wide window centred at the top).
  const hr = (window as unknown as { __hitRects?: { island: R; bubble: R | null } }).__hitRects;
  if (!hr) return;
  const box = document.querySelector(".island")?.getBoundingClientRect();
  if (!box) return;
  const left = box.left + box.width / 2 - 280;
  const inR = (r: R | null) => !!r && cx >= left + r.x && cx <= left + r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  const dock = document.querySelector(".dock")?.getBoundingClientRect();
  const onDock = !!dock && dock.width > 0 && cx >= dock.left && cx <= dock.right && cy >= dock.top && cy <= dock.bottom;
  const inside = inR(hr.island) || inR(hr.bubble) || onDock;
  if (inside !== hovering) {
    hovering = inside;
    bus.emit("island://hover", inside);
  }
}
window.setInterval(hitTest, 50);

Object.assign(window, {
  __stage: {
    mock,
    bridge,
    weatherStore,
    pushBanner,
    emit: (e: string, p?: unknown) => bus.emit(e, p),
    handle: (c: string, f: (a?: Record<string, unknown>) => unknown) => bus.handle(c, f),
    settings: (patch: Record<string, unknown>) => bridge.updateSettings(patch),
    cursor(x: number, y: number, down?: boolean) {
      cx = x;
      cy = y;
      if (down !== undefined) pressed = down;
      drawCursor();
      hitTest();
    },
    cursorVisible(v: boolean) {
      cursorEl.classList.toggle("hidden", !v);
    },
    caption(title: string | null, sub = "") {
      document.querySelector(".stage-caption")?.remove();
      if (!title) return;
      document.body.insertAdjacentHTML("beforeend", `<div class="stage-caption"><h1>${title}</h1><p>${sub}</p></div>`);
    },
  },
});

/* ---------------- scene helpers (all timing runs on the virtual clock) ---------------- */
type Dl = { id: string; name: string; path: string; received: number; total: number; state: "in_progress" | "complete" | "interrupted"; browser: string; speed?: number };
const downloads = new Map<string, Dl>();
const pushDownloads = () => bus.emit("downloads://update", [...downloads.values()]);
/** A download that runs from 0 to `total` bytes over `ms` (gently uneven speed). */
function runDownload(o: { id: string; name: string; total: number; ms: number; browser: string; from?: number; to?: number; done?: boolean }) {
  const start = performance.now();
  const d: Dl = { id: o.id, name: o.name, path: "C:\\Users\\you\\Downloads\\" + o.name, received: (o.from ?? 0) * o.total, total: o.total, state: "in_progress", browser: o.browser, speed: 0 };
  downloads.set(o.id, d);
  pushDownloads();
  let last = d.received, lastT = start;
  const tick = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / o.ms);
    const k = (o.from ?? 0) + ((o.to ?? 1) - (o.from ?? 0)) * (t + 0.035 * Math.sin(t * 9));
    d.received = Math.min(o.total, Math.max(last, k * o.total));
    const now = performance.now();
    d.speed = ((d.received - last) / Math.max(1, now - lastT)) * 1000;
    last = d.received;
    lastT = now;
    if (t >= 1) {
      window.clearInterval(tick);
      if (o.done !== false) {
        d.state = "complete";
        d.received = o.total;
        d.speed = 0;
      }
    }
    pushDownloads();
  }, 250);
}
function clearDownload(id: string) {
  downloads.delete(id);
  pushDownloads();
}

const PEER = "Aayush's iPhone";
/** LocalSend: when the request is accepted, the files arrive with progress. */
let pending: { id: string; name: string; total: number; files: number } | null = null;
bus.handle("localsend_respond", (a) => {
  bus.emit("localsend://incoming-closed", a?.id);
  if (!a?.accept || !pending) return;
  const p = pending;
  pending = null;
  window.setTimeout(() => runDownload({ id: "ls-" + p.id, name: p.files > 1 ? `${p.name} (+${p.files - 1} more)` : p.name, total: p.total, ms: 2600, browser: "from:" + PEER }), 350);
});
let shelf: unknown[] = [];
bus.handle("shelf_list", () => shelf);
bus.handle("shelf_elevated", () => false);
function setShelf(items: unknown[]) {
  shelf = items;
  bus.emit("shelf://changed", items);
}
bus.handle("localsend_peers", () => [
  { fingerprint: "a", alias: PEER, deviceModel: "iPhone", deviceType: "mobile", ip: "192.168.1.20", port: 53317, https: true },
  { fingerprint: "b", alias: "Pixel 9", deviceModel: "Google", deviceType: "mobile", ip: "192.168.1.21", port: 53317, https: true },
  { fingerprint: "c", alias: "Studio PC", deviceModel: "Windows", deviceType: "desktop", ip: "192.168.1.30", port: 53317, https: true },
]);

Object.assign((window as unknown as { __stage: object }).__stage, {
  runDownload,
  clearDownload,
  setShelf,
  todos: (list: unknown[]) => todoStore.set(list as never),
  airdrop(files: { name: string; size: number; fileType: string; preview: string | null }[]) {
    const total = files.reduce((a, f) => a + f.size, 0);
    pending = { id: "rq1", name: files[0].name, total, files: files.length };
    bus.emit("localsend://incoming", { id: "rq1", alias: PEER, deviceModel: "iPhone", deviceType: "mobile", files, total });
  },
  notify(n: { id: string; app: string; title: string; body: string; avatar?: string | null; icon?: string | null; attachment?: string | null }) {
    bus.emit("notify://new", { icon: null, avatar: null, avatarRound: true, attachment: null, aumid: "", ...n });
  },
  privacy(camera: boolean, mic: boolean, apps: string[] = []) {
    bus.emit("privacy://update", { camera, mic, apps });
  },
  connect(name: string, kind = "earbuds", battery: number | null = 82) {
    bus.emit("bt://connected", { id: name, name, connected: true, kind, battery, audio: true });
  },
});

await import("../src/main");
(window as unknown as { __stageReady: boolean }).__stageReady = true;
