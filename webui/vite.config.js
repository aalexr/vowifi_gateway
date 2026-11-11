import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

// The manager serves the built app and proxies /api + /ws on the same origin.
export default defineConfig({
  // preset-vite aliases react / react-dom (incl. /client, /jsx-runtime) to preact/compat,
  // so React-ecosystem libs (react-router, lucide-react) and our `from "react"` imports
  // run on Preact.
  plugins: [preact(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Views are lazy-loaded (src/views/index.ts). Libraries get their own chunks so
    // their hashes survive app-only rebuilds (browser cache stays warm): Preact + router
    // are needed by every page, JsSIP only by the Softphone view.
    rolldownOptions: {
      // react-router feature-detects React 19's useOptimistic (falls back when absent);
      // preact/compat doesn't have it, which is expected.
      onLog(level, warning, log) {
        if (
          warning.code === "IMPORT_IS_UNDEFINED" &&
          warning.message.includes("useOptimistic")
        )
          return;
        log(level, warning);
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: "framework",
              test: /node_modules[\\/](preact|react-router|cookie|set-cookie-parser)[\\/]/,
              priority: 20,
            },
            {
              name: "jssip",
              test: /node_modules[\\/]jssip[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  // For local UI development, proxy API/WS to a running control plane. Defaults to
  // localhost; override with VOWIFI_DEV_API (e.g. https://gateway-host:8443).
  server: {
    proxy: {
      "/api": {
        target: process.env.VOWIFI_DEV_API || "https://localhost:8443",
        changeOrigin: true,
        secure: false,
      },
      "/ws": {
        target: (
          process.env.VOWIFI_DEV_API || "https://localhost:8443"
        ).replace(/^http/, "ws"),
        ws: true,
        secure: false,
      },
    },
  },
});
