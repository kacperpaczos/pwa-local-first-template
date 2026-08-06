import { atom } from "nanostores";
import { resolveAiModelId, type AiTier } from "./config";
import { retrieveRankedChunks, type NoteForSearch } from "./embeddings";
import {
  filterChunksByThreshold,
  NO_COVERAGE_ANSWER,
  buildGroundedSystemPrompt,
  degradeIfBadCitations,
  tryParseGroundedAnswer,
} from "./grounding";
import {
  aiStatusStore,
  setAiAvailable,
  setAiBusy,
  setAiDownloading,
  setAiError,
  setAiReady,
} from "./status";
import { parseSuggestedMeta, type AiProvider, type SuggestedMeta } from "./types";

export type AiProviderFactory = () => AiProvider | Promise<AiProvider>;

declare global {
  // E2E / tests: inject a fake provider instead of downloading a real model.
  // Honoured only when `aiHarnessEnabled()` is true (DEV / VITE_E2E / Vitest).
  var __createAiProvider: AiProviderFactory | undefined;
}

const IDLE_UNLOAD_MS = 10 * 60 * 1000;
const AI_ENGINE_LOCK = "ai-engine";

let provider: AiProvider | null = null;
let downloadInFlight: Promise<void> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Resolves the deferred Web Lock hold started during download. */
let releaseEngineLock: (() => void) | null = null;
/** Settles once the lock manager has fully released the most recent hold —
 * Web Locks unwind asynchronously after the holder callback resolves. */
let engineLockDone: Promise<void> | null = null;
let activeTier: AiTier | null = null;

export type AiTelemetry = {
  inferCount: number;
  errorCount: number;
  /** Last successful inference duration in ms; null until first success. */
  lastMs: number | null;
};

export const aiTelemetryStore = atom<AiTelemetry>({
  inferCount: 0,
  errorCount: 0,
  lastMs: null,
});

function recordInferenceSuccess(elapsedMs: number): void {
  const prev = aiTelemetryStore.get();
  aiTelemetryStore.set({
    inferCount: prev.inferCount + 1,
    errorCount: prev.errorCount,
    lastMs: elapsedMs,
  });
}

function recordInferenceError(): void {
  const prev = aiTelemetryStore.get();
  aiTelemetryStore.set({
    ...prev,
    errorCount: prev.errorCount + 1,
  });
}

/** Reset the idle-unload timer. Call on any AI activity. */
export function touchAiActivity(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const status = aiStatusStore.get();
  if (status.kind !== "ready" && status.kind !== "busy") {
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void unloadAiModel();
  }, IDLE_UNLOAD_MS);
  // Vitest (Node) waits on ref'd timers; unref so idle dispose doesn't keep the process alive.
  if (typeof idleTimer === "object" && idleTimer !== null && "unref" in idleTimer) {
    (idleTimer as { unref?: () => void }).unref?.();
  }
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function releaseAiEngineLock(): void {
  if (releaseEngineLock) {
    releaseEngineLock();
    releaseEngineLock = null;
  }
}

/**
 * Try to take an exclusive Web Lock so only one tab holds the GPU engine.
 * Returns false when another tab already holds `ai-engine`.
 * Holds until {@link releaseAiEngineLock} / unload.
 */
async function tryAcquireAiEngineLock(): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) {
    return true;
  }

  // A just-released lock is freed only after its holder callback settles, so
  // an immediate re-acquire with `ifAvailable` would spuriously fail. Only
  // wait when we no longer hold it (releaseEngineLock already null).
  if (engineLockDone && !releaseEngineLock) {
    await engineLockDone.catch(() => undefined);
    engineLockDone = null;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    engineLockDone = locks
      .request(AI_ENGINE_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          if (!settled) {
            settled = true;
            resolve(false);
          }
          return;
        }
        if (!settled) {
          settled = true;
          resolve(true);
        }
        await new Promise<void>((release) => {
          releaseEngineLock = release;
        });
      })
      .then(
        () => undefined,
        () => {
          if (!settled) {
            settled = true;
            resolve(true);
          }
        },
      );
  });
}

/** Harness injection is never active in production builds. */
export function shouldUseAiHarness(env: {
  DEV?: boolean;
  VITE_E2E?: string;
  MODE?: string;
}): boolean {
  return env.DEV === true || env.VITE_E2E === "1" || env.MODE === "test";
}

export function aiHarnessEnabled(): boolean {
  return shouldUseAiHarness(import.meta.env);
}

function resolveFactory(tier?: AiTier): AiProviderFactory {
  if (aiHarnessEnabled() && typeof globalThis.__createAiProvider === "function") {
    return globalThis.__createAiProvider;
  }
  const modelId = resolveAiModelId(tier);
  return async () => {
    const { WebLlmAiProvider } = await import("./webllm-provider");
    const { createWebLlmEngine } = await import("./webllm-engine");
    return new WebLlmAiProvider({
      modelId,
      createEngine: createWebLlmEngine,
    });
  };
}

export function getAiProvider(): AiProvider | null {
  return provider;
}

export function getActiveAiTier(): AiTier | null {
  return activeTier;
}

/** Test helper — clears singleton between Vitest cases. */
export function resetAiSessionForTests(): void {
  releaseAiEngineLock();
  provider = null;
  downloadInFlight = null;
  activeTier = null;
  clearIdleTimer();
  aiTelemetryStore.set({ inferCount: 0, errorCount: 0, lastMs: null });
}

/** Refresh `available.cached` from disk without loading the model into GPU. */
export async function refreshAiCacheStatus(tier?: AiTier): Promise<boolean> {
  if (aiHarnessEnabled() && typeof globalThis.__createAiProvider === "function") {
    return false;
  }
  try {
    const { isAiModelCached } = await import("./webllm-engine");
    const cached = await isAiModelCached(tier);
    const status = aiStatusStore.get();
    if (status.kind === "available") {
      setAiAvailable(cached);
    }
    return cached;
  } catch {
    return false;
  }
}

/**
 * Silent 1-chunk generation after load so the first real reply is warm.
 * Resets the idle timer. No-op when chat is missing.
 */
export async function warmupAi(): Promise<void> {
  if (!provider || typeof provider.chat !== "function") {
    return;
  }
  try {
    const iter = provider.chat(".");
    // Consume a single chunk (≈ one decode step) then stop iterating.
    const first = await iter[Symbol.asyncIterator]().next();
    void first;
  } catch {
    /* warm-up is best-effort */
  }
  touchAiActivity();
}

/**
 * Downloads (or loads from cache) the WebLLM model and transitions
 * `available → downloading → ready` (or `error`).
 *
 * Weights stay on disk after the first successful download. Later clicks only
 * reload the model into GPU memory (much faster when cache hits).
 */
export async function downloadAiModel(signal?: AbortSignal, tier?: AiTier): Promise<void> {
  const status = aiStatusStore.get();
  if (status.kind === "ready" || status.kind === "busy") {
    touchAiActivity();
    return;
  }
  if (status.kind === "unavailable") {
    throw new Error("AI is unavailable");
  }
  if (downloadInFlight) {
    await downloadInFlight;
    return;
  }

  const fromCache =
    status.kind === "available"
      ? status.cached
      : await refreshAiCacheStatus(tier).catch(() => false);

  downloadInFlight = (async () => {
    const gotLock = await tryAcquireAiEngineLock();
    if (!gotLock) {
      const message = "AI active in another tab";
      setAiError(message);
      throw new Error(message);
    }

    setAiDownloading(0, fromCache);
    try {
      const next = await resolveFactory(tier)();
      await next.init((progress) => {
        setAiDownloading(progress.progress, fromCache);
      }, signal);
      provider = next;
      activeTier = tier ?? null;
      setAiReady();
      touchAiActivity();
      await warmupAi();
    } catch (error) {
      provider = null;
      activeTier = null;
      clearIdleTimer();
      releaseAiEngineLock();
      if (error instanceof DOMException && error.name === "AbortError") {
        setAiAvailable(fromCache);
        throw error;
      }
      setAiError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      downloadInFlight = null;
    }
  })();

  await downloadInFlight;
}

/** Frees GPU RAM; weights remain cached on disk for the next Load. */
export async function unloadAiModel(): Promise<void> {
  if (aiStatusStore.get().kind === "busy") {
    throw new Error("Cannot unload the model while a generation is in progress.");
  }
  clearIdleTimer();
  const current = provider;
  provider = null;
  activeTier = null;
  if (current) {
    try {
      await current.dispose();
    } catch {
      /* best-effort unload */
    }
  }
  releaseAiEngineLock();
  if (aiStatusStore.get().kind === "unavailable") {
    return;
  }
  // We just ran this model, so weights are on disk even if the probe lags.
  setAiAvailable(true);
  void refreshAiCacheStatus();
}

/**
 * Deletes WebLLM/MLC model artifacts from IndexedDB + Cache API backends.
 * Unloads the in-memory engine first. Returns how many backends reported success.
 *
 * If programmatic deletion fails (browser policy), the UI should tell the user
 * they can clear site data via browser settings.
 */
export async function clearAiModelCache(): Promise<{ cleared: boolean; detail: string }> {
  await unloadAiModel();

  if (aiHarnessEnabled() && typeof globalThis.__createAiProvider === "function") {
    setAiAvailable(false);
    return { cleared: true, detail: "Harness mode — nothing on disk to clear." };
  }

  try {
    const { clearAiModelCacheBackends } = await import("./webllm-engine");
    const result = await clearAiModelCacheBackends();
    setAiAvailable(false);
    void refreshAiCacheStatus();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      cleared: false,
      detail:
        `Could not clear model cache automatically (${message}). ` +
        "Clear this site's data in browser settings to free storage.",
    };
  }
}

async function runGeneration(
  run: (active: AiProvider) => AsyncIterable<string>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const status = aiStatusStore.get();
  if (status.kind !== "ready" && status.kind !== "busy") {
    throw new Error("Model is not ready");
  }
  if (!provider) {
    throw new Error("AI provider missing — download the model first");
  }

  touchAiActivity();
  setAiBusy();
  const parts: string[] = [];
  const started = performance.now();
  try {
    for await (const chunk of run(provider)) {
      parts.push(chunk);
      onChunk?.(chunk);
    }
    recordInferenceSuccess(Math.round(performance.now() - started));
    setAiReady();
    touchAiActivity();
    return parts.join("");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      setAiReady();
      touchAiActivity();
      throw error;
    }
    recordInferenceError();
    setAiError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Free-form chat. Requires a ready model.
 */
export async function chatWithAi(
  message: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return runGeneration((active) => active.chat(message, { signal }), onChunk);
}

/**
 * Streams a summary. Requires a ready model.
 * Returns the full text; UI may also subscribe to chunks via `onChunk`.
 */
export async function summarizeWithAi(
  body: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  return runGeneration((active) => active.summarize(body, { signal }), onChunk);
}

/**
 * RAG over local notes with retrieval threshold + citation degradation.
 * Embeddings stay local — never written into sync mutations.
 */
export async function answerWithRag(
  question: string,
  notes: NoteForSearch[],
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const ranked = await retrieveRankedChunks(question, notes);
  const chunks = filterChunksByThreshold(ranked).map(({ noteId, text }) => ({
    noteId,
    text,
  }));

  if (chunks.length === 0) {
    onChunk?.(NO_COVERAGE_ANSWER);
    return NO_COVERAGE_ANSWER;
  }

  const text = await runGeneration(
    (active) => active.answer(question, chunks, { signal }),
    onChunk,
  );

  const grounded = tryParseGroundedAnswer(text);
  if (!grounded) {
    return text;
  }
  const degraded = degradeIfBadCitations(grounded, notes);
  return degraded.answer;
}

/**
 * Asks the ready model for a title + tags, then validates via `parseSuggestedMeta`.
 */
export async function suggestMetaWithAi(body: string): Promise<SuggestedMeta> {
  const status = aiStatusStore.get();
  if (status.kind !== "ready" && status.kind !== "busy") {
    throw new Error("Model is not ready");
  }
  if (!provider) {
    throw new Error("AI provider missing — download the model first");
  }

  touchAiActivity();
  setAiBusy();
  const started = performance.now();
  try {
    const raw = await provider.suggestMeta(body);
    const meta = parseSuggestedMeta(raw);
    recordInferenceSuccess(Math.round(performance.now() - started));
    setAiReady();
    touchAiActivity();
    return meta;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      setAiReady();
      touchAiActivity();
      throw error;
    }
    recordInferenceError();
    setAiError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Exported for tests / prompt builders. */
export function groundedSystemPromptForToday(): string {
  const date = new Date().toISOString().slice(0, 10);
  return buildGroundedSystemPrompt(date);
}
