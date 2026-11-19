# Islander AI relay

Islander's free AI service: lets everyone use Search or Ask, typed or spoken, with no API key of their
own. It runs on Cloudflare's free plan.

## What it does

**`POST /v1/ask`**: answers a question.
1. Looks up fresh information straight away, with a 5 s limit: Wikipedia, Google News headlines and
   DuckDuckGo instant answers, plus ESPN scoreboards when the question is about a game.
2. Answers with **Gemini** (`MODEL` in `wrangler.toml`, Gemini's free tier). If Gemini hasn't answered
   within 3.5 s, **Llama 3.3 70B** on Cloudflare Workers AI starts too, and the first good answer wins.
   If both fail, Gemini 3.6 Flash and then Llama 4 Scout are tried.
3. Replies at once as a Server-Sent-Events stream, with a keep-alive every 3 s while it works. Sources come
   first, in the shape of Google's grounding metadata. Failures arrive as `{"error": {...}}` in the stream.

**`POST /v1/transcribe`**: turns a voice question into text. The body is
`{ deviceId, audio (base64 16 kHz mono WAV, ≤ 30 s), lang }`.
Uses **Whisper large-v3 turbo** on Workers AI, primed with common names so "GTA 6" isn't heard as
"ZDA6". Falls back to Deepgram Nova-3, then Gemini.

## Limits

- Per install, per UTC day: `DAILY_LIMIT_PER_DEVICE` questions, and the same number of voice clips
  counted separately.
- Everyone combined: `GLOBAL_DAILY_LIMIT`.
- Cloudflare's free plan: 100,000 requests a day, and a daily Workers AI allowance (enough for a few
  hundred voice questions and Llama answers). Past that, the service falls back to Gemini.
- Gemini's free tier has its own per-minute and per-day limits, shared by all users. At busy times
  Google also returns "high demand" errors, which is why Llama is there.

## Deploy

Double-click `deploy-relay.bat` in the project folder. The first time, it installs everything, opens a
browser to sign in to Cloudflare, creates the counter store, asks for your Gemini key once (stored as a
Cloudflare secret, never in the app), deploys, and saves the URL to `relay-url.txt`. After that, running
it again just republishes the latest code.

Bindings (`wrangler.toml`): `LIMITS` (KV, daily counters), `AI` (Workers AI), `GEMINI_API_KEY` (secret).
