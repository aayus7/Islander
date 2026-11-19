/**
 * Islander AI relay (Cloudflare Worker, free plan).
 *
 * Lets everyone use Search or Ask with no API key of their own. The app sends
 * { deviceId, contents, systemInstruction } to POST /v1/ask and gets back a Gemini-style
 * Server-Sent-Events stream.
 *
 * Live answers without paying for Google's "Grounding with Google Search": Gemini (free
 * tier) is given two tools it can call — web_search and sports_scores — and this worker
 * runs them against free, keyless sources:
 *   - Wikipedia (current officeholders, facts, recent events)
 *   - Google News RSS (headlines from the last days)
 *   - DuckDuckGo Instant Answers (quick facts)
 *   - ESPN's public scoreboards (NBA, NFL, NHL, MLB, football leagues…)
 * The results go back to Gemini, which writes the answer; the sources are sent to the app
 * in the same format Google's grounding uses, so the island lists them as usual.
 */
export interface Env {
  GEMINI_API_KEY: string;
  MODEL: string;
  DAILY_LIMIT_PER_DEVICE: string;
  GLOBAL_DAILY_LIMIT: string;
  LIMITS: KVNamespace;
  /** Optional: Tavily search key (free plan, 1,000 searches a month) for better lookups. */
  TAVILY_API_KEY?: string;
  /** Tavily searches per day (default 32 ≈ the free monthly plan). */
  TAVILY_DAILY?: string;
  /** "on" only if the Gemini key's project can use Google Search grounding (not on the free tier). */
  GOOGLE_SEARCH?: string;
  /** Cloudflare Workers AI (speech-to-text with Whisper, free daily allowance). */
  AI?: { run(model: string, input: unknown): Promise<any> };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const UA = "IslanderRelay/1.0 (https://github.com/aayus7/islander)";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

type Part = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: unknown };
type Content = { role: string; parts: Part[] };
type Source = { uri: string; title: string };

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "web_search",
        description:
          "Look things up on the web: current events and news, who currently holds a position (presidents, prime ministers, CEOs), recent releases, prices, anything that may have changed recently or that you're not sure about. Returns Wikipedia summaries, recent news headlines with dates, and quick facts.",
        parameters: {
          type: "OBJECT",
          properties: { query: { type: "STRING", description: "A short web search query, e.g. 'Prime Minister of Nepal'." } },
          required: ["query"],
        },
      },
      {
        name: "sports_scores",
        description: "Live and recent game scores and schedules (yesterday, today) for a league.",
        parameters: {
          type: "OBJECT",
          properties: {
            league: {
              type: "STRING",
              enum: ["nba", "wnba", "nfl", "nhl", "mlb", "ncaaf", "ncaamb", "mls", "epl", "laliga", "seriea", "bundesliga", "ligue1", "ucl"],
            },
          },
          required: ["league"],
        },
      },
    ],
  },
];

const ESPN: Record<string, string> = {
  nba: "basketball/nba",
  wnba: "basketball/wnba",
  ncaamb: "basketball/mens-college-basketball",
  nfl: "football/nfl",
  ncaaf: "football/college-football",
  nhl: "hockey/nhl",
  mlb: "baseball/mlb",
  mls: "soccer/usa.1",
  epl: "soccer/eng.1",
  laliga: "soccer/esp.1",
  seriea: "soccer/ita.1",
  bundesliga: "soccer/ger.1",
  ligue1: "soccer/fra.1",
  ucl: "soccer/uefa.champions",
};

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, cf: { cacheTtl: 120 }, signal: AbortSignal.timeout(4500) } as RequestInit);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
async function getText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": UA }, cf: { cacheTtl: 300 }, signal: AbortSignal.timeout(4500) } as RequestInit);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
}
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

const STOP = new Set(
  "a an the is are was were be been am do does did of in on at to for from by with about and or me my i you your we us it its this that these those what whats which who whom whose when where why how can could would should will shall may might please tell show give know yet right now currently today tonight still just any some there here".split(" "),
);
/** "who won the last formula 1 race?" → "winner last formula 1 race". */
function keywords(q: string): string {
  const t = q
    .toLowerCase()
    .replace(/\bpm\b/g, "prime minister")
    .replace(/\bpotus\b/g, "president united states")
    .replace(/\bf1\b/g, "formula 1")
    .replace(/\bnba\b/g, "nba")
    .replace(/\bwho won\b/g, "winner")
    .replace(/\bwho wins\b/g, "winner")
    .replace(/\bis (.+?) out\b/g, "$1 release")
    .replace(/[^\p{L}\p{N}\s.+#-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
  return t.join(" ").trim();
}

/** An RSS feed's items (Bing web / Bing News / Google News all speak RSS). */
function rssItems(xml: string) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const tag = (t: string) => decode(m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "").replace(/<[^>]+>/g, "");
    return { title: tag("title"), link: tag("link"), desc: tag("description"), date: tag("pubDate"), source: tag("source") || tag("News:Source") };
  });
}
const shortDate = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toUTCString().slice(5, 16) : "";
};
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * Free, keyless lookups, all at once (each gives up after ~4.5 s):
 *   - Bing web results (title + snippet), the closest thing to "googling it"
 *   - Bing News and Google News headlines, with dates (what happened lately)
 *   - Wikipedia summaries (who holds an office, release dates, background)
 *   - DuckDuckGo instant answers
 * Everything is labelled with its date where one exists, so the model can tell old from new.
 */
async function webSearch(query: string, sources: Source[]): Promise<string> {
  const q = encodeURIComponent(query.slice(0, 200));
  // Search engines read questions literally ("who won…" → the Korean currency), so the
  // web search runs on both the question and its keywords ("winner formula 1 race").
  const kw = keywords(query);
  const web = (async () => {
    const raw = query.replace(/\bpm\b/gi, "prime minister").replace(/\bf1\b/gi, "formula 1");
    const qs = kw && kw !== raw.toLowerCase() ? [kw, raw] : [raw];
    const lists = await Promise.allSettled(qs.map((x) => getText(`https://www.bing.com/search?format=rss&count=8&setlang=en-US&cc=US&q=${encodeURIComponent(x)}`).then(rssItems)));
    const seen = new Set<string>();
    const items = lists
      .flatMap((r) => (r.status === "fulfilled" ? r.value.slice(0, 5) : []))
      .filter((i) => i.link && !seen.has(i.link) && seen.add(i.link) && !/dictionary|merriam-webster|thefreedictionary|vocabulary\.com|wiktionary/i.test(i.link))
      .slice(0, 7);
    items.slice(0, 3).forEach((i) => sources.push({ uri: i.link, title: i.title || host(i.link) }));
    return items.length ? "Web results:\n" + items.map((i) => `- ${i.title} (${host(i.link)}${i.date ? ", " + shortDate(i.date) : ""}): ${i.desc.slice(0, 320)}`).join("\n") : "";
  })();
  const nq = encodeURIComponent(kw || query);
  const news = (async () => {
    const [bing, google] = await Promise.allSettled([
      getText(`https://www.bing.com/news/search?format=rss&setlang=en-US&cc=US&q=${nq}`).then(rssItems),
      getText(`https://news.google.com/rss/search?q=${nq}&hl=en-US&gl=US&ceid=US:en`).then(rssItems),
    ]);
    const all = [...(bing.status === "fulfilled" ? bing.value : []), ...(google.status === "fulfilled" ? google.value : [])]
      .filter((i) => i.title)
      .sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0));
    const seen = new Set<string>();
    const items = all.filter((i) => {
      const k = i.title.toLowerCase().slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 7);
    items.slice(0, 2).forEach((i) => i.link && sources.push({ uri: i.link, title: i.source || host(i.link) || i.title }));
    return items.length ? "News, newest first:\n" + items.map((i) => `- ${shortDate(i.date) || "undated"}: ${i.title}${i.desc ? " — " + i.desc.slice(0, 220) : ""}`).join("\n") : "";
  })();
  const wiki = (async () => {
    const s = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${nq}&srlimit=2&format=json&origin=*`);
    const titles: string[] = (s?.query?.search ?? []).map((x: { title: string }) => x.title);
    if (!titles.length) return "";
    const e = await getJson(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exchars=1200&redirects=1&format=json&origin=*&titles=${encodeURIComponent(titles.join("|"))}`,
    );
    const pages = Object.values(e?.query?.pages ?? {}) as { title: string; extract?: string; fullurl?: string; touched?: string }[];
    return pages
      .filter((p) => p.extract)
      .map((p) => {
        if (p.fullurl) sources.push({ uri: p.fullurl, title: `Wikipedia: ${p.title}` });
        return `Wikipedia — ${p.title} (edited ${String(p.touched ?? "").slice(0, 10)}):\n${p.extract}`;
      })
      .join("\n\n");
  })();
  const ddg = (async () => {
    const d = await getJson(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`);
    const bits = [d?.Answer, d?.AbstractText].filter(Boolean);
    if (d?.AbstractURL && d?.AbstractText) sources.push({ uri: d.AbstractURL, title: d.AbstractSource || "DuckDuckGo" });
    return bits.length ? `Quick facts: ${bits.join(" ")}` : "";
  })();
  const rs = await Promise.allSettled([web, news, wiki, ddg]);
  const parts = rs.map((r) => (r.status === "fulfilled" ? r.value : "")).filter(Boolean);
  return (parts.join("\n\n") || "No results found.").slice(0, 10000);
}

const COINS: Record<string, string> = {
  bitcoin: "bitcoin", btc: "bitcoin", ethereum: "ethereum", eth: "ethereum", ether: "ethereum", solana: "solana", sol: "solana",
  dogecoin: "dogecoin", doge: "dogecoin", xrp: "ripple", ripple: "ripple", cardano: "cardano", ada: "cardano", litecoin: "litecoin", ltc: "litecoin",
  bnb: "binancecoin", tether: "tether", usdt: "tether",
};
function cryptoCoin(q: string): string | null {
  for (const w of q.toLowerCase().split(/[^a-z]+/)) if (COINS[w]) return COINS[w];
  return null;
}
const COINBASE: Record<string, string> = { bitcoin: "BTC", ethereum: "ETH", solana: "SOL", dogecoin: "DOGE", ripple: "XRP", cardano: "ADA", litecoin: "LTC", tether: "USDT" };
/** Live crypto price: Coinbase's public spot price (no key), CoinGecko as a backup. */
async function cryptoPrice(id: string, sources: Source[]): Promise<string> {
  const sym = COINBASE[id];
  if (sym) {
    const got = await Promise.allSettled(["USD", "CAD", "EUR", "INR"].map((cur) => getJson(`https://api.coinbase.com/v2/prices/${sym}-${cur}/spot`).then((d) => [cur, Number(d?.data?.amount)] as const)));
    const px = got.flatMap((g) => (g.status === "fulfilled" && Number.isFinite(g.value[1]) ? [g.value] : []));
    if (px.length) {
      sources.push({ uri: `https://www.coinbase.com/price/${id}`, title: "Coinbase" });
      const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });
      return `Live ${id} price right now (Coinbase spot): ${px.map(([c, n]) => `${fmt(n)} ${c}`).join(", ")}.`;
    }
  }
  const d = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd,cad,eur,inr&include_24hr_change=true&include_last_updated_at=true`);
  const p = d?.[id];
  if (!p?.usd) return "";
  sources.push({ uri: `https://www.coingecko.com/en/coins/${id}`, title: "CoinGecko" });
  const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 4 : 2 });
  return `Live ${id} price (CoinGecko): $${fmt(p.usd)} USD, C$${fmt(p.cad)} CAD, €${fmt(p.eur)} EUR, ₹${fmt(p.inr)} INR; 24h change ${Number(p.usd_24h_change ?? 0).toFixed(2)}%.`;
}

/**
 * Tavily (search API made for AI answers): used when the relay has a TAVILY_API_KEY secret.
 * Its free plan is 1,000 searches a month, so a daily budget keeps it free; past that,
 * the keyless lookups above carry on alone.
 */
async function tavily(env: Env, query: string, sources: Source[]): Promise<string> {
  if (!env.TAVILY_API_KEY) return "";
  const k = `tv:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await env.LIMITS.get(k)) || 0);
  if (used >= Number(env.TAVILY_DAILY || "32")) return "";
  await env.LIMITS.put(k, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, search_depth: "basic", max_results: 5, include_answer: true }),
  });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  const j: any = await r.json();
  const res = (j?.results ?? []) as { title: string; url: string; content: string; published_date?: string }[];
  res.slice(0, 4).forEach((x) => sources.push({ uri: x.url, title: x.title || host(x.url) }));
  const lines = res.map((x) => `- ${x.title} (${host(x.url)}${x.published_date ? ", " + shortDate(x.published_date) : ""}): ${String(x.content).slice(0, 500)}`);
  return [j?.answer ? `Search summary: ${j.answer}` : "", lines.length ? "Top results:\n" + lines.join("\n") : ""].filter(Boolean).join("\n");
}

/** Which scoreboard a question is about, if any. */
function sportsLeague(q: string): string | null {
  const t = q.toLowerCase();
  if (!/\b(score|scores|game|games|match|matches|won|win|lost|beat|result|results|playing|play tonight|standings)\b/.test(t) && !/\b(nba|nfl|nhl|mlb|wnba|mls|epl)\b/.test(t)) return null;
  const map: [RegExp, string][] = [
    [/\bwnba\b/, "wnba"],
    [/\bnba\b|lakers|celtics|warriors|knicks|raptors|bulls|heat|nets|76ers|sixers|bucks|nuggets|suns|mavericks|mavs|clippers|spurs|thunder|cavaliers|cavs|timberwolves|grizzlies|pelicans|kings|hawks|hornets|magic|pacers|pistons|rockets|jazz|blazers|wizards/, "nba"],
    [/\bnfl\b|chiefs|eagles|cowboys|49ers|niners|packers|bills|ravens|steelers|patriots|giants|jets|dolphins|bengals|browns|broncos|raiders|chargers|seahawks|rams|bears|lions|vikings|saints|falcons|panthers|buccaneers|bucs|commanders|titans|colts|jaguars|texans|cardinals/, "nfl"],
    [/\bnhl\b|maple leafs|leafs|canadiens|habs|bruins|rangers|oilers|flames|canucks|senators|penguins|flyers|blackhawks|red wings|avalanche|lightning|golden knights|kraken|islanders|devils|hurricanes|panthers/, "nhl"],
    [/\bmlb\b|yankees|dodgers|blue jays|red sox|mets|cubs|astros|braves|phillies|padres/, "mlb"],
    [/premier league|\bepl\b|arsenal|chelsea|liverpool|man city|manchester|tottenham|spurs fc|newcastle|aston villa/, "epl"],
    [/la ?liga|real madrid|barcelona|atletico/, "laliga"],
    [/champions league|\bucl\b/, "ucl"],
    [/\bmls\b|inter miami|toronto fc/, "mls"],
  ];
  for (const [re, lg] of map) if (re.test(t)) return lg;
  return null;
}

async function sportsScores(league: string, sources: Source[]): Promise<string> {
  const path = ESPN[league];
  if (!path) return "Unknown league.";
  const day = (offset: number) => {
    const d = new Date(Date.now() + offset * 86400_000);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  };
  const out: string[] = [];
  for (const [label, date] of [
    ["Yesterday", day(-1)],
    ["Today", day(0)],
  ] as const) {
    try {
      const s = await getJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${date}`);
      const games = (s?.events ?? []).map((ev: any) => {
        const comp = ev?.competitions?.[0];
        const teams = (comp?.competitors ?? [])
          .map((c: any) => `${c?.team?.displayName ?? "?"} ${c?.score ?? ""}`.trim())
          .join(" vs ");
        return `- ${teams} — ${ev?.status?.type?.detail ?? ""}`;
      });
      out.push(`${label} (${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}):\n${games.length ? games.join("\n") : "- no games"}`);
    } catch {
      /* skip */
    }
  }
  sources.push({ uri: `https://www.espn.com/${path.split("/")[1]}/scoreboard`, title: "ESPN scoreboard" });
  return out.join("\n\n") || "Scores unavailable right now.";
}

/* ------------------------------------------------------------------ gemini */

async function gemini(env: Env, stream: boolean, body: unknown, model = env.MODEL, timeoutMs = 25000): Promise<Response> {
  const fn = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${fn}`, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
}

function sse(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/* ------------------------------------------------------------------ voice */

/**
 * POST /v1/transcribe { deviceId, audio } — audio is a base64 16 kHz mono WAV (≤ 30 s)
 * from the island's mic button. Returns { text }. Has its own daily allowance, so voice
 * questions don't use up the per-device question limit twice.
 */
/** Same wording as the app's own: expect English (or the PC's language) so short questions aren't misheard. */
const transcribePrompt = (lang: string) =>
  `Transcribe this recording of someone asking a voice assistant a question. Their computer's language is ${lang}; they most likely spoke English${
    lang.toLowerCase().startsWith("en") ? "" : " or that language"
  }. Only write another language if the speech clearly is that language. Output only the exact words they said, with normal punctuation. No quotes, labels, translation or commentary. If there is no clear speech, output nothing.`;

/** Primes Whisper with names people ask about, so "GTA 6" isn't heard as "ZDA6". */
const VOCAB =
  "A question asked to a voice assistant, for example: When is GTA 6 coming out? What's the weather in Toronto? Who won the Raptors game? Play Spotify. What's on YouTube, Netflix, Discord, iPhone, PlayStation, Xbox, Nintendo Switch, ChatGPT, Gemini, NBA, NFL, NHL, Premier League?";

const b64bytes = (audio: string) => {
  const bin = atob(audio);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const cleanTranscript = (t: unknown) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  // Well-known "heard nothing" hallucinations.
  return /^(thank you\.?|thanks for watching[.!]?|you\.?|\.+)$/i.test(s) ? "" : s;
};

/** Deepgram Nova-3 on Workers AI: fast and good with names and brands. null if unavailable. */
async function nova(env: Env, audio: string, lang: string): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const r = await env.AI.run("@cf/deepgram/nova-3", {
      audio: { body: new Response(b64bytes(audio)).body, contentType: "audio/wav" },
      smart_format: true,
      punctuate: true,
      ...(lang.toLowerCase().startsWith("en") ? { language: "en" } : { detect_language: true }),
    });
    const t = r?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof t !== "string") {
      console.log("nova: unexpected output", JSON.stringify(r).slice(0, 300));
      return null;
    }
    return cleanTranscript(t);
  } catch (e) {
    console.log("nova failed", String(e));
    return null;
  }
}

/** Whisper on Workers AI. null if unavailable. */
async function whisper(env: Env, audio: string, lang: string): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio, task: "transcribe", ...(lang.toLowerCase().startsWith("en") ? { language: "en" } : {}), initial_prompt: VOCAB });
    return cleanTranscript(r?.text);
  } catch (e) {
    console.log("whisper failed", String(e));
    return null;
  }
}

async function transcribe(req: Request, env: Env): Promise<Response> {
  let body: { deviceId?: string; audio?: string; lang?: string; engine?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad json" });
  }
  const deviceId = String(body.deviceId || "");
  const audio = String(body.audio || "");
  if (!/^[a-f0-9]{16,64}$/.test(deviceId)) return json(400, { error: "bad device id" });
  if (!audio || audio.length > 1_400_000 || !/^[A-Za-z0-9+/=]+$/.test(audio.slice(0, 64))) return json(413, { error: "audio too long" });

  const day = new Date().toISOString().slice(0, 10);
  const devKey = `v:${day}:${deviceId}`;
  const allKey = `g:${day}`;
  const [devUsed, allUsed] = await Promise.all([env.LIMITS.get(devKey), env.LIMITS.get(allKey)]);
  if (Number(devUsed || 0) >= Number(env.DAILY_LIMIT_PER_DEVICE)) {
    return json(429, { error: "daily_limit", message: "You've reached today's free voice limit. It resets at midnight UTC." });
  }
  if (Number(allUsed || 0) >= Number(env.GLOBAL_DAILY_LIMIT)) {
    return json(503, { error: "busy", message: "The assistant is very busy today. Please try again tomorrow." });
  }
  await env.LIMITS.put(devKey, String(Number(devUsed || 0) + 1), { expirationTtl: 60 * 60 * 48 });

  const lang = String(body.lang || "en-US").replace(/[^A-Za-z-]/g, "").slice(0, 12) || "en-US";
  // Test switch: { engine: "nova" | "whisper" | "gemini" } forces one engine.
  const only = String((body as { engine?: string }).engine || "");
  // Whisper (with the name hints) was the most accurate in testing; Nova is only a backup.
  if (!only || only === "whisper") {
    const t = await whisper(env, audio, lang);
    if (t !== null && (t || only)) return json(200, { text: t, engine: "whisper" });
  }
  if (!only || only === "nova") {
    const t = await nova(env, audio, lang);
    if (t !== null && (t || only)) return json(200, { text: t, engine: "nova" });
  }

  const r = await gemini(env, false, {
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: "audio/wav", data: audio } },
          {
            text: transcribePrompt(String(body.lang || "en-US").replace(/[^A-Za-z-]/g, "").slice(0, 12) || "en-US"),
          },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  });
  if (!r.ok) return json(r.status === 429 ? 503 : 502, { error: r.status === 429 ? "busy" : "upstream", message: "Couldn't understand the recording right now. Try again." });
  const j: any = await r.json();
  const text = ((j?.candidates?.[0]?.content?.parts ?? []) as Part[]).map((p) => p.text ?? "").join("").trim();
  return json(200, { text });
}

/* ------------------------------------------------------------------ handler */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return json(200, { ok: true, service: "islander-relay" });
    if (req.method === "POST" && url.pathname === "/v1/transcribe") return transcribe(req, env);
    if (req.method !== "POST" || url.pathname !== "/v1/ask") return json(404, { error: "not found" });

    let body: { deviceId?: string; contents?: Content[]; systemInstruction?: { parts?: Part[] } };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "bad json" });
    }
    const deviceId = String(body.deviceId || "");
    if (!/^[a-f0-9]{16,64}$/.test(deviceId)) return json(400, { error: "bad device id" });
    if (!Array.isArray(body.contents) || body.contents.length === 0 || body.contents.length > 24) return json(400, { error: "bad contents" });
    if (JSON.stringify(body.contents).length > 24_000) return json(413, { error: "question too long" });

    // ---- fair use: per device and global, per UTC day ----
    const day = new Date().toISOString().slice(0, 10);
    const devKey = `d:${day}:${deviceId}`;
    const allKey = `g:${day}`;
    const [devUsed, allUsed] = await Promise.all([env.LIMITS.get(devKey), env.LIMITS.get(allKey)]);
    const devCount = Number(devUsed || 0);
    const allCount = Number(allUsed || 0);
    if (devCount >= Number(env.DAILY_LIMIT_PER_DEVICE)) {
      return json(429, { error: "daily_limit", message: "You've reached today's free limit. It resets at midnight UTC." });
    }
    if (allCount >= Number(env.GLOBAL_DAILY_LIMIT)) {
      return json(503, { error: "busy", message: "The assistant is very busy today. Please try again tomorrow." });
    }
    await Promise.all([
      env.LIMITS.put(devKey, String(devCount + 1), { expirationTtl: 60 * 60 * 48 }),
      env.LIMITS.put(allKey, String(allCount + 1), { expirationTtl: 60 * 60 * 48 }),
    ]);

    // The user's own date and time (the app puts "Now: …, time zone …" in its instructions);
    // UTC would make a Toronto evening "tomorrow".
    const sysText = (body.systemInstruction?.parts ?? []).map((p) => p.text ?? "").join(" ");
    const today = sysText.match(/Now: (.{8,80}?), time zone ([\w/+-]{1,40})/)?.slice(1, 3).join(", ") ?? new Date().toUTCString().slice(0, 22) + " UTC";
    const sys = {
      parts: [
        ...(body.systemInstruction?.parts ?? []),
        {
          text: `Today is ${today}. Your own knowledge stops some time ago: for anything that may have changed (news, who currently holds an office or job, scores, prices, releases, "latest"/"current"/"now" questions) call web_search or sports_scores first and answer from what they return. Prefer the newest information; mention dates when it matters.`,
        },
      ],
    };
    const contents: Content[] = [...body.contents];

    // Reply at once and do the work inside the stream: Gemini's free tier plus web lookups
    // can take a while, and a silent connection makes the app give up. A comment line every
    // few seconds keeps it alive; a failure arrives as {"error":{...}} in the stream.
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const ping = setInterval(() => w.write(enc.encode(": working\n\n")).catch(() => {}), 3000);
    const fail = (message: string) => w.write(enc.encode(sse({ error: { code: "busy", message } })));
    (async () => {
      await w.write(enc.encode(": started\n\n"));
      try {
        const why: string[] = [];
        const dbg = !!(body as { debug?: boolean }).debug;
        // 0) Best case: Gemini searches Google itself (free daily allowance on the relay's
        //    key). Runs alongside our own lookups; if Google says no (quota), we pause it
        //    for a while and answer from our lookups instead.
        const gsKey = `nogs:${day}`;
        const grounded: Promise<{ text: string; gm: any } | null> = env.GOOGLE_SEARCH !== "on" || (await env.LIMITS.get(gsKey))
          ? Promise.resolve(null)
          : (async () => {
              try {
                const r = await gemini(env, false, { contents, systemInstruction: sys, tools: [{ google_search: {} }] }, env.MODEL, 9000);
                if (!r.ok) {
                  const t = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
                  why.push(`google-search: ${r.status} ${t}`);
                  if (r.status === 429) await env.LIMITS.put(gsKey, "1", { expirationTtl: 900 });
                  return null;
                }
                const j: any = await r.json();
                const c = j?.candidates?.[0];
                const t = ((c?.content?.parts ?? []) as Part[]).filter((p: any) => !p.thought).map((p) => p.text ?? "").join("");
                const gm = c?.groundingMetadata;
                if (!t.trim() || !gm?.groundingChunks?.length) {
                  why.push(`google-search: ${t.trim() ? "answered without searching" : "empty"}`);
                  return null;
                }
                return { text: t, gm };
              } catch (e) {
                why.push(`google-search: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
                return null;
              }
            })();

        // 1) Look things up straight away (no "should I search?" round trip — on Gemini's
        //    free tier each call can take seconds). The question itself is the query; for a
        //    short follow-up, the previous question gives it context.
        const userTexts = contents.filter((c) => c.role === "user").map((c) => (c.parts ?? []).map((p) => p.text ?? "").join(" ").trim());
        const lastQ = userTexts[userTexts.length - 1] ?? "";
        // Borrow the previous question only for a real follow-up ("and when is it out?",
        // "what about Pixel?"), never for a new short question ("canada pm?").
        const followUp = /^(and|but|also|so|what about|how about|then)\b|\b(it|its|it's|that|this|those|these|they|them|their|he|him|his|she|her|there|same one)\b/i.test(lastQ);
        const query = (followUp && lastQ.split(/\s+/).length < 8 && userTexts.length > 1 ? `${userTexts[userTexts.length - 2]} ${lastQ}` : lastQ).slice(0, 200);
        const sources: Source[] = [];
        const lookups: Promise<string>[] = [webSearch(query, sources).then((r) => `Web results for "${query}":\n${r}`)];
        lookups.unshift(tavily(env, query, sources).then((r) => (r ? `Search engine results for "${query}":\n${r}` : ""), (e) => (why.push(String(e?.message ?? e)), "")));
        const coin = cryptoCoin(query);
        if (coin) lookups.push(cryptoPrice(coin, sources));
        const league = sportsLeague(query);
        if (league) lookups.push(sportsScores(league, sources).then((r) => `${league.toUpperCase()} scores:\n${r}`));
        const cap = new Promise<string[]>((res) => setTimeout(() => res([]), 5500));
        const foundP = Promise.race([Promise.allSettled(lookups).then((rs) => rs.map((r) => (r.status === "fulfilled" ? r.value : ""))), cap]).then((x) => x.filter(Boolean).join("\n\n"));
        const g = await grounded;
        if (g) {
          if (dbg) await w.write(enc.encode(sse({ debug: { today, query, used: "google-search" } })));
          await w.write(enc.encode(sse({ candidates: [{ groundingMetadata: g.gm }] })));
          await w.write(enc.encode(sse({ candidates: [{ content: { parts: [{ text: g.text }], role: "model" } }], modelVersion: `${env.MODEL}+google` })));
          return;
        }
        const found = await foundP;

        const uniq = [...new Map(sources.map((s) => [s.uri, s])).values()].slice(0, 6);
        if (dbg) await w.write(enc.encode(sse({ debug: { today, query, found, why } })));
        if (found) await w.write(enc.encode(sse({ candidates: [{ groundingMetadata: { webSearchQueries: [query], groundingChunks: uniq.map((s) => ({ web: s })) } }] })));

        const last = contents[contents.length - 1];
        const asked: Content[] = found
          ? [
              ...contents.slice(0, -1),
              {
                role: "user",
                parts: [
                  ...(last?.parts ?? []),
                  {
                    text: `\n\n[Fresh information looked up just now (today is ${today}). It is newer than your training: trust it over what you remember, prefer the newest dated items, and judge "already happened" vs "upcoming" against today's date. Use it only if it's relevant:]\n${found}\n\n[Answer my question above directly in the first sentence, then the key detail. If the information above doesn't settle it, answer from what you know and say it may have changed. Never say "not specified" or mention "provided information" or this note.]`,
                  },
                ],
              },
            ]
          : contents;

        // 2) Answer. Google's models get overloaded ("high demand", 503) or rate-limited
        //    (429) at times, so try them in turn; each gets a fair but bounded time.
        // Gemini first while it's healthy (short timeout); Cloudflare's own models
        // (Llama, on the same free account) answer when Google is overloaded.
        let text = "";
        let used = "";
        const viaGemini = async (m: string, ms: number) => {
          const r = await gemini(env, false, { contents: asked, systemInstruction: sys }, m, ms);
          if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 120)}`);
          const j: any = await r.json();
          const t = ((j?.candidates?.[0]?.content?.parts ?? []) as Part[]).filter((p: any) => !p.thought).map((p) => p.text ?? "").join("");
          if (!t.trim()) throw new Error(`empty (finish ${j?.candidates?.[0]?.finishReason ?? "?"})`);
          return t;
        };
        const viaCloudflare = async (m: string, ms: number) => {
          if (!env.AI) throw new Error("no Workers AI binding");
          const messages = [
            { role: "system", content: sys.parts.map((p) => p.text ?? "").join("\n") },
            ...asked.map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: (c.parts ?? []).map((p) => p.text ?? "").join("") })),
          ];
          const r: any = await Promise.race([
            env.AI.run(m, { messages, max_tokens: 900, temperature: 0.4 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
          ]);
          const t = String(r?.response ?? r?.result?.response ?? "");
          if (!t.trim()) throw new Error("empty");
          return t;
        };
        // Race: Gemini starts; if it hasn't answered in 3.5 s, Llama starts too and the
        // first good answer wins. Only if both fail do the backups run.
        const attempt = async (name: string, run: () => Promise<string>) => {
          try {
            return { name, text: await run() };
          } catch (e) {
            why.push(`${name}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
            throw e;
          }
        };
        try {
          const first = await new Promise<{ name: string; text: string }>((resolve, reject) => {
            let failed = 0;
            let llamaStarted = false;
            const onFail = () => {
              if (++failed === 2) reject(new Error("both failed"));
              else startLlama();
            };
            const startLlama = () => {
              if (llamaStarted) return;
              llamaStarted = true;
              attempt("llama-3.3-70b", () => viaCloudflare("@cf/meta/llama-3.3-70b-instruct-fp8-fast", 15000)).then(resolve, onFail);
            };
            attempt(env.MODEL, () => viaGemini(env.MODEL, 12000)).then(resolve, onFail);
            setTimeout(startLlama, 3500);
          });
          text = first.text;
          used = first.name;
        } catch {
          for (const [name, run] of [
            ["gemini-3.6-flash", () => viaGemini("gemini-3.6-flash", 10000)],
            ["llama-4-scout", () => viaCloudflare("@cf/meta/llama-4-scout-17b-16e-instruct", 15000)],
          ] as [string, () => Promise<string>][]) {
            try {
              text = (await attempt(name, run)).text;
              used = name;
              break;
            } catch {
              /* next */
            }
          }
        }
        if (!text.trim()) {
          console.log("ask failed:", why.join(" | "));
          return void (await w.write(enc.encode(sse({ error: { code: "busy", message: "Google's AI is overloaded right now. Try again in a minute.", detail: why.join(" | ") } }))));
        }
        if (why.length) console.log(`answered with ${used} after:`, why.join(" | "));
        if (dbg) await w.write(enc.encode(sse({ debug: { used, why } })));
        await w.write(enc.encode(sse({ candidates: [{ content: { parts: [{ text }], role: "model" } }], modelVersion: used })));
      } catch (e) {
        await fail("The assistant took too long. Try again.").catch(() => {});
      } finally {
        clearInterval(ping);
        await w.close().catch(() => {});
      }
    })();
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...CORS } });
  },
};
