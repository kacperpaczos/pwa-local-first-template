/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SYNC_WS_URL?: string;
  /** Master AI feature flag; set to "false" to hide the whole ai/ layer. */
  readonly VITE_AI_ENABLED?: string;
  /** When "1", expose globalThis.__db for Playwright e2e (non-production tooling). */
  readonly VITE_E2E?: string;
  /** Optional WebLLM model id override (defaults to a small SmolLM2). */
  readonly VITE_AI_MODEL_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
