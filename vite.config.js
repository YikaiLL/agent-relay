import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "frontend"),
  base: "/static/",
  publicDir: resolve(__dirname, "frontend/public"),
  build: {
    outDir: resolve(__dirname, "web"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "frontend/index.html"),
        remote: resolve(__dirname, "frontend/remote.html"),
      },
    },
  },
});
