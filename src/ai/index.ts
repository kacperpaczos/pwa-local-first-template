import {
  aiFeatureEnabled,
  resolveAiModelApproxBytes,
} from "./config";
import { hasWebGpu } from "./gpu";
import { setAiAvailable, setAiUnavailable, aiStatusStore, type AiStatus } from "./status";
import { refreshAiCacheStatus } from "./session";
import { refreshAiStorageHeadroom } from "./storage";

export * from "./types";
export * from "./status";
export {
  aiFeatureEnabled,
  aiModelId,
  aiModelApproxBytes,
  AI_TIER_MODELS,
  AI_TIER_STORAGE_KEY,
  getPersistedAiTier,
  setPersistedAiTier,
  resolveActiveAiTier,
  resolveAiModelId,
  resolveAiModelApproxBytes,
  getAiModelIdForTier,
  getAiModelApproxBytesForTier,
  isAiTier,
  type AiTier,
} from "./config";
export {
  detectHardware,
  recommendTier,
  resolveAiTier,
  type HardwareProfile,
} from "./hardware";
export {
  RETRIEVAL_THRESHOLD,
  NO_COVERAGE_ANSWER,
  verifyQuote,
  buildGroundedSystemPrompt,
  groundedAnswerSchema,
  degradeIfBadCitations,
  filterChunksByThreshold,
  tryParseGroundedAnswer,
  type GroundedAnswer,
  type GroundedSource,
} from "./grounding";
export { hasWebGpu } from "./gpu";
export {
  estimateStorageHeadroom,
  refreshAiStorageHeadroom,
  aiStorageHeadroomStore,
  type StorageHeadroom,
} from "./storage";
export {
  downloadAiModel,
  unloadAiModel,
  clearAiModelCache,
  chatWithAi,
  summarizeWithAi,
  suggestMetaWithAi,
  answerWithRag,
  getAiProvider,
  getActiveAiTier,
  resetAiSessionForTests,
  aiHarnessEnabled,
  shouldUseAiHarness,
  refreshAiCacheStatus,
  touchAiActivity,
  warmupAi,
  aiTelemetryStore,
  type AiTelemetry,
} from "./session";
export {
  ensureEmbeddingProvider,
  embedAndStore,
  semanticSearch,
  chunkText,
  retrieveTopChunks,
  retrieveRankedChunks,
  HashEmbeddingProvider,
  cosineSimilarity,
  topK,
  clearEmbeddingStore,
  type NoteForSearch,
  type RankedNote,
  type RankedChunk,
} from "./embeddings";
export {
  runAgentTurn,
  createNoteTools,
  type AgentTool,
  type AgentTurnResult,
  type PendingWrite,
} from "./agent/runtime";
export {
  BUILTIN_SKILLS,
  listSkills,
  getSkillById,
  filterToolsBySkill,
  loadCustomSkills,
  saveCustomSkills,
  type Skill,
} from "./agent/skills";
export { GOLDEN_SET, matchesNoCoverage, type GoldenCase } from "./eval/golden-set";

/**
 * Runs the Etap 3.0 gate: feature flag, WebGPU, then a non-blocking storage
 * headroom probe. Call once at app start. Download + inference are started
 * explicitly from the AI page. Cache probe runs in the background so UI can
 * show Load vs Download. Low headroom keeps AI available but warns via
 * `aiStorageHeadroomStore`.
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

  setAiAvailable(false);
  void refreshAiStorageHeadroom(resolveAiModelApproxBytes());
  void refreshAiCacheStatus();
  return aiStatusStore.get();
}
