import {
  exportSpaceKey,
  generateSpaceKey,
  importSpaceKey,
  type SealedBlob,
} from "@/shared/crypto/envelope";

export const SPACE_ID_STORAGE_KEY = "pwa-space-id";
export const SPACE_KEY_STORAGE_KEY = "pwa-space-key";

export type SpaceRecord = {
  spaceId: string;
  key: CryptoKey;
};

function newSpaceId(): string {
  return crypto.randomUUID();
}

export function loadSpaceId(storage: Pick<Storage, "getItem"> = localStorage): string | null {
  return storage.getItem(SPACE_ID_STORAGE_KEY);
}

/** Load existing space or create + persist a new id and raw AES key. */
export async function ensureSpace(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): Promise<SpaceRecord> {
  const existingId = storage.getItem(SPACE_ID_STORAGE_KEY);
  const existingKey = storage.getItem(SPACE_KEY_STORAGE_KEY);
  if (existingId && existingKey) {
    return { spaceId: existingId, key: await importSpaceKey(existingKey) };
  }

  const spaceId = existingId ?? newSpaceId();
  const key = existingKey ? await importSpaceKey(existingKey) : await generateSpaceKey();
  const exported = existingKey ?? (await exportSpaceKey(key));

  storage.setItem(SPACE_ID_STORAGE_KEY, spaceId);
  storage.setItem(SPACE_KEY_STORAGE_KEY, exported);
  return { spaceId, key };
}

export async function getSpaceKey(
  storage: Pick<Storage, "getItem"> = localStorage,
): Promise<CryptoKey> {
  const raw = storage.getItem(SPACE_KEY_STORAGE_KEY);
  if (!raw) {
    throw new Error("No space key stored — call ensureSpace() first");
  }
  return importSpaceKey(raw);
}

export async function saveSpace(
  spaceId: string,
  key: CryptoKey,
  storage: Pick<Storage, "setItem"> = localStorage,
): Promise<void> {
  storage.setItem(SPACE_ID_STORAGE_KEY, spaceId);
  storage.setItem(SPACE_KEY_STORAGE_KEY, await exportSpaceKey(key));
}

/** Persist an already-exported raw key (pairing / recovery import). */
export function saveSpaceExported(
  spaceId: string,
  spaceKeyB64: string,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(SPACE_ID_STORAGE_KEY, spaceId);
  storage.setItem(SPACE_KEY_STORAGE_KEY, spaceKeyB64);
}

export function clearSpace(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(SPACE_ID_STORAGE_KEY);
  storage.removeItem(SPACE_KEY_STORAGE_KEY);
}

export type { SealedBlob };
