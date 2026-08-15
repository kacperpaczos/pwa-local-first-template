import { atom } from "nanostores";

/**
 * State machine for the AI layer:
 *
 *   unavailable → available → downloading(p%) → ready → busy
 *                                  ├─ error → available (retry)
 *                                  └─ error(reason) from ready/busy too
 *
 * `available.cached` means weights are already on disk (Cache API / IndexedDB);
 * the user still needs an explicit Load to put the model into GPU RAM.
 */
export type AiStatus =
  | { kind: "unavailable"; reason: "disabled" | "no-webgpu" }
  | { kind: "available"; cached: boolean }
  | { kind: "downloading"; progress: number; fromCache: boolean }
  | { kind: "ready" }
  | { kind: "busy" }
  | { kind: "error"; reason: string };

export const aiStatusStore = atom<AiStatus>({ kind: "unavailable", reason: "disabled" });

export function setAiUnavailable(reason: "disabled" | "no-webgpu"): void {
  aiStatusStore.set({ kind: "unavailable", reason });
}

export function setAiAvailable(cached = false): void {
  aiStatusStore.set({ kind: "available", cached });
}

export function setAiDownloading(progress: number, fromCache = false): void {
  aiStatusStore.set({ kind: "downloading", progress, fromCache });
}

export function setAiReady(): void {
  aiStatusStore.set({ kind: "ready" });
}

export function setAiBusy(): void {
  aiStatusStore.set({ kind: "busy" });
}

export function setAiError(reason: string): void {
  aiStatusStore.set({ kind: "error", reason });
}
