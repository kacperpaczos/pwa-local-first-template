import { createTransaction } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import type { Note } from "../db/schemas";

/** Default tombstone retention: 90 days. */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type GcTombstonesOptions = {
  /** Wall-clock reference (Date, ISO string, or epoch ms). Default: Date.now(). */
  now?: number | string | Date;
  /** Age threshold for hard-deleting soft-deleted notes. Default: {@link TOMBSTONE_RETENTION_MS}. */
  retentionMs?: number;
  /**
   * Real coverage gate: hard-delete only tombstones every other device has
   * seen (SyncEngine.isOpCovered over the ack maps). Without it, a tombstone
   * GC'd before reaching a peer resurrects when that peer later syncs its
   * pre-delete copy — the retention window is then the only backstop.
   */
  isCovered?: (note: Note) => boolean;
};

function toEpochMs(now: number | string | Date | undefined): number {
  if (now === undefined) return Date.now();
  if (typeof now === "number") return now;
  if (now instanceof Date) return now.getTime();
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Physically remove soft-deleted notes older than the retention window.
 * Local-only (acceptMutations) — does not enqueue outbox soft_delete events.
 * Returns the number of rows hard-deleted.
 */
export async function gcTombstones(
  notes: Collection<Note, string>,
  options: GcTombstonesOptions = {},
): Promise<number> {
  const nowMs = toEpochMs(options.now);
  const retentionMs = options.retentionMs ?? TOMBSTONE_RETENTION_MS;
  const cutoff = nowMs - retentionMs;

  const doomed = notes.toArray.filter((note) => {
    if (note.deleted_at == null) return false;
    const deletedMs = Date.parse(note.deleted_at);
    if (!Number.isFinite(deletedMs) || deletedMs > cutoff) return false;
    if (options.isCovered && !options.isCovered(note)) return false;
    return true;
  });

  if (doomed.length === 0) return 0;

  const ids = doomed.map((n) => n.id);
  const tx = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction }) => {
      notes.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(() => {
    for (const id of ids) {
      notes.delete(id);
    }
  });
  await tx.commit();

  return ids.length;
}
