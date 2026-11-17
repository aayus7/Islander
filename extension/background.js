// Islander Media Bridge — background script.
// Collects what every tab is playing and streams it to the island over a local
// WebSocket (ws://127.0.0.1:47823). Commands from the island go back to the right tab.
// Runs as a service worker in Chrome/Edge and as a background script in Firefox.

const api = globalThis.browser ?? globalThis.chrome;
const PORT = 47823;

const UA = navigator.userAgent;
const BROWSER = UA.includes("Firefox/")
  ? "firefox"
  : UA.includes("Edg/")
    ? "edge"
    : UA.includes("OPR/")
      ? "opera"
      : navigator.brave
        ? "brave"
        : "chrome";

/* ---------- tab state ---------- */

/** "tabId:frameId" → { tabId, frameId, state, at } */
const frames = new Map();
/** tabId → audible (the browser's own "this tab is making sound") */
const audible = new Map();

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "media" || !sender.tab) return;
  const tabId = sender.tab.id;
  const frameId = sender.frameId ?? 0;
  const key = `${tabId}:${frameId}`;
  if (!msg.state) {
    frames.delete(key);
  } else {
    frames.set(key, { tabId, frameId, state: msg.state, at: Date.now() });
    if (!audible.has(tabId)) audible.set(tabId, !!sender.tab.audible);
    if (msg.state.artworkUrl) loadArtwork(msg.state.artworkUrl, msg.state.artworkFallback, true);
    if (msg.state.iconUrl) loadArtwork(msg.state.iconUrl);
  }
  connect();
  pushSoon();
});

api.tabs.onUpdated.addListener((tabId, info) => {
  if ("audible" in info) {
    audible.set(tabId, !!info.audible);
    pushSoon();
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  for (const k of [...frames.keys()]) if (k.startsWith(tabId + ":")) frames.delete(k);
  audible.delete(tabId);
  pushSoon();
});

/* ---------- artwork → small data: URL (so the island can read its colours) ---------- */

const art = new Map(); // url → dataURL | "" (failed) | null (loading)

/**
 * Fetch an image and turn it into a data: URL. `square` crops artwork to a centred
 * square at 384 px (crisp at the island's 64 px on high-DPI screens); icons stay as-is.
 */
async function loadArtwork(url, fallback, square = false) {
  if (art.has(url)) return;
  if (url.startsWith("data:")) {
    art.set(url, url);
    return;
  }
  art.set(url, null);
  try {
    let res = await fetch(url, { credentials: "omit" });
    if (!res.ok && fallback) res = await fetch(fallback, { credentials: "omit" });
    if (!res.ok) throw new Error(res.status);
    let blob = await res.blob();
    try {
      const bmp = await createImageBitmap(blob);
      let c;
      if (square) {
        // Centre-crop to a square (video thumbnails are 16:9) and scale to 384 px.
        const side = Math.min(bmp.width, bmp.height);
        const out = Math.min(384, side);
        c = new OffscreenCanvas(out, out);
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
        blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      } else {
        const s = Math.min(1, 128 / Math.max(bmp.width, bmp.height));
        c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        blob = await c.convertToBlob({ type: "image/png" });
      }
    } catch {
      if (blob.size > 400_000) throw new Error("too big");
    }
    art.set(url, await blobToDataUrl(blob));
  } catch {
    art.set(url, "");
  }
  if (art.size > 80) art.delete(art.keys().next().value);
  pushSoon();
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "image/jpeg"};base64,${btoa(bin)}`;
}

/* ---------- what we send ---------- */

function sessions() {
  // One session per tab: its best frame (playing beats paused, newest beats older).
  const best = new Map();
  for (const f of frames.values()) {
    const b = best.get(f.tabId);
    const better = !b || (f.state.playing && !b.state.playing) || (f.state.playing === b.state.playing && f.at > b.at);
    if (better) best.set(f.tabId, f);
  }
  return [...best.values()].map((f) => {
    const s = f.state;
    const a = s.artworkUrl ? art.get(s.artworkUrl) : null;
    const icon = s.iconUrl ? art.get(s.iconUrl) : null;
    return {
      key: `${f.tabId}:${f.frameId}`,
      title: s.title,
      artist: s.artist,
      album: s.album,
      artwork: a || null,
      icon: icon || null,
      siteName: s.siteName,
      playing: s.playing,
      position: s.position,
      duration: s.duration,
      live: !!s.live,
      rate: s.rate,
      sampledAt: s.sampledAt,
      canSeek: s.canSeek,
      canNext: s.canNext,
      canPrev: s.canPrev,
      audible: !!audible.get(f.tabId),
    };
  });
}

let pushTimer = 0;
function pushSoon() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 40);
}

function push() {
  send({ type: "state", sessions: sessions() });
}

/* ---------- connection to the island ---------- */

let ws = null;
let retryTimer = 0;
let pingTimer = 0;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(retryTimer);
  try {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  } catch {
    ws = null;
    retryTimer = setTimeout(connect, 3000);
    return;
  }
  ws.onopen = () => {
    send({ type: "hello", browser: BROWSER, version: 1 });
    push();
    clearInterval(pingTimer);
    // Regular traffic also keeps Chrome's service worker awake while connected.
    pingTimer = setInterval(() => send({ type: "ping" }), 20_000);
  };
  ws.onmessage = (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.type === "cmd") runCommand(m);
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    ws = null;
    retryTimer = setTimeout(connect, 3000); // island not running yet / restarted
  };
  ws.onerror = () => {};
}

function runCommand(m) {
  const f = frames.get(m.key);
  if (!f) return;
  if (m.action === "focus") {
    // Clicking the island's artwork/title: jump to the playing tab.
    Promise.resolve(api.tabs.update(f.tabId, { active: true }))
      .then((tab) => tab && api.windows.update(tab.windowId, { focused: true }))
      .catch(() => {});
    return;
  }
  const p = api.tabs.sendMessage(f.tabId, { type: "cmd", action: m.action, value: m.value }, { frameId: f.frameId });
  if (p && p.catch) p.catch(() => {});
}

connect();


/* ---------- downloads → island progress activity ---------- */

const dl = api.downloads;
let dlTimer = 0;
const recentDone = new Map(); // id → finished at (kept briefly so the island can show "Done")

function baseName(p) {
  return String(p || "").split(/[\\/]/).pop() || "Download";
}

async function pushDownloads() {
  if (!dl) return;
  let items = [];
  try {
    items = await dl.search({ orderBy: ["-startTime"], limit: 12 });
  } catch {
    return;
  }
  const now = Date.now();
  const active = items.filter((d) => d.state === "in_progress");
  for (const d of items) {
    if (d.state === "complete" && !recentDone.has(d.id) && d.endTime && now - Date.parse(d.endTime) < 8000) recentDone.set(d.id, now);
  }
  for (const [id, t] of recentDone) if (now - t > 6000) recentDone.delete(id);
  const show = items.filter((d) => d.state === "in_progress" || recentDone.has(d.id));
  send({
    type: "downloads",
    items: show.map((d) => ({
      id: String(d.id),
      name: baseName(d.filename),
      path: d.filename || "",
      received: d.bytesReceived || 0,
      total: d.totalBytes > 0 ? d.totalBytes : d.fileSize || 0,
      state: d.state,
    })),
  });
  clearTimeout(dlTimer);
  if (active.length || recentDone.size) dlTimer = setTimeout(pushDownloads, 500);
}

if (dl) {
  dl.onCreated.addListener(() => pushDownloads());
  dl.onChanged.addListener(() => pushDownloads());
}
