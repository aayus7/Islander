// Screen recording (Controls → Screen Recording): a 3-second countdown in the island,
// then recording with a red rim; hover the island to pause or stop. Backed by screenrec.rs.
import { useEffect, useState } from "react";
import { isTauri } from "../bridge";
import { pushBanner } from "../island/modules/Banners";
import { call, on } from "./native";

export type RecPhase = "idle" | "countdown" | "starting" | "recording" | "paused" | "saving" | "error";

export interface RecState {
  phase: RecPhase;
  /** 3, 2, 1 during the countdown. */
  count: number;
  elapsedMs: number;
  error: string | null;
}

interface Native {
  state: "idle" | "recording" | "paused" | "saving" | "saved" | "error";
  elapsedMs: number;
  path: string | null;
  bytes: number | null;
  error: string | null;
}

let state: RecState = { phase: "idle", count: 0, elapsedMs: 0, error: null };
const subs = new Set<(s: RecState) => void>();
const set = (patch: Partial<RecState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f(state));
};
export const recActive = (s: RecState) => s.phase !== "idle" && s.phase !== "error";

let timers: number[] = [];
const clearTimers = () => {
  timers.forEach((t) => window.clearTimeout(t));
  timers = [];
};

export function fmtElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const sizeText = (b: number | null) => (b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

let wired = false;
let stoppedAt = 0;
function wire() {
  if (wired || !isTauri) return;
  wired = true;
  // A recording may already be running (the island reloaded mid-recording): pick it up.
  call<Native>("rec_status")
    .then((n) => {
      if ((n.state === "recording" || n.state === "paused") && state.phase === "idle") set({ phase: n.state, elapsedMs: n.elapsedMs });
    })
    .catch(() => {});
  on<Native>("rec://state", (n) => {
    if (n.state === "recording" || n.state === "paused") {
      // Late ticks right after Stop must not bring the recording UI back. Otherwise the
      // native side is the truth (this also picks a recording back up after a UI reload).
      if (state.phase === "saving" || Date.now() - stoppedAt < 1500) return;
      set({ phase: n.state, elapsedMs: n.elapsedMs });
    } else if (n.state === "saving") set({ phase: "saving", elapsedMs: n.elapsedMs });
    else if (n.state === "saved") {
      set({ phase: "idle", elapsedMs: 0 });
      savedBanner(n.path, n.elapsedMs, n.bytes);
    } else if (n.state === "error") fail(n.error ?? "Recording failed");
  });
}

function savedBanner(path: string | null, ms: number, bytes: number | null) {
  pushBanner({
    id: `rec-${Date.now()}`,
    app: "Screen Recording",
    title: "Screen recording saved",
    body: [fmtElapsed(ms), sizeText(bytes), "Click to show in Videos"].filter(Boolean).join(" · "),
    icon: null,
    glyph: "record",
    tint: "#3a3a3c",
    reveal: path ?? undefined,
    ttl: 7000,
  });
}

function fail(error: string) {
  clearTimers();
  set({ phase: "error", error, count: 0 });
  pushBanner({ id: `rec-err-${Date.now()}`, app: "Screen Recording", title: "Couldn't record the screen", body: error, icon: null, glyph: "record", tint: "#3a3a3c" });
  timers.push(window.setTimeout(() => set({ phase: "idle", error: null }), 400));
}

/** 3, 2, 1… then record (iPhone's Screen Recording). Tapping again during the countdown cancels. */
export function startRecording() {
  wire();
  if (state.phase !== "idle" && state.phase !== "error") return;
  clearTimers();
  set({ phase: "countdown", count: 3, elapsedMs: 0, error: null });
  [2, 1].forEach((n, i) => timers.push(window.setTimeout(() => set({ count: n }), (i + 1) * 1000)));
  timers.push(
    window.setTimeout(async () => {
      set({ phase: "starting", count: 0 });
      if (!isTauri) return mockRun();
      try {
        await call("rec_start");
        set({ phase: "recording" });
      } catch (e) {
        fail(String(e));
      }
    }, 3000),
  );
}

export function cancelCountdown() {
  if (state.phase !== "countdown") return;
  clearTimers();
  set({ phase: "idle", count: 0 });
}

export function pauseRecording() {
  if (state.phase !== "recording") return;
  set({ phase: "paused" });
  if (isTauri) void call("rec_pause");
}

export function resumeRecording() {
  if (state.phase !== "paused") return;
  set({ phase: "recording" });
  if (isTauri) void call("rec_resume");
}

export async function stopRecording() {
  if (state.phase === "countdown") return cancelCountdown();
  if (state.phase !== "recording" && state.phase !== "paused") return;
  set({ phase: "saving" });
  stoppedAt = Date.now();
  if (!isTauri) {
    clearTimers();
    window.setTimeout(() => {
      const ms = state.elapsedMs;
      set({ phase: "idle", elapsedMs: 0 });
      savedBanner(null, ms, 24_000_000);
    }, 700);
    return;
  }
  try {
    await call<string>("rec_stop");
  } catch (e) {
    fail(String(e));
  }
}

/** Browser preview: a pretend recording so the UI can be designed. */
function mockRun() {
  set({ phase: "recording", elapsedMs: 0 });
  const tick = () => {
    if (state.phase === "recording") set({ elapsedMs: state.elapsedMs + 250 });
    if (state.phase === "recording" || state.phase === "paused") timers.push(window.setTimeout(tick, 250));
  };
  tick();
}

export function useScreenRec() {
  const [s, setS] = useState(state);
  useEffect(() => {
    wire();
    subs.add(setS);
    setS(state);
    return () => void subs.delete(setS);
  }, []);
  return s;
}
