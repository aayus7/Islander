// The AI conversation lives here, outside the panel, so switching tabs or collapsing
// the island never resets it — even an answer that's still streaming keeps going.
import { useSyncExternalStore } from "react";
import { ask, AiError, tidy, type AiConfig, type AiMeta, type Turn } from "./ai";
import { quickAnswer } from "./quick";

export type AiStatus = "idle" | "thinking" | "streaming" | "error";
export type AiView = "search" | "answer";

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
}

let state: AiSessionState = { q: "", chunks: [], status: "idle", error: null, view: "search", meta: null, history: [], lastQ: "" };
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

export const aiSession = {
  setQuery: (q: string) => set({ q }),
  setView: (view: AiView) => set({ view }),
  cancel() {
    abort?.abort();
    if (state.status === "thinking" || state.status === "streaming") set({ status: "idle" });
  },
  /** Start a fresh conversation. */
  reset() {
    abort?.abort();
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
