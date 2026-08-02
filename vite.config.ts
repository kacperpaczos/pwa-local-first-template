import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [
    solidPlugin(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "pwa-local-first-template",
        short_name: "local-first",
        description: "Solid.js local-first PWA template",
        theme_color: "#0f1419",
        background_color: "#0f1419",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // OPFS DB is not a build asset — never add it to globPatterns.
        globPatterns: ["**/*.{js,css,html,svg,ico,png,woff2}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ request }) =>
              request.destination === "worker" ||
              request.url.includes(".wasm"),
            handler: "CacheFirst",
            options: {
              cacheName: "wasm-and-workers",
              expiration: {
                maxEntries: 16,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
  },
});
