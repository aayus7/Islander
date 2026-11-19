// Nearby sharing (LocalSend) state for the island: devices around, transfers in flight
// and requests waiting for Accept / Decline. Backed by localsend.rs.
import { useEffect, useState } from "react";
import { isTauri } from "../bridge";
import { call, on, send } from "./native";

export interface Peer {
  fingerprint: string;
  alias: string;
  deviceModel: string | null;
  deviceType: "mobile" | "desktop" | "web" | "headless" | "server" | string;
  ip: string;
  port: number;
  https: boolean;
}

export interface Incoming {
  id: string;
  alias: string;
  deviceModel: string | null;
  deviceType: string;
  files: { name: string; size: number; fileType: string; preview: string | null }[];
  total: number;
}

export interface Transfer {
  id: string;
  outgoing: boolean;
  peer: string;
  name: string;
  path: string;
  files: number;
  doneFiles: number;
  sent: number;
  total: number;
  state: "waiting" | "sending" | "done" | "declined" | "failed" | "cancelled";
  error: string | null;
  paths: string[];
}

interface State {
  peers: Peer[];
  incoming: Incoming[];
  /** Latest transfer per device alias (outgoing ones drive the device bubbles). */
  byPeer: Record<string, Transfer>;
  /** Phones can't reach this PC (Windows Firewall): sending works, receiving doesn't. */
  blocked: boolean;
}

const MOCK_PEERS: Peer[] = [
  { fingerprint: "a", alias: "Aayush's iPhone", deviceModel: "iPhone", deviceType: "mobile", ip: "192.168.1.20", port: 53317, https: true },
  { fingerprint: "b", alias: "Pixel 8", deviceModel: "Google", deviceType: "mobile", ip: "192.168.1.21", port: 53317, https: true },
  { fingerprint: "c", alias: "Work Laptop", deviceModel: "Windows", deviceType: "desktop", ip: "192.168.1.30", port: 53317, https: true },
];

let state: State = { peers: isTauri ? [] : MOCK_PEERS, incoming: [], byPeer: {}, blocked: !isTauri && location.search.includes("nbblocked") };
const subs = new Set<(s: State) => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((s) => s(state));
};
const clearTimers: Record<string, number> = {};

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  call<Peer[]>("localsend_peers", undefined, MOCK_PEERS).then((peers) => set({ peers })).catch(() => {});
  on<Peer[]>("localsend://peers", (peers) => set({ peers }));
  if (isTauri) call<{ blocked?: boolean }>("localsend_info").then((i) => set({ blocked: !!i?.blocked })).catch(() => {});
  on<boolean>("localsend://blocked", (blocked) => set({ blocked }));
  on<Incoming>("localsend://incoming", (req) => set({ incoming: [...state.incoming.filter((r) => r.id !== req.id), req] }));
  on<string>("localsend://incoming-closed", (id) => set({ incoming: state.incoming.filter((r) => r.id !== id) }));
  on<Transfer>("localsend://transfer", (t) => {
    set({ byPeer: { ...state.byPeer, [t.peer]: t } });
    // Finished states fade back to the plain bubble after a moment.
    window.clearTimeout(clearTimers[t.peer]);
    if (t.state !== "waiting" && t.state !== "sending") {
      clearTimers[t.peer] = window.setTimeout(() => {
        if (state.byPeer[t.peer]?.id !== t.id) return;
        const next = { ...state.byPeer };
        delete next[t.peer];
        set({ byPeer: next });
      }, t.state === "done" ? 2600 : 4200);
    }
  });
}

export function useNearby() {
  const [s, setS] = useState(state);
  useEffect(() => {
    wire();
    subs.add(setS);
    setS(state);
    return () => void subs.delete(setS);
  }, []);
  return s;
}

/** While the Shelf is open: say hello now and every few seconds, so phones that just opened LocalSend appear. */
export function useNearbyScan(active: boolean) {
  useEffect(() => {
    if (!active) return;
    send("localsend_scan");
    const t = window.setInterval(() => send("localsend_scan"), 4000);
    return () => window.clearInterval(t);
  }, [active]);
}

export async function sendTo(peer: Peer, paths: string[]): Promise<string | null> {
  try {
    // Show "Waiting…" at once; the backend's first update replaces it.
    set({ byPeer: { ...state.byPeer, [peer.alias]: { id: "pending", outgoing: true, peer: peer.alias, name: "", path: "", files: paths.length, doneFiles: 0, sent: 0, total: 0, state: "waiting", error: null, paths: [] } } });
    if (!isTauri) {
      mockSend(peer, paths.length);
      return null;
    }
    await call<string>("localsend_send", { fingerprint: peer.fingerprint, paths });
    return null;
  } catch (e) {
    const msg = String(e);
    set({ byPeer: { ...state.byPeer, [peer.alias]: { id: "err", outgoing: true, peer: peer.alias, name: "", path: "", files: 0, doneFiles: 0, sent: 0, total: 0, state: "failed", error: msg, paths: [] } } });
    window.setTimeout(() => {
      const next = { ...state.byPeer };
      if (next[peer.alias]?.id === "err") delete next[peer.alias];
      set({ byPeer: next });
    }, 4200);
    return msg;
  }
}

export function respond(id: string, accept: boolean) {
  set({ incoming: state.incoming.filter((r) => r.id !== id) });
  send("localsend_respond", { id, accept });
}

export function cancelTransfer(id: string) {
  send("localsend_cancel", { id });
}

/** Browser preview only: pretend to send. */
function mockSend(peer: Peer, files: number) {
  const total = 24_000_000;
  let sent = 0;
  const tick = () => {
    sent = Math.min(total, sent + 2_400_000);
    const done = sent >= total;
    set({ byPeer: { ...state.byPeer, [peer.alias]: { id: "mock", outgoing: true, peer: peer.alias, name: "photo.jpg", path: "", files, doneFiles: done ? files : 0, sent, total, state: done ? "done" : "sending", error: null, paths: [] } } });
    if (!done) window.setTimeout(tick, 160);
  };
  window.setTimeout(tick, 900);
}

/** Browser preview / harness: show an incoming request. */
export function mockIncoming() {
  set({
    incoming: [
      {
        id: "mock-in",
        alias: "Aayush's iPhone",
        deviceModel: "iPhone",
        deviceType: "mobile",
        files: [
          { name: "IMG_2041.HEIC", size: 2_400_000, fileType: "image/heic", preview: null },
          { name: "IMG_2042.HEIC", size: 2_100_000, fileType: "image/heic", preview: null },
          { name: "Boarding pass.pdf", size: 180_000, fileType: "application/pdf", preview: null },
        ],
        total: 4_680_000,
      },
    ],
  });
}

/** Let phones through Windows Firewall (Windows asks first). Returns an error message, or null. */
export async function allowIncoming(): Promise<string | null> {
  if (!isTauri) {
    set({ blocked: false });
    return null;
  }
  try {
    await call("localsend_allow_firewall");
    set({ blocked: false });
    return null;
  } catch (e) {
    return String(e).includes("cancelled") ? "Windows didn't allow it" : "Couldn't change Windows Firewall";
  }
}
