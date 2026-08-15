import { atom } from "nanostores";

/**
 * - `locked` — space key unavailable; transport fails closed (no weaker cipher).
 * - `outdated` — a peer publishes a protocol version this build can't ingest.
 * - `degraded` — quarantined/forked ops exist; sync continues around them.
 *
 * The engine RECOMPUTES this each cycle — nothing latches (the old status
 * store stuck on "outdated" until reload once a single bad row was seen).
 */
export type SyncStatus = "idle" | "syncing" | "offline" | "locked" | "outdated" | "degraded";

export const syncStatusStore = atom<SyncStatus>("idle");

/** Count of quarantined ops backing the "degraded" status (UI detail). */
export const syncQuarantineCountStore = atom<number>(0);

export function setSyncStatus(status: SyncStatus): void {
  syncStatusStore.set(status);
}
