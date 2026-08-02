import { atom } from "nanostores";

export const syncStatusStore = atom<"idle" | "syncing" | "offline">("idle");

export function setSyncStatus(status: "idle" | "syncing" | "offline"): void {
  syncStatusStore.set(status);
}
