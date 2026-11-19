// The AI conversation lives here, outside the panel, so switching tabs or collapsing
// the island never resets it — even an answer that's still streaming keeps going.
import { useSyncExternalStore } from "react";
import { ask, AiError, tidy, transcribe, type AiConfig, type AiMeta, type Turn } from "./ai";
import { call, on } from "./native";
import { quickAnswer } from "./quick";

export type AiStatus = "idle" | "thinking" | "streaming" | "error";
export type AiView = "search" | "answer";
/** Mic button: off → listening (recording) → transcribing → the words are asked. */
export type AiVoice = "off" | "listening" | "transcribing";

export interface AiSessionState {
  q: string;
  chunks: string[];
  status: AiStatus;
  error: AiError | null;
  view: AiView;
  meta: AiMeta | null;
  history: Turn[];
  /** The question that failed, so "Try again" can resend it. */
  lastQ: string;
  voice: AiVoice;
  /** Short message shown in the search field after a voice attempt ("Didn't catch that"). */
  voiceNote: string;
}

let state: AiSessionState = { q: "", chunks: [], status: "idle", error: null, view: "search", meta: null, history: [], lastQ: "", voice: "off", voiceNote: "" };
const listeners = new Set<() => void>();
let abort: AbortController | null = null;

function set(patch: Partial<AiSessionState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useAiSession() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/* ---- voice ---- */
let voiceAbort: AbortController | null = null;
let voiceOff: (() => void) | null = null;
let voiceTimer = 0;
let dictating = false;

function stopVoiceWatch() {
  voiceOff?.();
  voiceOff = null;
  clearInterval(voiceTimer);
}

function note(msg: string) {
  set({ voice: "off", voiceNote: msg });
  window.setTimeout(() => state.voiceNote === msg && set({ voiceNote: "" }), 2600);
}

export const aiSession = {
  /**
   * Start listening. Windows' own dictation types your words into the field as you speak;
   * the mic recording runs alongside for the waveform, the pause detection and — if Windows
   * dictation isn't available on this PC — as audio for Gemini to transcribe instead.
   */
  async listen(cfg: Omit<AiConfig, "onMeta">) {
    if (state.voice !== "off") return;
    abort?.abort();
    set({ voice: "listening", voiceNote: "", view: "search", q: "", status: "idle", error: null });
    try {
      await call("mic_start");
    } catch (e) {
      cfg.log?.(`[voice] mic failed: ${String(e)}`);
      set({ voice: "off", view: "answer", status: "error", error: new AiError("network", String(e)) });
      return;
    }
    if ((state.voice as AiVoice) !== "listening") return void call("mic_cancel"); // cancelled while the mic opened
    cfg.log?.("[voice] listening");
    const t0 = Date.now();
    let floor = 1;
    let heard = false;
    let lastLoud = Date.now();
    let peak = 0;
    dictating = false;
    // Live words from Windows dictation (started in parallel; failure just means fallback).
    const offPartial = on<string>("speech://partial", (t) => {
      if (state.voice !== "listening") return;
      heard = true;
      lastLoud = Date.now();
      set({ q: t });
    });
    call("speech_start").then(
      () => {
        if ((state.voice as AiVoice) !== "listening") return void call("speech_cancel");
        dictating = true;
        cfg.log?.("[voice] Windows dictation on");
      },
      (e) => cfg.log?.(`[voice] Windows dictation unavailable, will use Gemini: ${String(e)}`),
    );
    const offLevel = on<number>("mic://level", (v) => {
      if (Date.now() - t0 < 300) floor = Math.min(floor, v);
      peak = Math.max(peak, v);
      // "Speech" = clearly above the room's own noise (measured in the first moments).
      const loud = v > Math.max(0.3, Math.min(floor, 0.45) + 0.12);
      if (loud) {
        if (!heard) cfg.log?.(`[voice] speech detected (level ${v.toFixed(2)}, room ${floor.toFixed(2)})`);
        heard = true;
        lastLoud = Date.now();
      }
    });
    voiceOff = () => {
      offLevel();
      offPartial();
    };
    voiceTimer = window.setInterval(() => {
      const now = Date.now();
      const why = heard && now - lastLoud > 1300 ? "pause" : !heard && now - t0 > 8000 ? "no clear speech" : now - t0 > 30000 ? "30 s limit" : "";
      if (!why) return;
      cfg.log?.(`[voice] stop (${why}; peak ${peak.toFixed(2)}, room ${floor.toFixed(2)})`);
      aiSession.stopListening(cfg);
    }, 100);
  },
  /** Finish: send the dictated words as a typed question (or transcribe the audio as a fallback). */
  async stopListening(cfg: Omit<AiConfig, "onMeta">) {
    if (state.voice !== "listening") return;
    stopVoiceWatch();
    const ac = new AbortController();
    voiceAbort = ac;
    try {
      const [spoken, wav] = await Promise.all([dictating ? call<string>("speech_stop") : Promise.resolve(""), call<string>("mic_stop")]);
      dictating = false;
      if (ac.signal.aborted) return;
      const typed = (spoken || "").trim();
      if (typed) {
        cfg.log?.(`[voice] dictated: ${typed.slice(0, 120)}`);
        set({ voice: "off", q: typed });
        return void aiSession.submit(cfg);
      }
      if (!wav) return note("Didn't catch that");
      set({ voice: "transcribing" });
      const text = await transcribe(wav, cfg, ac.signal);
      if (ac.signal.aborted) return;
      cfg.log?.(`[voice] heard: ${text.slice(0, 120)}`);
      if (!text) return note("Didn't catch that");
      set({ voice: "off", q: text });
      aiSession.submit(cfg);
    } catch (e) {
      if (ac.signal.aborted) return;
      cfg.log?.(`[voice] ${String((e as Error)?.message ?? e)}`);
      set({ voice: "off", view: "answer", status: "error", error: e instanceof AiError ? e : new AiError("network", "Couldn't understand the recording. Try again.") });
    }
  },
  /** Called when the panel closes: an open mic is cancelled; a transcription carries on. */
  dropMic() {
    if (state.voice === "listening") aiSession.cancelListening();
  },
  cancelListening() {
    if (state.voice === "off") return;
    stopVoiceWatch();
    voiceAbort?.abort();
    voiceAbort = null;
    void call("mic_cancel");
    if (dictating) void call("speech_cancel");
    dictating = false;
    set({ voice: "off", q: "" });
  },
  setQuery: (q: string) => set({ q, voiceNote: "" }),
  setView: (view: AiView) => set({ view }),
  cancel() {
    abort?.abort();
    if (state.status === "thinking" || state.status === "streaming") set({ status: "idle" });
  },
  /** Start a fresh conversation. */
  reset() {
    abort?.abort();
    aiSession.cancelListening();
    set({ q: "", chunks: [], status: "idle", error: null, view: "search", meta: null, history: [], lastQ: "" });
  },
  /** Leave an error/answer and type a new question. */
  askAgain(seed = "") {
    set({ q: seed, view: "search", error: state.status === "error" ? null : state.error, status: state.status === "error" ? "idle" : state.status });
  },
  /** Resend the question that failed. */
  retry(cfg: Omit<AiConfig, "onMeta">) {
    if (!state.lastQ) return;
    set({ q: state.lastQ });
    return aiSession.submit(cfg);
  },
  async submit(cfg: Omit<AiConfig, "onMeta">) {
    const text = state.q.trim();
    if (!text || state.status === "thinking") return;
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    const history = [...state.history, { role: "user" as const, text }];
    // Maths and unit conversions are answered instantly on this PC, like Spotlight.
    const instant = quickAnswer(text);
    if (instant) {
      set({ history: [...history, { role: "model", text: instant }], q: "", lastQ: "", chunks: [instant], error: null, meta: null, status: "idle", view: "answer" });
      return;
    }
    set({ history, q: "", lastQ: text, chunks: [], error: null, meta: null, status: "thinking", view: "answer" });
    cfg.log?.(`[ai] ask: key=${cfg.apiKey.trim() ? "yes" : "no"} relay=${cfg.relayUrl.trim() ? "yes" : "no"} model=${cfg.model}`);
    // When Google says it's overloaded, quietly wait and try again before showing an error.
    const waits = [2500, 6000];
    for (let attempt = 0; ; attempt++) {
      let full = "";
      try {
        for await (const part of ask(history, { ...cfg, onMeta: (meta) => abort === ac && set({ meta }) }, ac.signal)) {
          if (abort !== ac) return;
          full += part;
          set({ status: "streaming", chunks: [...state.chunks, tidy(part)] });
        }
        if (!full.trim()) throw new AiError("upstream", "Gemini sent an empty answer. Try asking again.");
        set({ history: [...history, { role: "model", text: full }], status: "idle", lastQ: "" });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError" || abort !== ac) return;
        const busy = e instanceof AiError && e.code === "busy";
        if (busy && !full && attempt < waits.length) {
          cfg.log?.(`ai: overloaded, retrying in ${waits[attempt]}ms`);
          await new Promise((r) => setTimeout(r, waits[attempt]));
          if (abort !== ac) return;
          continue;
        }
        cfg.log?.(`[ai] error: ${(e as Error)?.message}`);
        set({
          history: history.slice(0, -1), // drop the unanswered question
          error: e instanceof AiError ? e : new AiError("network", "Something went wrong. Try again."),
          status: "error",
        });
        return;
      }
    }
  },
};
