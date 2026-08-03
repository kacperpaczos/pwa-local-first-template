import { backupSchema, type Backup } from "./export";
import { applyRemoteMutations, type SyncApplyTarget } from "@/shared/sync/apply-remote";
import type { SyncMutation } from "@/shared/sync/transport";
import type { SyncMutex } from "@/shared/sync/mutex";

/** Untrusted boundary: parse + validate before anything touches the DB. */
export function parseBackupFile(raw: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("File is not valid JSON.");
  }
  return backupSchema.parse(data);
}

export type ImportSummary = {
  totalInBackup: number;
  applied: number;
};

/**
 * Routes every backed-up note through the exact same path as a remote sync
 * mutation (`applyRemoteMutations`): new rows are inserted, existing rows go
 * through `mergeNote` (per-field LWW + CRDT body merge) instead of being
 * overwritten. Re-importing the same file is therefore a no-op — `merged`
 * equals `local` for every row, so nothing is written twice.
 *
 * Runs under the same `syncMutex` as `pullRemote`/the outbox's sync cycle —
 * without it, an import racing the page's own background pull can read a
 * `local` row before the pull's write lands and clobber it (both paths call
 * `applyRemoteMutations` on the same collections; only the mutex makes that
 * safe to interleave).
 */
export async function importBackup(
  target: SyncApplyTarget,
  syncMutex: SyncMutex,
  backup: Backup,
): Promise<ImportSummary> {
  const mutations: SyncMutation[] = backup.notes.map((note) => ({
    idempotencyKey: `backup:${note.id}:${note.updated_at}`,
    entity: "notes",
    op: note.deleted_at ? "soft_delete" : "upsert",
    payload: note,
  }));

  const applied = await syncMutex.runExclusive(() => applyRemoteMutations(target, mutations));
  return { totalInBackup: backup.notes.length, applied };
}
