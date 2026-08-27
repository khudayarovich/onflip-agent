import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "node:path";

// The renderer is built as a static bundle loaded over file:// by Electron,
// so every asset path has to be relative.
export default defineConfig({
  root: path.resolve(__dirname, "ui"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "ui-dist"),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [path.resolve(__dirname)] },
  },
});
