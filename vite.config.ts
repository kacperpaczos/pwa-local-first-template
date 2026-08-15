import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

const moduleExclude = (match: string) => {
  const m = (id: string) => id.includes(match);
  return {
    name: `exclude-${match}`,
    resolveId(id: string) {
      if (m(id)) return id;
    },
    load(id: string) {
      if (m(id)) return `export default {}`;
    },
  };
};

export default defineConfig({
  plugins: [
    solidPlugin(),
    moduleExclude("text-encoding"),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
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
            purpose: "any",
          },
          {
            src: "pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "maskable-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        screenshots: [
          {
            src: "screenshots/home-wide.png",
            sizes: "1280x800",
            type: "image/png",
            form_factor: "wide",
            label: "Counter — one shared local-first counter",
          },
          {
            src: "screenshots/notes-narrow.png",
            sizes: "390x844",
            type: "image/png",
            form_factor: "narrow",
            label: "Counter — offline-first with sync status",
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
              request.destination === "worker" || request.url.includes(".wasm"),
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
  optimizeDeps: {
    include: [
      "gun",
      "gun/gun",
      "gun/sea",
      "gun/sea.js",
      "gun/lib/webrtc",
      "gun/lib/radix",
      "gun/lib/radisk",
      "gun/lib/store",
      "gun/lib/rindexed",
    ],
  },
  assetsInclude: ["**/*.wasm"],
  worker: {
    format: "es",
  },
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
    commonjsOptions: {
      include: [/gun/, /node_modules/],
    },
  },
});
