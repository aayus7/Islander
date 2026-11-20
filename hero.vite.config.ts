import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";
import { viteSingleFile } from "vite-plugin-singlefile";
// Builds showcase/hero.html (the website's live island) as one self-contained file. `npm run site` copies it into site/.
export default mergeConfig(base, defineConfig({
  plugins: [viteSingleFile()],
  build: { outDir: "dist-hero", emptyOutDir: true, copyPublicDir: false, rollupOptions: { input: "showcase/hero.html" } },
}));
