export const ORIGIN_STORAGE_KEY = "pwa-lf-origin-id";

/**
 * Per-device-install identifier used only to disambiguate independent
 * writers in the sync cursor (see GunSyncTransport). Deliberately NOT part
 * of the pairing payload — every paired device shares the same SEA pair
 * (see shared/identity/pair.ts), so pair.pub cannot serve as a tie-breaker
 * between devices. Each device generates and keeps its own origin id.
 */
export function ensureOriginId(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): string {
  const existing = storage.getItem(ORIGIN_STORAGE_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  storage.setItem(ORIGIN_STORAGE_KEY, id);
  return id;
}
