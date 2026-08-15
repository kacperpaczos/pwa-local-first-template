/**
 * Master switch for the whole AI layer — opt-in: only builds with
 * VITE_AI_ENABLED="true" ship with AI on. Everything else in `ai/` degrades
 * to `unavailable` when this is false, so the rest of the app never has to
 * know AI exists. The WebLLM chunks are behind dynamic imports either way,
 * so a disabled build never fetches them.
 */
export const aiFeatureEnabled: boolean = import.meta.env.VITE_AI_ENABLED === "true";

/** Hardware / quality tiers for on-device WebLLM. */
export type AiTier = "max" | "std" | "dev";

export const AI_TIER_STORAGE_KEY = "pwa-ai-tier";

/**
 * Model ids from `@mlc-ai/web-llm` `prebuiltAppConfig.model_list`.
 *
 * MAX prefers Qwen3-8B q4f16; if a pinned WebLLM build ever drops it, fall back
 * to `Qwen2.5-7B-Instruct-q4f16_1-MLC` (also in the prebuilt list).
 */
export const AI_TIER_MODELS: Record<
  AiTier,
  { modelId: string; approxBytes: number; label: string }
> = {
  max: {
    modelId: "Qwen3-8B-q4f16_1-MLC",
    // Fallback if missing: "Qwen2.5-7B-Instruct-q4f16_1-MLC"
    approxBytes: 5 * 1024 * 1024 * 1024,
    label: "MAX",
  },
  std: {
    modelId: "Qwen3-4B-q4f16_1-MLC",
    approxBytes: Math.round(2.5 * 1024 * 1024 * 1024),
    label: "STD",
  },
  dev: {
    modelId: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
    approxBytes: 700 * 1024 * 1024,
    label: "DEV",
  },
};

const TIER_SET = new Set<string>(["max", "std", "dev"]);

export function isAiTier(value: unknown): value is AiTier {
  return typeof value === "string" && TIER_SET.has(value);
}

function browserStorage(): Storage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage && typeof storage.getItem === "function") return storage;
  } catch {
    /* unavailable */
  }
  return undefined;
}

/** Forced / remembered tier from localStorage, or null for auto. */
export function getPersistedAiTier(): AiTier | null {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(AI_TIER_STORAGE_KEY);
    return isAiTier(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist a forced tier (`null` clears override → auto recommend). */
export function setPersistedAiTier(tier: AiTier | null): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (tier == null) {
      storage.removeItem(AI_TIER_STORAGE_KEY);
    } else {
      storage.setItem(AI_TIER_STORAGE_KEY, tier);
    }
  } catch {
    /* quota / private mode */
  }
}

/** Active tier: explicit override, then localStorage, then recommendation. */
export function resolveActiveAiTier(recommended: AiTier, forced?: AiTier | null): AiTier {
  if (forced != null) return forced;
  return getPersistedAiTier() ?? recommended;
}

export function getAiModelIdForTier(tier: AiTier): string {
  return AI_TIER_MODELS[tier].modelId;
}

export function getAiModelApproxBytesForTier(tier: AiTier): number {
  return AI_TIER_MODELS[tier].approxBytes;
}

/**
 * WebLLM prebuilt model id.
 * `VITE_AI_MODEL_ID` always wins; otherwise the active (persisted or default STD) tier.
 */
export function resolveAiModelId(tier?: AiTier): string {
  const envId = import.meta.env.VITE_AI_MODEL_ID?.trim();
  if (envId) return envId;
  const active = tier ?? getPersistedAiTier() ?? "std";
  return getAiModelIdForTier(active);
}

/**
 * @deprecated Prefer `resolveAiModelId()` — kept for call sites that read a const.
 * Resolves at module load from env / persisted tier / STD.
 */
export const aiModelId: string = resolveAiModelId();

/**
 * Approximate on-disk size for the active tier (or STD when unset).
 * Used for storage-headroom checks before download.
 */
export function resolveAiModelApproxBytes(tier?: AiTier): number {
  const active = tier ?? getPersistedAiTier() ?? "std";
  return getAiModelApproxBytesForTier(active);
}

/** @deprecated Prefer `resolveAiModelApproxBytes()`. */
export const aiModelApproxBytes: number = resolveAiModelApproxBytes();
