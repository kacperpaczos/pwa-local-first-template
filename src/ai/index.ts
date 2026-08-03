import { aiFeatureEnabled } from "./config";
import { hasWebGpu } from "./gpu";
import { setAiAvailable, setAiUnavailable, aiStatusStore, type AiStatus } from "./status";

export * from "./types";
export * from "./status";
export { aiFeatureEnabled, aiModelId } from "./config";
export { hasWebGpu } from "./gpu";
export { estimateStorageHeadroom, type StorageHeadroom } from "./storage";
export {
  downloadAiModel,
  summarizeWithAi,
  getAiProvider,
  resetAiSessionForTests,
} from "./session";

/**
 * Runs the Etap 3.0 gate: feature flag, then WebGPU support. Call once at
 * app start. Download + inference are started explicitly from the AI panel.
 */
export function initAiFeature(): AiStatus {
  if (!aiFeatureEnabled) {
    setAiUnavailable("disabled");
    return aiStatusStore.get();
  }

  if (!hasWebGpu()) {
    setAiUnavailable("no-webgpu");
    return aiStatusStore.get();
  }

  setAiAvailable();
  return aiStatusStore.get();
}
