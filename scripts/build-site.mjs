// After `vite build --config hero.vite.config.ts`: put the live island into the website.
// The site is served from a sub-path (aayus7.github.io/Islander/), so device clips load relatively.
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync("dist-hero/showcase/hero.html", "utf8").replaceAll("`/devices/", "`devices/");
writeFileSync("site/island.html", html);
console.log("site/island.html updated (" + Math.round(html.length / 1024) + " KB)");
