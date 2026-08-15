import { defineConfig, devices } from "@playwright/test";

// Defaults match docs/.env.example. `scripts/e2e.mjs` (what `pnpm test:e2e`
// runs) overrides them when a port is already taken; running `playwright test`
// directly keeps the documented ports.
const GUN_PORT = process.env.GUN_PEER_PORT ?? "8765";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "4173";
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

const e2eEnv = {
  VITE_GUN_PEERS: `http://127.0.0.1:${GUN_PORT}/gun`,
  VITE_AI_ENABLED: "true",
  VITE_E2E: "1",
  GUN_PEER_TEST_MODE: "1",
  GUN_PEER_PORT: GUN_PORT,
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `pnpm build && pnpm exec concurrently -k -s first -n gun,web "GUN_PEER_TEST_MODE=1 GUN_PEER_PORT=${GUN_PORT} pnpm dev:gun-peer" "pnpm preview --host 127.0.0.1 --port ${WEB_PORT}"`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: e2eEnv,
  },
  projects: [
    {
      name: "chromium-smoke",
      testMatch: /(?:smoke|ai)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Runs after smoke so both projects never share the gun peer concurrently.
      name: "chromium-sync",
      dependencies: ["chromium-smoke"],
      testMatch: /(?:offline-sync|multi-tab|gun-peers|merge-body|backup)\.spec\.ts/,
      fullyParallel: false,
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
