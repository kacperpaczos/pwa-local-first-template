import {
  CreateMLCEngine,
  deleteModelAllInfoInCache,
  hasModelInCache,
  prebuiltAppConfig,
  type AppConfig,
} from "@mlc-ai/web-llm";
import { resolveAiModelId, type AiTier } from "./config";
import type { CreateEngineFn } from "./webllm-types";

const preferredConfig: AppConfig = {
  ...prebuiltAppConfig,
  // IndexedDB survives better under PWA / storage pressure than Cache API alone.
  cacheBackend: "indexeddb",
};

const legacyCacheConfig: AppConfig = {
  ...prebuiltAppConfig,
  cacheBackend: "cache",
};

/** Shared WebLLM app config (preferred backend). */
export function getPreferredAiAppConfig(): AppConfig {
  return preferredConfig;
}

/**
 * True when model tensors are already persisted locally.
 * Checks IndexedDB first, then the older Cache API backend (pre-switch downloads).
 */
export async function isAiModelCached(tier?: AiTier): Promise<boolean> {
  const modelId = resolveAiModelId(tier);
  if (await hasModelInCache(modelId, preferredConfig)) return true;
  return hasModelInCache(modelId, legacyCacheConfig);
}

/**
 * Pick the cache backend that already holds the model, so Load does not
 * re-download weights that live under the other storage backend.
 */
export async function resolveAiAppConfig(tier?: AiTier): Promise<AppConfig> {
  const modelId = resolveAiModelId(tier);
  if (await hasModelInCache(modelId, preferredConfig)) {
    return preferredConfig;
  }
  if (await hasModelInCache(modelId, legacyCacheConfig)) {
    return legacyCacheConfig;
  }
  return preferredConfig;
}

/**
 * Best-effort wipe of WebLLM model artifacts from both cache backends,
 * plus Cache API keys whose names look like webllm/mlc leftovers.
 */
export async function clearAiModelCacheBackends(
  tier?: AiTier,
): Promise<{
  cleared: boolean;
  detail: string;
}> {
  const errors: string[] = [];
  const modelId = resolveAiModelId(tier);

  for (const config of [preferredConfig, legacyCacheConfig]) {
    try {
      await deleteModelAllInfoInCache(modelId, config);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  let cachesDeleted = 0;
  if (typeof caches !== "undefined") {
    try {
      const keys = await caches.keys();
      for (const key of keys) {
        if (/webllm|mlc|tvmjs/i.test(key)) {
          const ok = await caches.delete(key);
          if (ok) cachesDeleted += 1;
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0 && cachesDeleted === 0) {
    return {
      cleared: false,
      detail:
        `Partial failure clearing model cache (${errors.join("; ")}). ` +
        "If storage is still high, clear this site's data in browser settings.",
    };
  }

  return {
    cleared: true,
    detail:
      cachesDeleted > 0
        ? `Cleared model cache (also removed ${cachesDeleted} Cache API entr${cachesDeleted === 1 ? "y" : "ies"}).`
        : "Cleared model cache for IndexedDB and Cache API backends.",
  };
}

/** Production factory — boots a real WebLLM engine (WebGPU + model download). */
export const createWebLlmEngine: CreateEngineFn = async (modelId, options) => {
  const appConfig = await resolveAiAppConfig();
  const engine = await CreateMLCEngine(modelId, {
    appConfig,
    initProgressCallback: (report) => {
      options.initProgressCallback({
        progress: report.progress,
        text: report.text,
      });
    },
  });
  return engine;
};
