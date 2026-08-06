import { defineConfig, devices } from "@playwright/test";

const e2eEnv = {
  VITE_GUN_PEERS: "http://127.0.0.1:8765/gun",
  VITE_AI_ENABLED: "true",
  VITE_E2E: "1",
  GUN_PEER_TEST_MODE: "1",
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      'pnpm build && pnpm exec concurrently -k -s first -n gun,web "GUN_PEER_TEST_MODE=1 pnpm dev:gun-peer" "pnpm preview --host 127.0.0.1 --port 4173"',
    url: "http://127.0.0.1:4173",
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
