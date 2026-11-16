// Timer / stopwatch / focus (Pomodoro) engine. Lives outside React so it keeps
// running whichever tab is open, and is persisted so it survives restarts.
import { persistent, useStore } from "./persist";

export type ClockKind = "timer" | "stopwatch" | "focus";

export interface ClockState {
  kind: ClockKind;
  running: boolean;
  /** Epoch ms when the current run started (valid while running). */
  startedAt: number;
  /** ms accumulated before the current run. */
  banked: number;
  /** Timer length in ms. */
  timerMs: number;
  /** Focus: current phase and completed focus rounds. */
  phase: "focus" | "break";
  rounds: number;
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  /** Stopwatch laps (ms at lap time). */
  laps: number[];
  /** Set when a timer/phase finishes; the island shows a banner until dismissed. */
  doneAt: number;
  doneLabel: string;
}

const DEFAULT: ClockState = {
  kind: "timer",
  running: false,
  startedAt: 0,
  banked: 0,
  timerMs: 5 * 60_000,
  phase: "focus",
  rounds: 0,
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  laps: [],
  doneAt: 0,
  doneLabel: "",
};

export const clock = persistent<ClockState>("clock", DEFAULT);
export const useClock = () => useStore(clock);

export function elapsed(s: ClockState, now = Date.now()) {
  return s.banked + (s.running ? now - s.startedAt : 0);
}

/** Length of the current countdown (timer or focus phase), ms. */
export function totalMs(s: ClockState) {
  if (s.kind === "timer") return s.timerMs;
  if (s.kind === "focus") {
    if (s.phase === "focus") return s.focusMin * 60_000;
    return (s.rounds > 0 && s.rounds % 4 === 0 ? s.longBreakMin : s.breakMin) * 60_000;
  }
  return 0;
}

/** Remaining ms for countdowns; elapsed for the stopwatch. */
export function display(s: ClockState, now = Date.now()) {
  return s.kind === "stopwatch" ? elapsed(s, now) : Math.max(0, totalMs(s) - elapsed(s, now));
}

/** Something worth showing as a live activity while collapsed. */
export function isActive(s: ClockState) {
  return s.running || s.banked > 0;
}

export const clockActions = {
  setKind(kind: ClockKind) {
    clock.set((s) => (s.kind === kind ? s : { ...s, kind, running: false, banked: 0, laps: [], phase: "focus" }));
  },
  setTimer(ms: number) {
    clock.set((s) => ({ ...s, kind: "timer", timerMs: ms, running: false, banked: 0 }));
  },
  start() {
    clock.set((s) => (s.running ? s : { ...s, running: true, startedAt: Date.now(), doneAt: 0 }));
  },
  pause() {
    clock.set((s) => (s.running ? { ...s, running: false, banked: elapsed(s) } : s));
  },
  toggle() {
    clock.get().running ? clockActions.pause() : clockActions.start();
  },
  reset() {
    clock.set((s) => ({ ...s, running: false, banked: 0, laps: [], ...(s.kind === "focus" ? { phase: "focus" as const, rounds: 0 } : {}) }));
  },
  lap() {
    clock.set((s) => ({ ...s, laps: [elapsed(s), ...s.laps].slice(0, 20) }));
  },
  /** Skip to the next focus phase. */
  skip() {
    clock.set((s) => nextPhase(s, false));
  },
  dismissDone() {
    clock.set((s) => ({ ...s, doneAt: 0 }));
  },
};

function nextPhase(s: ClockState, finished: boolean): ClockState {
  const rounds = s.phase === "focus" && finished ? s.rounds + 1 : s.rounds;
  const phase = s.phase === "focus" ? "break" : "focus";
  return {
    ...s,
    phase,
    rounds,
    banked: 0,
    startedAt: Date.now(),
    running: finished ? true : s.running,
    doneAt: finished ? Date.now() : s.doneAt,
    doneLabel: finished ? (phase === "break" ? "Time for a break" : "Back to focus") : s.doneLabel,
  };
}

/* ---- the tick: finishes countdowns even when no clock UI is mounted ---- */

function chime() {
  try {
    const ctx = new AudioContext();
    const notes = [880, 1174.66, 1567.98];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 1);
    });
    setTimeout(() => ctx.close(), 1600);
  } catch {
    /* no audio */
  }
}

let started = false;
export function startClockTicker() {
  if (started || typeof window === "undefined") return;
  started = true;
  setInterval(() => {
    const s = clock.get();
    if (!s.running || s.kind === "stopwatch") return;
    if (elapsed(s) < totalMs(s)) return;
    if (s.kind === "timer") {
      clock.set({ ...s, running: false, banked: 0, doneAt: Date.now(), doneLabel: "Timer done" });
    } else {
      clock.set(nextPhase(s, true));
    }
    chime();
  }, 250);
}

export function fmtClock(ms: number, opts: { tenths?: boolean } = {}) {
  const total = Math.max(0, ms);
  const secs = opts.tenths ? Math.floor(total / 1000) : Math.ceil(total / 1000 - 1e-6);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const base = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return opts.tenths ? `${base}.${Math.floor((total % 1000) / 100)}` : base;
}
