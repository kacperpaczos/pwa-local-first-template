/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Comma-separated Gun peer URLs. Empty → NoopSyncTransport. */
  readonly VITE_GUN_PEERS?: string;
  /** Master AI feature flag — opt-in; only "true" enables the ai/ layer. */
  readonly VITE_AI_ENABLED?: string;
  /** When "1", expose globalThis.__db for Playwright e2e (non-production tooling). */
  readonly VITE_E2E?: string;
  /** Optional WebLLM model id override (defaults to a hardware-detected Qwen3/Llama tier). */
  readonly VITE_AI_MODEL_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
