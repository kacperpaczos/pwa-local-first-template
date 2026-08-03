/**
 * Master switch for the whole AI layer. Off by default in any build where
 * VITE_AI_ENABLED is explicitly "false" — everything else in `ai/` degrades
 * to `unavailable` when this is false, so the rest of the app never has to
 * know AI exists.
 */
export const aiFeatureEnabled: boolean = import.meta.env.VITE_AI_ENABLED !== "false";

/**
 * WebLLM prebuilt model id (see `@mlc-ai/web-llm` `prebuiltAppConfig.model_list`).
 * Override with `VITE_AI_MODEL_ID` — keep it small for local/dev downloads.
 */
export const aiModelId: string =
  import.meta.env.VITE_AI_MODEL_ID?.trim() ||
  "SmolLM2-360M-Instruct-q4f16_1-MLC";
