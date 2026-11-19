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
    // Quota errors carry the exact limit that was hit in their details (which metric,
    // which model, limit 0 = not on this plan at all).
    const why = (j?.error?.details ?? [])
      .flatMap((d: { violations?: { quotaMetric?: string; quotaId?: string; quotaDimensions?: Record<string, string>; quotaValue?: string }[] }) => d?.violations ?? [])
      .map((v: { quotaMetric?: string; quotaId?: string; quotaDimensions?: Record<string, string>; quotaValue?: string }) =>
        [v.quotaId || v.quotaMetric, v.quotaDimensions?.model, v.quotaValue != null ? `limit ${v.quotaValue}` : ""].filter(Boolean).join(" "),
      )
      .join("; ");
    return { msg: String(j?.error?.message || j?.message || "") + (why ? ` [${why}]` : ""), code: String(j?.error?.status || j?.error || "") };
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
  let relayTried = false;
  /**
   * Islander's free service (web lookups included). Returns the stream, or null if it's
   * unavailable — unless `final`, when its own message (daily limit, busy) is shown.
   */
  const tryRelay = async (final = false): Promise<Response | null> => {
    relayTried = true;
    const t0 = performance.now();
    // 20 s to *start* replying. Once it has, the answer may take longer (lookups, Google's
    // free tier); the stream's own keep-alives and idle check cover that part.
    const startBy = new AbortController();
    const startTimer = setTimeout(() => startBy.abort(), 20000);
    try {
      const r = await fetch(`${cfg.relayUrl.trim().replace(/\/+$/, "")}/v1/ask`, {
        method: "POST",
        signal: AbortSignal.any([signal, startBy.signal]),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: cfg.deviceId, contents, systemInstruction }),
      });
      clearTimeout(startTimer);
      log(`free service: HTTP ${r.status} after ${Math.round(performance.now() - t0)} ms`);
      if (r.ok && r.body) return r;
      const e = await errorText(r);
      lastErr = { ...e, status: r.status };
      if (final && e.code === "daily_limit") throw new AiError("daily_limit", e.msg);
      if (final && e.code === "busy") throw new AiError("busy", e.msg);
      return null;
    } catch (e) {
      clearTimeout(startTimer);
      if (e instanceof AiError || signal.aborted) throw e;
      log(`free service unreachable: ${String(e)}`);
      if (final) throw new AiError("network", "Islander's assistant didn't respond. Check your internet connection and try again.");
      return null;
    }
  };
  try {
    // Islander's free service first, for everyone: it looks things up on the web before
    // answering (a free Gemini key can't use Google Search any more, so a key alone answers
    // from old memory). Your own key is the backup if the service is down or today's free
    // limit is reached.
    if (cfg.relayUrl.trim()) {
      const rr = await tryRelay(!cfg.apiKey.trim());
      if (rr) {
        res = rr;
        used = { model: "relay", search: true };
      } else if (cfg.apiKey.trim()) {
        log("free service unavailable: using your own key");
      }
    }
    if (!res && cfg.apiKey.trim()) {
      // Keep Google Search if at all possible: try other search-capable models before
      // ever answering from memory (search isn't on the free tier for every model).
      const seen = new Set<string>();
      // Previous-generation models, pinned (the "-latest" aliases point at the newest one,
      // which is often out of free quota). Old saved names are mapped onto them.
      const LEGACY: Record<string, string> = {
        "gemini-flash-latest": "gemini-3.6-flash",
        "gemini-2.5-flash": "gemini-3.6-flash",
        "gemini-2.0-flash": "gemini-3.6-flash",
        "gemini-flash-lite-latest": "gemini-3.5-flash-lite",
        "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
      };
      const model = LEGACY[cfg.model.trim()] ?? cfg.model.trim();
      const other = model === "gemini-3.5-flash-lite" ? "gemini-3.6-flash" : "gemini-3.5-flash-lite";
      let searchRefused = false;
      // Your model with Google Search first; if Google won't search right now (quota),
      // the same model answers on its own; another model only if yours isn't available.
      let modelGone = false;
      const attempts = [
        { model, search: true },
        { model, search: false },
        { model: other, search: false, onlyIfGone: true },
      ].filter((a) => {
        const k = `${a.model}|${a.search}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // Never "think" for more than ~30 s in total, whatever Google is doing.
      const tAll = performance.now();
      for (const a of attempts) {
        if (a.search && searchRefused) continue; // the key has no Search quota: don't keep asking
        if ("onlyIfGone" in a && !modelGone) continue;
        if (performance.now() - tAll > 30000) {
          log("giving up: 30 s without an answer");
          break;
        }
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
            log(`× ${a.model}: ${(e as Error)?.name === "AbortError" ? "no response within 15 s" : `fetch failed: ${String(e)}`}`);
            // 599: our own timeout / network failure — move on rather than retrying this model.
            return new Response(JSON.stringify({ error: { message: "Gemini didn't respond in time." } }), { status: 599 });
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
        log(`${a.model}${a.search ? " +search" : ""} refused (${r.status}): ${e.msg.replace(/\s+/g, " ").slice(0, 600)}`);
        if (r.status === 404 || (r.status === 400 && /model/i.test(e.msg))) modelGone = true;
        // A bad key won't get better with another model: stop early.
        if (r.status === 401 || r.status === 403 || /api key/i.test(e.msg)) break;
        if (a.search && r.status === 429) {
          searchRefused = true;
          // Your key can't search, but Islander's free service can look things up:
          // use it instead of answering from memory.
          if (cfg.relayUrl.trim() && !relayTried) {
            log("search refused on your key: using Islander's free service (with web lookups)");
            const rr = await tryRelay();
            if (rr) {
              res = rr;
              used = { model: "relay", search: true };
              break;
            }
            // The free service is down or slow: answer with your key, without web search.
            log("free service failed: answering with your key (no web search)");
          }
        }
      }
    }
    if (!res && cfg.relayUrl.trim() && !relayTried && (!cfg.apiKey.trim() || lastErr.status === 429)) {
      const rr = await tryRelay(true);
      if (rr) {
        res = rr;
        used = { model: "relay", search: true };
      }
    } else if (!res && !cfg.apiKey.trim()) {
      if (cfg.relayUrl.trim()) throw new AiError("busy", lastErr.msg || "Islander's assistant is unavailable right now. Try again in a minute.");
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
    if (status === 404) throw new AiError("upstream", `Model "${cfg.model}" wasn't found. Try gemini-3.6-flash in Settings → AI.`);
    if (status === 429) throw new AiError("upstream", `Gemini refused for quota reasons.${google}`);
    if (status === 599) throw new AiError("network", "Gemini didn't answer in time. Check your internet connection and try again.");
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
      idle = setTimeout(() => rej(new AiError("network", "Gemini stopped responding. Try again.")), 20000);
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
      if (j?.error) {
        log(`stream error: ${String(j.error.message ?? "")}`);
        throw new AiError("busy", String(j.error.message || "The assistant couldn't answer. Try again."));
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

/** Tells the transcriber which language to expect, so a short English question isn't heard as Catalan. */
const transcribePrompt = (lang: string) =>
  `Transcribe this recording of someone asking a voice assistant a question. Their computer's language is ${lang}; they most likely spoke English${
    lang.toLowerCase().startsWith("en") ? "" : " or that language"
  }. Only write another language if the speech clearly is that language. Output only the exact words they said, with normal punctuation. No quotes, labels, translation or commentary. If there is no clear speech, output nothing.`;

/**
 * Speech to text for the mic button: the WAV (base64, 16 kHz mono) goes to Gemini —
 * directly with your own key, otherwise through Islander's free relay.
 */
export async function transcribe(wavB64: string, cfg: Pick<AiConfig, "apiKey" | "relayUrl" | "deviceId" | "log">, signal: AbortSignal): Promise<string> {
  const log = (m: string) => cfg.log?.(`[voice] ${m}`);
  const t0 = performance.now();
  const lang = navigator.language || "en-US";
  const clean = (s: string) => s.replace(/^["“]|["”]$/g, "").replace(/\s+/g, " ").trim();
  const key = cfg.apiKey.trim();
  const relay = cfg.relayUrl.trim().replace(/\/+$/, "");

  const viaKey = async (sig: AbortSignal): Promise<string> => {
    for (const model of ["gemini-3.5-flash-lite", "gemini-3.6-flash"]) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        signal: AbortSignal.any([sig, AbortSignal.timeout(15000)]),
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: "audio/wav", data: wavB64 } }, { text: transcribePrompt(lang) }] }],
          generationConfig: { temperature: 0 },
        }),
      });
      log(`${model}: HTTP ${r.status} in ${Math.round(performance.now() - t0)} ms`);
      if (r.ok) {
        const j = await r.json();
        return clean((j?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
      }
      if (r.status === 401 || r.status === 403) break;
    }
    throw new AiError("busy", "Your Gemini key couldn't transcribe this.");
  };

  const viaRelay = async (sig: AbortSignal): Promise<string> => {
    let r: Response;
    try {
      r = await fetch(`${relay}/v1/transcribe`, {
        method: "POST",
        signal: AbortSignal.any([sig, AbortSignal.timeout(20000)]),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: cfg.deviceId, audio: wavB64, lang }),
      });
    } catch (e) {
      if (sig.aborted) throw e;
      throw new AiError("network", "Can't reach the assistant. Check your internet connection.");
    }
    log(`relay: HTTP ${r.status} in ${Math.round(performance.now() - t0)} ms`);
    if (!r.ok) {
      const e = await errorText(r);
      if (e.code === "daily_limit") throw new AiError("daily_limit", e.msg);
      if (r.status === 404) throw new AiError("upstream", "Voice isn't switched on for the free assistant yet.");
      throw new AiError("busy", e.msg || "Couldn't understand the recording. Try again.");
    }
    const j = await r.json();
    return clean(String(j?.text ?? ""));
  };

  if (!key && !relay) throw new AiError("no_key", "Add a Gemini API key in Settings → AI to use voice.");
  if (!key) return viaRelay(signal);
  if (!relay) return viaKey(signal);

  // Both available: Islander's service first (Whisper, about a second). If it's slow
  // (> 4 s) or fails, your own key transcribes too; whichever answers first wins.
  const stopAll = new AbortController();
  const sig = AbortSignal.any([signal, stopAll.signal]);
  try {
    return await new Promise<string>((resolve, reject) => {
      let failures = 0;
      let backupStarted = false;
      const fail = (e: unknown) => {
        if (sig.aborted) return reject(e);
        if (++failures === 2) reject(e);
        else startBackup();
      };
      const startBackup = () => {
        if (backupStarted) return;
        backupStarted = true;
        log("asking your Gemini key too");
        viaKey(sig).then(resolve, fail);
      };
      viaRelay(sig).then(resolve, fail);
      const hedge = window.setTimeout(startBackup, 4000);
      sig.addEventListener("abort", () => clearTimeout(hedge));
    });
  } finally {
    stopAll.abort();
  }
}
