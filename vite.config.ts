import { defineConfig } from "vite";

// Relative asset paths, so the built pages work from any folder of any static host.
export default defineConfig({
  base: "./",
  build: { rollupOptions: { input: { main: "index.html", how: "how.html" } } },
});
