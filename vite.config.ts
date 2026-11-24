import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Relative asset paths, so the built pages work from any folder of any static host. The SDK and
// the oracle package are built from their sources, so the app needs no build of them first.
export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@louisinger/future-sdk": fileURLToPath(new URL("./sdk/src/index.ts", import.meta.url)),
      "@louisinger/dia-oracle": fileURLToPath(new URL("./oracle/src/index.ts", import.meta.url)),
    },
  },
  build: { rollupOptions: { input: { main: "index.html", how: "how.html" } } },
});
