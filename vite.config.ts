import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Relative asset paths, so the built pages work from any folder of any static host. The SDK is
// built from its source, so the app needs no build of it first.
export default defineConfig({
  base: "./",
  resolve: {
    alias: { "@louisinger/future-sdk": fileURLToPath(new URL("./sdk/src/index.ts", import.meta.url)) },
  },
  build: { rollupOptions: { input: { main: "index.html", how: "how.html" } } },
});
