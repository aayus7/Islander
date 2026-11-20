// Fake media sources for the browser preview. Tracks and artwork are invented.
import type { MediaAction, MediaSession, MediaState } from "./bridge";

function art(a: string, b: string, c: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="120" height="120" fill="url(#g)"/>
    <circle cx="82" cy="40" r="26" fill="${c}" opacity="0.85"/>
    <circle cx="36" cy="88" r="40" fill="${b}" opacity="0.55"/>
  </svg>`;
  return "data:image/svg+xml;base64," + btoa(svg);
}

const TRACKS = [
  { title: "Golden Hour Drive", artist: "Neon Harbor", album: "Coastline", duration: 214, artwork: art("#ff9a3c", "#c2185b", "#ffe082") },
  { title: "Paper Planets (Extended Late Night Version)", artist: "Lumen & The Quiet Fields", album: "Orbitals", duration: 248, artwork: art("#2b5876", "#4e4376", "#7fdbff") },
  { title: "Tidal Glass", artist: "Orchid Static", album: "Undertow", duration: 187, artwork: art("#11998e", "#38ef7d", "#e0fff4") },
];

const PODCAST = { title: "Ep. 42 — Building Tiny Things", artist: "The Side Project Hour", album: "", duration: 3120, artwork: art("#8e2de2", "#4a00e0", "#ff6ec7") };

interface Src {
  id: string;
  app: string;
  list: typeof TRACKS;
  index: number;
  playing: boolean;
  position: number;
  sampledAt: number;
  /** Site/app icon (data: or image URL), as the browser extension sends it. */
  icon?: string;
}

const sources: Src[] = [
  { id: "Spotify.exe", app: "Spotify", list: TRACKS, index: 0, playing: true, position: 42, sampledAt: Date.now() },
];
let currentId: string | null = "Spotify.exe";
const listeners = new Set<(s: MediaState) => void>();

function pos(s: Src) {
  return s.playing ? s.position + (Date.now() - s.sampledAt) / 1000 : s.position;
}

function snapshot(): MediaState {
  return {
    currentId,
    sessions: sources.map<MediaSession>((s) => {
      const t = s.list[s.index];
      return {
        id: s.id, app: s.app, title: t.title, artist: t.artist, album: t.album, artwork: t.artwork,
        playing: s.playing, position: s.position, duration: t.duration, sampledAt: s.sampledAt,
        canNext: true, canPrev: true, canSeek: true, audible: s.playing, rate: 1, source: s.icon ? "extension" : "windows", icon: s.icon ?? null,
      };
    }),
  };
}

function emit() {
  const snap = snapshot();
  listeners.forEach((l) => l(snap));
}

function find(id: string) {
  return sources.find((s) => s.id === id);
}

function skip(s: Src, dir: 1 | -1) {
  s.index = (s.index + dir + s.list.length) % s.list.length;
  s.position = 0;
  s.sampledAt = Date.now();
}

// Auto-advance when a track ends. (Started on first subscribe, so the real app — which
// never uses the mock — doesn't tick it.)
let advancing = 0;
const startAdvance = () => (advancing ||= window.setInterval(advanceTick, 500));
function advanceTick() {
  let changed = false;
  for (const s of sources) {
    if (s.playing && pos(s) >= s.list[s.index].duration) {
      skip(s, 1);
      changed = true;
    }
  }
  if (changed) emit();
}

// Fake "what the speakers are playing" for the preview: a 118 bpm kick, a bassline and hats.
const audioListeners = new Set<(l: number[]) => void>();
let audioTimer = 0;
function audioFrame() {
  const playing = sources.some((s) => s.playing);
  if (!playing) {
    audioListeners.forEach((l) => l([0, 0, 0, 0, 0, 0]));
    return;
  }
  const t = performance.now() / 1000;
  const beat = (t * 118) / 60;
  const ph = beat % 1;
  const kick = Math.exp(-ph * 7);
  const hat = Math.exp(-((beat * 2) % 1) * 12);
  const n = () => Math.random();
  const lv = [
    0.35 + 0.6 * kick + 0.05 * n(),
    0.3 + 0.35 * kick + 0.25 * (0.5 + 0.5 * Math.sin(t * 2.1)) + 0.05 * n(),
    0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3.3 + 1)) + 0.12 * n(),
    0.3 + 0.3 * (0.5 + 0.5 * Math.sin(t * 4.7 + 2)) + 0.15 * n(),
    0.2 + 0.45 * hat + 0.1 * n(),
    0.12 + 0.4 * hat + 0.1 * n(),
  ].map((v) => Math.min(1, v));
  audioListeners.forEach((l) => l(lv));
}

export const mock = {
  subscribeAudio(cb: (l: number[]) => void) {
    audioListeners.add(cb);
    if (!audioTimer) audioTimer = window.setInterval(audioFrame, 16);
    return () => {
      audioListeners.delete(cb);
      if (!audioListeners.size) {
        clearInterval(audioTimer);
        audioTimer = 0;
      }
    };
  },
  subscribe(cb: (s: MediaState) => void) {
    startAdvance();
    listeners.add(cb);
    cb(snapshot());
    return () => void listeners.delete(cb);
  },
  command(id: string, action: MediaAction) {
    const s = find(id);
    if (!s) return;
    if (action === "toggle") {
      s.position = pos(s);
      s.sampledAt = Date.now();
      s.playing = !s.playing;
      if (s.playing) currentId = s.id;
    } else if (action.startsWith("seek:")) {
      s.position = Math.max(0, Math.min(+action.slice(5), s.list[s.index].duration));
      s.sampledAt = Date.now();
    } else {
      skip(s, action === "next" ? 1 : -1);
    }
    emit();
  },
  /** Preview helper: add/remove a second app playing at the same time. */
  toggleSecondSource() {
    const i = sources.findIndex((s) => s.id === "Chrome");
    if (i >= 0) {
      sources.splice(i, 1);
      if (currentId === "Chrome") currentId = sources[0]?.id ?? null;
    } else {
      sources.push({ id: "Chrome", app: "Chrome", list: [PODCAST], index: 0, playing: true, position: 610, sampledAt: Date.now() });
    }
    emit();
  },
  /** Preview helper: a third app, to test crowded source stacks. */
  toggleThirdSource() {
    const i = sources.findIndex((s) => s.id === "VLC");
    if (i >= 0) sources.splice(i, 1);
    else sources.push({ id: "VLC", app: "VLC", list: [TRACKS[2]], index: 0, playing: false, position: 30, sampledAt: Date.now() });
    emit();
  },
  /** Showcase recorder: replace every source (tracks, artwork, who is playing). */
  stage(list: { id: string; app: string; tracks: typeof TRACKS; index?: number; playing?: boolean; position?: number; icon?: string }[], current?: string | null) {
    sources.splice(0, sources.length, ...list.map((l) => ({ id: l.id, app: l.app, list: l.tracks, index: l.index ?? 0, playing: l.playing ?? true, position: l.position ?? 0, sampledAt: Date.now(), icon: l.icon })));
    currentId = current === undefined ? (list[0]?.id ?? null) : current;
    emit();
  },
  hasSecondSource: () => sources.some((s) => s.id === "Chrome"),
  primaryId: () => sources[0]?.id,
};
