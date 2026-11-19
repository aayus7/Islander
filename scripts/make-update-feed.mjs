// Writes release/latest.json — the update feed Islander checks — from the installer and
// its signature that `tauri build` just made. Upload latest.json together with the
// installer to a new GitHub release on aayus7/Islander, and every copy of
// Islander out there updates itself.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const v = pkg.version;
const dir = "src-tauri/target/release/bundle/nsis";
const exe = readdirSync(dir).find((f) => f.endsWith(`_${v}_x64-setup.exe`));
if (!exe) throw new Error(`No installer for ${v} in ${dir}`);
const sig = readFileSync(join(dir, exe + ".sig"), "utf8").trim();
// GitHub turns spaces into dots in release asset names.
const asset = exe.replace(/ /g, ".");
let notes = "";
try {
  notes = readFileSync("release-notes.txt", "utf8").trim();
} catch {}

mkdirSync("release", { recursive: true });
copyFileSync(join(dir, exe), join("release", asset));
copyFileSync(join(dir, exe + ".sig"), join("release", asset + ".sig"));
writeFileSync(
  "release/latest.json",
  JSON.stringify(
    {
      version: v,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature: sig,
          url: `https://github.com/aayus7/Islander/releases/download/v${v}/${asset}`,
        },
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(`Update feed for ${v} written to release/latest.json`);
