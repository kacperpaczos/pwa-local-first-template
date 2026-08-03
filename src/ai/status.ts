import { atom } from "nanostores";

/**
 * State machine for the AI layer (Faza 3 plan, §4):
 *
 *   unavailable → available → downloading(p%) → ready → busy
 *                                  ├─ error → available (retry)
 *                                  └─ error(reason) from ready/busy too
 */
export type AiStatus =
  | { kind: "unavailable"; reason: "disabled" | "no-webgpu" }
  | { kind: "available" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "busy" }
  | { kind: "error"; reason: string };

export const aiStatusStore = atom<AiStatus>({ kind: "unavailable", reason: "disabled" });

export function setAiUnavailable(reason: "disabled" | "no-webgpu"): void {
  aiStatusStore.set({ kind: "unavailable", reason });
}

export function setAiAvailable(): void {
  aiStatusStore.set({ kind: "available" });
}

export function setAiDownloading(progress: number): void {
  aiStatusStore.set({ kind: "downloading", progress });
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
