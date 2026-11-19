// Runs `tauri dev` exactly as before (same colours in this window), and also writes
// everything it prints to dev-output.log in the project folder — so Claude can read
// build errors and app messages without you having to copy them.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const log = createWriteStream("dev-output.log", { flags: "w" });
const plain = (b) => b.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r(?!\n)/g, "\n");
const stamp = () => new Date().toLocaleTimeString();
log.write(`=== tauri dev started ${new Date().toLocaleString()} ===\n`);

const child = spawn("npm", ["run", "tauri", "dev"], {
  shell: true,
  // Output is piped (not a terminal), so ask the tools to keep their colours anyway.
  env: { ...process.env, FORCE_COLOR: "1", CARGO_TERM_COLOR: "always" },
});
const pipe = (src, dst) =>
  src.on("data", (b) => {
    dst.write(b);
    log.write(plain(b).replace(/^(?=.)/gm, `[${stamp()}] `));
  });
pipe(child.stdout, process.stdout);
pipe(child.stderr, process.stderr);
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => {
  log.write(`=== tauri dev exited (code ${code}) ${new Date().toLocaleString()} ===\n`);
  log.end(() => process.exit(code ?? 0));
});
