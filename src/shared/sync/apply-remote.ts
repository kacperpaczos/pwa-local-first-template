import { createTransaction } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import type { Note } from "../db/schemas";
import { parseNote } from "../db/schemas";
import { nextLamport } from "../db/lamport";
import type { SyncMeta } from "../db/sync-meta";
import { RELAY_SYNC_META_ID } from "../db/sync-meta";
import { parseSyncMutation } from "./protocol";
import { shouldApplyRemote } from "./lww";
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
    nextLamport(remote.lamport);

    const local = target.notes.get(remote.id);

    if (!shouldApplyRemote(local, remote)) {
      continue;
    }

    if (!local) {
      await persistLocal(target.notes, () => {
        target.notes.insert(remote);
      });
    } else {
      await persistLocal(target.notes, () => {
        target.notes.update(remote.id, (draft) => {
          draft.title = remote.title;
          draft.body = remote.body;
          draft.updated_at = remote.updated_at;
          draft.deleted_at = remote.deleted_at;
          draft.lamport = remote.lamport;
        });
      });
    }
    applied += 1;
  }

  return applied;
}

export function readRelayCursor(syncMeta: Collection<SyncMeta, string>): string | null {
  return syncMeta.get(RELAY_SYNC_META_ID)?.cursor ?? null;
}

export async function writeRelayCursor(
  syncMeta: Collection<SyncMeta, string>,
  cursor: string | null,
): Promise<void> {
  const existing = syncMeta.get(RELAY_SYNC_META_ID);
  const updated_at = new Date().toISOString();

  if (!existing) {
    await persistSyncMeta(syncMeta, () => {
      syncMeta.insert({
        id: RELAY_SYNC_META_ID,
        cursor,
        updated_at,
      });
    });
    return;
  }

  await persistSyncMeta(syncMeta, () => {
    syncMeta.update(RELAY_SYNC_META_ID, (draft) => {
      draft.cursor = cursor;
      draft.updated_at = updated_at;
    });
  });
}

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
