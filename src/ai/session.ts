import { aiModelId } from "./config";
import {
  aiStatusStore,
  setAiAvailable,
  setAiBusy,
  setAiDownloading,
  setAiError,
  setAiReady,
} from "./status";
import type { AiProvider } from "./types";

export type AiProviderFactory = () => AiProvider | Promise<AiProvider>;

declare global {
  // E2E / tests: inject a fake provider instead of downloading a real model.
  var __createAiProvider: AiProviderFactory | undefined;
}

let provider: AiProvider | null = null;
let downloadInFlight: Promise<void> | null = null;

function resolveFactory(): AiProviderFactory {
  if (typeof globalThis.__createAiProvider === "function") {
    return globalThis.__createAiProvider;
  }
  return async () => {
    const { WebLlmAiProvider } = await import("./webllm-provider");
    const { createWebLlmEngine } = await import("./webllm-engine");
    return new WebLlmAiProvider({
      modelId: aiModelId,
      createEngine: createWebLlmEngine,
    });
  };
}

export function getAiProvider(): AiProvider | null {
  return provider;
}

/** Test helper — clears singleton between Vitest cases. */
export function resetAiSessionForTests(): void {
  provider = null;
  downloadInFlight = null;
}

/**
 * Downloads (or loads from cache) the WebLLM model and transitions
 * `available → downloading → ready` (or `error`).
 */
export async function downloadAiModel(signal?: AbortSignal): Promise<void> {
  const status = aiStatusStore.get();
  if (status.kind === "ready" || status.kind === "busy") {
    return;
  }
  if (status.kind === "unavailable") {
    throw new Error("AI is unavailable");
  }
  if (downloadInFlight) {
    await downloadInFlight;
    return;
  }

  downloadInFlight = (async () => {
    setAiDownloading(0);
    try {
      const next = await resolveFactory()();
      await next.init((progress) => {
        setAiDownloading(progress.progress);
      }, signal);
      provider = next;
      setAiReady();
    } catch (error) {
      provider = null;
      if (error instanceof DOMException && error.name === "AbortError") {
        setAiAvailable();
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

/**
 * Streams a summary. Requires a ready model.
 * Returns the full text; UI may also subscribe to chunks via `onChunk`.
 */
export async function summarizeWithAi(
  body: string,
  onChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const status = aiStatusStore.get();
  if (status.kind !== "ready" && status.kind !== "busy") {
    throw new Error("Model is not ready");
  }
  if (!provider) {
    throw new Error("AI provider missing — download the model first");
  }

  setAiBusy();
  const parts: string[] = [];
  try {
    for await (const chunk of provider.summarize(body, { signal })) {
      parts.push(chunk);
      onChunk?.(chunk);
    }
    setAiReady();
    return parts.join("");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      setAiReady();
      throw error;
    }
    setAiError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
