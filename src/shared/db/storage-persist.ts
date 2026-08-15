import { atom } from "nanostores";

export type StoragePersistStatus = "unknown" | "persisted" | "not-persisted" | "unsupported";

export const storagePersistStore = atom<StoragePersistStatus>("unknown");

let persistRequested = false;

/**
 * Requests durable storage once per session, on the first write. Subsequent
 * calls are no-ops — the browser's own answer to `persist()` doesn't change
 * within a session, so there's nothing to gain from asking again on every
 * write.
 */
export async function ensureStoragePersisted(): Promise<void> {
  if (persistRequested) return;
  persistRequested = true;

  if (typeof navigator === "undefined" || !navigator.storage?.persist) {
    storagePersistStore.set("unsupported");
    return;
  }
  const persisted = await navigator.storage.persist();
  storagePersistStore.set(persisted ? "persisted" : "not-persisted");
}

/** Test helper — clears the once-per-session guard between Vitest cases. */
export function resetStoragePersistForTests(): void {
  persistRequested = false;
  storagePersistStore.set("unknown");
}
