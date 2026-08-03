import { createTransaction } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import type { Note } from "../db/schemas";
import { parseNote } from "../db/schemas";
import { nextLamport } from "../db/lamport";
import type { SyncMeta } from "../db/sync-meta";
import { SYNC_META_ID } from "../db/sync-meta";
import { parseSyncMutation } from "./protocol";
import { mergeNote } from "./merge-note";
import type { SyncMutation } from "./transport";
import { setSyncStatus } from "./status";

export type SyncApplyTarget = {
  notes: Collection<Note, string>;
  syncMeta: Collection<SyncMeta, string>;
};

async function persistLocal(
  notes: Collection<Note, string>,
  mutate: () => void,
): Promise<void> {
  const tx = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction }) => {
      notes.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(mutate);
  await tx.commit();
}

async function persistSyncMeta(
  syncMeta: Collection<SyncMeta, string>,
  mutate: () => void,
): Promise<void> {
  const tx = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction }) => {
      syncMeta.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(mutate);
  await tx.commit();
}

export async function applyRemoteMutations(
  target: SyncApplyTarget,
  mutations: readonly SyncMutation[],
): Promise<number> {
  let applied = 0;

  for (const raw of mutations) {
    let validated;
    try {
      validated = parseSyncMutation(raw);
    } catch {
      continue;
    }

    const remote = parseNote(validated.payload);
    nextLamport(Math.max(remote.title_lamport, remote.deleted_lamport));

    const local = target.notes.get(remote.id);

    if (!local) {
      await persistLocal(target.notes, () => {
        target.notes.insert(remote);
      });
      applied += 1;
      continue;
    }

    const merged = mergeNote(local, remote);
    if (
      merged.title === local.title &&
      merged.body === local.body &&
      merged.deleted_at === local.deleted_at &&
      merged.title_lamport === local.title_lamport &&
      merged.deleted_lamport === local.deleted_lamport
    ) {
      continue;
    }

    await persistLocal(target.notes, () => {
      target.notes.update(remote.id, (draft) => {
        draft.title = merged.title;
        draft.title_lamport = merged.title_lamport;
        draft.body = merged.body;
        draft.body_doc = merged.body_doc;
        draft.updated_at = merged.updated_at;
        draft.deleted_at = merged.deleted_at;
        draft.deleted_lamport = merged.deleted_lamport;
      });
    });
    applied += 1;
  }

  return applied;
}

export function readSyncCursor(syncMeta: Collection<SyncMeta, string>): string | null {
  return syncMeta.get(SYNC_META_ID)?.cursor ?? null;
}

/** @deprecated Use readSyncCursor */
export const readRelayCursor = readSyncCursor;

export async function writeSyncCursor(
  syncMeta: Collection<SyncMeta, string>,
  cursor: string | null,
): Promise<void> {
  const existing = syncMeta.get(SYNC_META_ID);
  const updated_at = new Date().toISOString();

  if (!existing) {
    await persistSyncMeta(syncMeta, () => {
      syncMeta.insert({
        id: SYNC_META_ID,
        cursor,
        updated_at,
      });
    });
    return;
  }

  await persistSyncMeta(syncMeta, () => {
    syncMeta.update(SYNC_META_ID, (draft) => {
      draft.cursor = cursor;
      draft.updated_at = updated_at;
    });
  });
}

/** @deprecated Use writeSyncCursor */
export const writeRelayCursor = writeSyncCursor;

export function withSyncStatus<T>(fn: () => Promise<T>): Promise<T> {
  setSyncStatus("syncing");
  return fn().then(
    (value) => {
      setSyncStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "idle");
      return value;
    },
    (error) => {
      setSyncStatus(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "idle");
      throw error;
    },
  );
}
