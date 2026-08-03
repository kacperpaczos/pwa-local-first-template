import { atom } from "nanostores";

export type SyncStatus = "idle" | "syncing" | "offline" | "outdated";

export const syncStatusStore = atom<SyncStatus>("idle");

export function setSyncStatus(status: SyncStatus): void {
  syncStatusStore.set(status);
}
