import { defineConfig } from "vite";

// One ES module with the contracts inlined; dependencies stay imports.
export default defineConfig({
  build: {
    lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
    rollupOptions: { external: /^[^./]/ },
    minify: false,
  },
});
