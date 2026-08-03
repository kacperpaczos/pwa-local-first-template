/** Safety margin over the raw model size before we let a download start. */
const SAFETY_FACTOR = 1.2;

export type StorageHeadroom = {
  ok: boolean;
  quota: number | null;
  usage: number | null;
  required: number;
};

export async function estimateStorageHeadroom(requiredBytes: number): Promise<StorageHeadroom> {
  const required = requiredBytes * SAFETY_FACTOR;

  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    // API unsupported: don't block the download on a check we can't perform.
    return { ok: true, quota: null, usage: null, required };
  }

  const { quota, usage } = await navigator.storage.estimate();
  if (quota == null) {
    return { ok: true, quota: null, usage: usage ?? null, required };
  }

  const free = quota - (usage ?? 0);
  return { ok: free >= required, quota, usage: usage ?? null, required };
}
