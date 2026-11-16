# Island AI relay

Lets everyone use the island's AI without their own API key. Your Gemini key stays here.

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler kv namespace create LIMITS` → paste the id into `wrangler.toml`
4. `npx wrangler secret put GEMINI_API_KEY` (from https://aistudio.google.com/apikey — use a
   billing-enabled project for public release; on the free tier Google may use prompts to improve its products)
5. `npx wrangler deploy` → copy the `https://….workers.dev` URL into the island's
   Settings → AI → Relay URL (or bake it into the app's defaults before you ship).

Limits are in `wrangler.toml`: per-install daily questions and a global daily ceiling.
