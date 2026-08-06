import { createTransaction, type Collection } from "@tanstack/db";
import { nextLamport } from "@/shared/db/lamport";
import { parseNote, type Note } from "@/shared/db/schemas";
import type { NoteOpPayload } from "@/shared/oplog/payload";
import { notesEqual } from "@/shared/store/materialize";
import type { OpLogStore } from "@/shared/store/oplog-store";
import { mergeNote } from "@/shared/sync/merge-note";
import { withSyncEngineLock } from "@/shared/sync/engine";
import { backupSchema, type Backup } from "./export";

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

export type ImportTarget = {
  notes: Collection<Note, string>;
  store: OpLogStore;
};

async function persistLocal(notes: Collection<Note, string>, mutate: () => void): Promise<void> {
  const tx = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction }) => {
      notes.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(mutate);
  await tx.commit();
}

/**
 * Backup rows go through the SAME per-field resolution as remote ops
 * (`mergeNote`): new rows insert, existing rows merge — re-importing the
 * same file is a no-op. Every row the import actually changed is appended
 * to this device's own log as an upsert op, so paired devices receive the
 * restored data through the normal sync path.
 *
 * Runs under the sync-engine lock — without it, an import racing the
 * background sync cycle can read a `local` row before the cycle's write
 * lands and clobber it.
 */
export async function importBackup(target: ImportTarget, backup: Backup): Promise<ImportSummary> {
  const applied = await withSyncEngineLock(async () => {
    let count = 0;
    for (const raw of backup.notes) {
      const remote = parseNote(raw);
      nextLamport(Math.max(remote.title_lamport, remote.deleted_lamport));

      const local = target.notes.get(remote.id);
      const next = local ? mergeNote(local, remote) : remote;
      if (local && notesEqual(next, local)) {
        continue;
      }

      await persistLocal(target.notes, () => {
        if (local) {
          target.notes.update(remote.id, (draft) => Object.assign(draft, next));
        } else {
          target.notes.insert(next);
        }
      });
      await target.store.append("notes", { kind: "upsert", note: next } satisfies NoteOpPayload);
      count += 1;
    }
    return count;
  });

  return { totalInBackup: backup.notes.length, applied };
}
