import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import pkg from "./package.json";

// SINGLE=1 builds the browser preview as one self-contained HTML file.
export default defineConfig({
  plugins: [react(), ...(process.env.SINGLE ? [viteSingleFile()] : [])],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "chrome120",
    cssMinify: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
  },
  // Production: no debugger statements, and console.log calls are dropped.
  esbuild: process.env.NODE_ENV === "production" || process.argv.includes("build") ? { drop: ["debugger"], pure: ["console.log", "console.debug"] } : undefined,
});
