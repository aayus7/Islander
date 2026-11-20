// After `vite build --config hero.vite.config.ts`: put the live island into the website.
// - The site is served from a sub-path (aayus7.github.io/Islander/), so device clips load relatively.
// - The single-file build inlines every font subset (Latin, Cyrillic, Greek, Vietnamese…) as
//   base64. Written out as files instead, the browser downloads only the subsets a page uses
//   (their @font-face unicode-range says which), and caches them.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

let html = readFileSync("dist-hero/showcase/hero.html", "utf8").replaceAll("`/devices/", "`devices/");
mkdirSync("site/island-fonts", { recursive: true });
let n = 0;
html = html.replace(/url\(\s*["']?data:font\/woff2;base64,([A-Za-z0-9+/=]+)["']?\s*\)/g, (_, b64) => {
  const buf = Buffer.from(b64, "base64");
  const name = `inter-${createHash("sha1").update(buf).digest("hex").slice(0, 10)}.woff2`;
  writeFileSync(`site/island-fonts/${name}`, buf);
  n++;
  return `url(island-fonts/${name})`;
});
writeFileSync("site/island.html", html);
console.log(`site/island.html updated (${Math.round(html.length / 1024)} KB, ${n} fonts written to site/island-fonts/)`);
