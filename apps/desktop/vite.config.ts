import { defineConfig } from "vite";

// The launcher page (index.html + src/) that the desktop app opens first (docs/design/desktop.md). `tauri
// dev` serves it from this dev server (src-tauri/tauri.conf.json → build.devUrl); `tauri build` bundles
// dist/. Port and settings follow Tauri's Vite template.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["es2020", "safari14", "chrome105"],
    sourcemap: false,
  },
});
