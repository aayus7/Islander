/**
 * Island AI relay (Cloudflare Worker).
 *
 * The app sends { deviceId, contents, systemInstruction } to POST /v1/ask.
 * We check fair-use limits, add the secret Gemini key, call Gemini's streaming API and
 * pipe the Server-Sent Events straight back. The key never reaches users.
 */
export interface Env {
  GEMINI_API_KEY: string;
  MODEL: string;
  DAILY_LIMIT_PER_DEVICE: string;
  GLOBAL_DAILY_LIMIT: string;
  LIMITS: KVNamespace;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/v1/ask") return json(404, { error: "not found" });

    let body: { deviceId?: string; contents?: unknown[]; systemInstruction?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "bad json" });
    }
    const deviceId = String(body.deviceId || "");
    if (!/^[a-f0-9]{16,64}$/.test(deviceId)) return json(400, { error: "bad device id" });
    if (!Array.isArray(body.contents) || body.contents.length === 0 || body.contents.length > 24) {
      return json(400, { error: "bad contents" });
    }
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
    // KV is eventually consistent: good enough for fair use, not for billing.
    await Promise.all([
      env.LIMITS.put(devKey, String(devCount + 1), { expirationTtl: 60 * 60 * 48 }),
      env.LIMITS.put(allKey, String(allCount + 1), { expirationTtl: 60 * 60 * 48 }),
    ]);

    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.MODEL}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: body.contents,
          systemInstruction: body.systemInstruction,
          tools: [{ google_search: {} }],
        }),
      },
    );
    if (!upstream.ok || !upstream.body) {
      return json(502, { error: "upstream", status: upstream.status });
    }
    return new Response(upstream.body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", ...CORS },
    });
  },
};
