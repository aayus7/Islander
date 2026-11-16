// Gemini client for "Search or Ask".
// Two ways to reach Gemini:
//  - Your own API key (Settings → AI): calls Google directly from your PC.
//  - The relay (Settings → AI → Relay URL, or a built-in default for releases): no key
//    needed; the relay holds the key and applies fair-use limits.

export interface Turn {
  role: "user" | "model";
  text: string;
}

export interface AiConfig {
  apiKey: string;
  relayUrl: string;
  model: string;
  deviceId: string;
  /** Called when we know whether the answer was checked against Google Search. */
  onMeta?(m: AiMeta): void;
  /** Trace each step (shows in the app's console window). */
  log?(msg: string): void;
}

export interface AiSource {
  title: string;
  uri: string;
}

export interface AiMeta {
  /** The request had Google Search available (false = fallback without search). */
  searchEnabled: boolean;
  /** Gemini actually searched (it returned search queries / sources). */
  searched: boolean;
  sources: AiSource[];
  model: string;
}

export class AiError extends Error {
  constructor(public code: "no_key" | "daily_limit" | "busy" | "network" | "upstream" | "blocked", message: string) {
    super(message);
  }
}

function systemPrompt() {
  const now = new Date();
  return [
    "You are the assistant in a Dynamic Island on a Windows PC: think Siri, or Google's AI Overview but shorter.",
    "Lead with the direct answer. Use one or two short sentences, at most about 35 words in total.",
    "Plain text only: no markdown, no headings, no lists, no links, no preamble, no follow-up questions.",
    "Only give more detail or a short list if the user explicitly asks for it.",
    "Your own knowledge is out of date. Before answering anything that can change over time (who holds a position, news, prices, scores, weather, releases, schedules, 'latest' anything) you MUST run Google Search and answer from the results, not from memory.",
    `Now: ${now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}, time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`,
  ].join(" ");
}

/** Keep Siri-style plain text even if the model slips into markdown. */
export function tidy(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(\S.+?)\*(?=\s|$)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/`([^`]+)`/g, "$1");
}

/** Read Google's (or the relay's) error message from a failed response. */
async function errorText(res: Response): Promise<{ msg: string; code: string }> {
  try {
    const j = await res.clone().json();
    return { msg: String(j?.error?.message || j?.message || ""), code: String(j?.error?.status || j?.error || "") };
  } catch {
    try {
      return { msg: (await res.text()).slice(0, 300), code: "" };
    } catch {
      return { msg: "", code: "" };
    }
  }
}

/**
 * Ask Gemini; yields text chunks as they stream in.
 * With your own key, tries progressively simpler setups if Google refuses one
 * (some models / the Search tool have no free-tier quota on some keys):
 *   1. your model + Google Search  2. your model alone  3. Flash-Lite alone
 */
export async function* ask(history: Turn[], cfg: AiConfig, signal: AbortSignal): AsyncGenerator<string> {
  const log = (m: string) => cfg.log?.(`[ai] ${m}`);
  // Browser preview only: a canned streamed answer so the UI can be designed without a key.
  if (!("__TAURI_INTERNALS__" in window) && !cfg.apiKey.trim() && !cfg.relayUrl.trim()) {
    const demo =
      "I'm your island's assistant, powered by Gemini. I can answer questions, look things up on the web, and help you get things done without leaving what you're working on.";
    await new Promise((r) => setTimeout(r, 900));
    for (const w of demo.split(/(?<= )/)) {
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 35));
      yield w;
    }
    return;
  }
  const contents = history.slice(-10).map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
  const systemInstruction = { parts: [{ text: systemPrompt() }] };

  let res: Response | null = null;
  let used = { model: cfg.model, search: true };
  let lastErr = { msg: "", code: "", status: 0 };
  try {
    if (cfg.apiKey.trim()) {
      // Keep Google Search if at all possible: try other search-capable models before
      // ever answering from memory (search isn't on the free tier for every model).
      const seen = new Set<string>();
      const attempts = [
        { model: cfg.model, search: true },
        { model: "gemini-flash-lite-latest", search: true },
        { model: "gemini-flash-latest", search: true },
        { model: "gemini-2.5-flash", search: true },
        { model: cfg.model, search: false },
      ].filter((a) => {
        const k = `${a.model}|${a.search}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const a of attempts) {
        // Each try gets 15 s to start answering; then we move on instead of hanging.
        const call = async (): Promise<Response> => {
          const ac = new AbortController();
          const onOuter = () => ac.abort();
          signal.addEventListener("abort", onOuter);
          const timer = setTimeout(() => ac.abort(), 15000);
          const t0 = performance.now();
          log(`→ ${a.model}${a.search ? " +search" : ""}`);
          try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.model)}:streamGenerateContent?alt=sse`, {
              method: "POST",
              signal: ac.signal,
              headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey.trim() },
              body: JSON.stringify({ contents, systemInstruction, ...(a.search ? { tools: [{ google_search: {} }] } : {}) }),
            });
            log(`← ${a.model}: HTTP ${r.status} after ${Math.round(performance.now() - t0)} ms`);
            return r;
          } catch (e) {
            if (signal.aborted) throw e;
            log(`× ${a.model}: no response within 15 s`);
            return new Response(JSON.stringify({ error: { message: "timed out" } }), { status: 504 });
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onOuter);
          }
        };
        // Google's servers being briefly overloaded (500/503/504) is common: retry quickly
        // with backoff before moving on to the next model.
        let r = await call();
        for (const wait of [400, 1100]) {
          if (r.ok || ![500, 502, 503, 504].includes(r.status)) break;
          console.warn(`Gemini ${a.model} busy (${r.status}), retrying in ${wait}ms`);
          await sleep(wait);
          r = await call();
        }
        if (r.ok && r.body) {
          res = r;
          used = a;
          break;
        }
        const e = await errorText(r);
        lastErr = { ...e, status: r.status };
        console.warn(`Gemini ${a.model}${a.search ? " +search" : ""} → ${r.status}: ${e.msg}`);
        // A bad key won't get better with another model: stop early.
        if (r.status === 401 || r.status === 403 || /api key/i.test(e.msg)) break;
      }
    } else if (cfg.relayUrl.trim()) {
      const r = await fetch(`${cfg.relayUrl.trim().replace(/\/+$/, "")}/v1/ask`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: cfg.deviceId, contents, systemInstruction }),
      });
      if (r.ok && r.body) res = r;
      else {
        const e = await errorText(r);
        lastErr = { ...e, status: r.status };
        if (e.code === "daily_limit") throw new AiError("daily_limit", e.msg);
        if (e.code === "busy") throw new AiError("busy", e.msg);
      }
    } else {
      throw new AiError("no_key", "Add a Gemini API key in Settings → AI to start asking.");
    }
  } catch (e) {
    if (e instanceof AiError || (e as Error).name === "AbortError") throw e;
    throw new AiError("network", "Can't reach Gemini. Check your internet connection.");
  }

  if (!res || !res.body) {
    const { msg, status } = lastErr;
    const google = msg ? ` Google says: "${msg.split("\n")[0].slice(0, 220)}"` : "";
    if (status === 400 && /api key/i.test(msg)) throw new AiError("no_key", "That API key doesn't work. Check it in Settings → AI.");
    if (status === 401 || status === 403) throw new AiError("no_key", `That API key isn't allowed to use Gemini.${google}`);
    if (status === 404) throw new AiError("upstream", `Model "${cfg.model}" wasn't found. Try gemini-flash-latest in Settings → AI.`);
    if (status === 429) throw new AiError("upstream", `Gemini refused for quota reasons.${google}`);
    if ([500, 502, 503, 504].includes(status)) throw new AiError("busy", "Gemini's servers are overloaded right now. Try again in a moment.");
    throw new AiError("upstream", `Gemini returned an error (${status}).${google}`);
  }

  // Server-Sent Events: lines of "data: {json}".
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let gotText = false;
  const sources = new Map<string, AiSource>();
  let searched = false;
  const report = () => cfg.onMeta?.({ searchEnabled: used.search, searched, sources: [...sources.values()], model: used.model });
  report();
  let chunksSeen = 0;
  const tStream = performance.now();
  for (;;) {
    // If the stream goes silent for 25 s, give up rather than "thinking" forever.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, rej) => {
      idle = setTimeout(() => rej(new AiError("busy", "Gemini stopped responding. Try again.")), 25000);
    });
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await Promise.race([reader.read(), silent]);
    } catch (e) {
      log(`stream stalled after ${chunksSeen} chunks`);
      reader.cancel().catch(() => {});
      throw e;
    } finally {
      clearTimeout(idle);
    }
    const { value, done } = step;
    if (done) {
      log(`done: ${chunksSeen} chunks, text=${gotText}, searched=${searched}, ${Math.round(performance.now() - tStream)} ms`);
      break;
    }
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const cand = j?.candidates?.[0];
      const gm = cand?.groundingMetadata;
      if (gm) {
        if ((gm.webSearchQueries?.length ?? 0) > 0 || (gm.groundingChunks?.length ?? 0) > 0) searched = true;
        for (const c of gm.groundingChunks ?? []) {
          const web = c?.web;
          if (web?.uri && !sources.has(web.uri)) sources.set(web.uri, { title: String(web.title || ""), uri: String(web.uri) });
        }
        report();
      }
      const parts: any[] = cand?.content?.parts ?? [];
      chunksSeen++;
      for (const p of parts) {
        if (typeof p.text === "string" && !p.thought) {
          gotText = true;
          yield p.text;
        }
      }
      if (!gotText && (cand?.finishReason === "SAFETY" || j?.promptFeedback?.blockReason)) {
        throw new AiError("blocked", "Gemini declined to answer that one.");
      }
    }
  }
}
