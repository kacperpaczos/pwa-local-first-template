import { atom } from "nanostores";

const LAST_EXPORT_KEY = "pwa-local-first:last-backup-export-at";

export const lastBackupExportAtStore = atom<string | null>(readLastExportAt());

function readLastExportAt(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(LAST_EXPORT_KEY);
}

export function recordBackupExport(at: string): void {
  lastBackupExportAtStore.set(at);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LAST_EXPORT_KEY, at);
  }
}

export type StoragePersistStatus = "unknown" | "persisted" | "not-persisted" | "unsupported";

export const storagePersistStore = atom<StoragePersistStatus>("unknown");

let persistRequested = false;

/**
 * Requests durable storage once per session, on the first note write.
 * Subsequent calls are no-ops — the browser's own answer to `persist()`
 * doesn't change within a session, so there's nothing to gain from asking
 * again on every write.
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

export type DbIntegrityStatus = "unknown" | "ok" | "corrupt";

export const dbIntegrityStore = atom<DbIntegrityStatus>("unknown");
