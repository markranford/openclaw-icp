import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Required for @icp-sdk/core to work in browser
    global: "globalThis",
  },
  server: {
    proxy: {
      // Proxy API calls to local replica during development
      "/api": {
        target: "http://127.0.0.1:4943",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
