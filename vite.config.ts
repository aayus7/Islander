import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// SINGLE=1 builds the browser preview as one self-contained HTML file.
export default defineConfig({
  plugins: [react(), ...(process.env.SINGLE ? [viteSingleFile()] : [])],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "chrome120" },
});
