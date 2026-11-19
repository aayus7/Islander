// One-time setup + deploy for the Islander AI relay (run by deploy-relay.bat).
// Creates the KV store for fair-use limits (first time only), stores your Gemini key as
// a secret on Cloudflare (never in the app), deploys, and saves the relay's URL to
// relay-url.txt so it can be built into Islander.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd, opts = {}) => execSync(cmd, { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", ...opts });
const toml = () => readFileSync("wrangler.toml", "utf8");

if (toml().includes("PASTE_KV_NAMESPACE_ID_HERE")) {
  console.log("\nCreating the fair-use counter store (KV)...");
  const out = run("npx wrangler kv namespace create LIMITS");
  const id = out.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1] ?? out.match(/"id":\s*"([0-9a-f]{32})"/)?.[1];
  if (!id) {
    console.log(out);
    throw new Error("Couldn't read the KV id from wrangler's output (shown above).");
  }
  writeFileSync("wrangler.toml", toml().replace("PASTE_KV_NAMESPACE_ID_HERE", id));
  console.log("KV store ready:", id);
}

const secrets = (() => {
  try {
    return run("npx wrangler secret list");
  } catch {
    return "";
  }
})();
if (!secrets.includes("GEMINI_API_KEY")) {
  console.log("\nPaste your Gemini API key (from https://aistudio.google.com/apikey) when asked:");
  spawnSync("npx wrangler secret put GEMINI_API_KEY", { stdio: "inherit", shell: true });
}

console.log("\nDeploying...");
let out = "";
try {
  out = run("npx wrangler deploy");
} catch (e) {
  out = String(e.stdout ?? "") + String(e.stderr ?? "");
  if (/workers\.dev subdomain/i.test(out)) {
    console.log(
      "\nOne more step in Cloudflare: pick your free workers.dev address.\n" +
        "Open https://dash.cloudflare.com → Workers & Pages → (you'll be asked to choose a subdomain,\n" +
        "e.g. 'islander') → save it, then run deploy-relay.bat again.\n",
    );
    process.exit(1);
  }
  throw e;
}
console.log(out);
const url = out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
if (!url) throw new Error("Deployed, but couldn't find the URL in the output above.");
writeFileSync("../relay-url.txt", url + "\n");
console.log(`\nRelay is live at ${url}  (saved to relay-url.txt)`);
