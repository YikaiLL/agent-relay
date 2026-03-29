import { defineConfig } from "vite";
import { resolve } from "node:path";

const relayPort = Number(process.env.RELAY_DEV_SERVER_PORT || 8787);
const vitePort = Number(process.env.RELAY_DEV_VITE_PORT || 5173);

export default defineConfig({
  root: resolve(__dirname, "frontend"),
  base: "/static/",
  publicDir: resolve(__dirname, "frontend/public"),
  server: {
    host: true,
    port: vitePort,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${relayPort}`,
        changeOrigin: true,
      },
    },
  },
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
