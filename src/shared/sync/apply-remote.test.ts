import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../db/schemas";
import { createBodyDoc } from "../db/crdt";
import { createEntityId } from "../db/ids";
import { resetLamportForTests } from "../db/lamport";
import { SYNC_META_ID, type SyncMeta } from "../db/sync-meta";

/**
 * `@tanstack/db` is fully mocked below (transactions become a trivial
 * mutate-then-resolve, no real collection/persistence engine runs). This
 * file verifies applyRemoteMutations' own merge/lamport/cursor logic, not
 * TanStack DB or OPFS SQLite — those are only exercised for real in e2e.
 */
vi.mock("@tanstack/db", () => ({
  createTransaction: ({
    mutationFn,
  }: {
    mutationFn: (args: { transaction: unknown }) => Promise<void>;
  }) => {
    let mutateFn: (() => void) | null = null;
    return {
      mutate: (fn: () => void) => {
        mutateFn = fn;
      },
      commit: async () => {
        mutateFn?.();
        await mutationFn({ transaction: { mutations: [] } });
      },
    };
  },
}));

import {
  applyRemoteMutations,
  readSyncCursor,
  writeSyncCursor,
} from "./apply-remote";

function makeNote(partial: Partial<Note> = {}): Note {
  const body = createBodyDoc(partial.body ?? "body");
  return {
    id: createEntityId(),
    title: "t",
    title_lamport: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    deleted_lamport: 0,
    ...partial,
    body: partial.body ?? body.text,
    body_doc: partial.body_doc ?? body.doc,
  };
}

function fakeCollection<T extends { id: string }>() {
  const map = new Map<string, T>();
  return {
    map,
    get: (id: string) => map.get(id),
    insert: (row: T) => {
      map.set(row.id, row);
    },
    update: (id: string, cb: (draft: T) => void) => {
      const current = map.get(id);
      if (!current) return;
      const draft = { ...current };
      cb(draft);
      map.set(id, draft);
    },
    utils: {
      acceptMutations: vi.fn(async () => undefined),
    },
  };
}

describe("applyRemoteMutations", () => {
  beforeEach(() => {
    resetLamportForTests(0);
  });

  it("inserts a remote note when missing locally", async () => {
    const notes = fakeCollection<Note>();
    const syncMeta = fakeCollection<SyncMeta>();
    const remote = makeNote({ title: "remote" });

    const applied = await applyRemoteMutations(
      { notes: notes as never, syncMeta: syncMeta as never },
      [
        {
          idempotencyKey: "1",
          entity: "notes",
          op: "upsert",
          payload: remote,
        },
      ],
    );

    expect(applied).toBe(1);
    expect(notes.get(remote.id)?.title).toBe("remote");
  });

  it("merges into an existing note and skips no-op reimports", async () => {
    const notes = fakeCollection<Note>();
    const syncMeta = fakeCollection<SyncMeta>();
    const local = makeNote({ title: "local", title_lamport: 1 });
    notes.insert(local);

    const remote = {
      ...local,
      title: "remote",
      title_lamport: 5,
      updated_at: "2026-02-01T00:00:00.000Z",
    };

    const first = await applyRemoteMutations(
      { notes: notes as never, syncMeta: syncMeta as never },
      [{ idempotencyKey: "a", entity: "notes", op: "upsert", payload: remote }],
    );
    expect(first).toBe(1);
    expect(notes.get(local.id)?.title).toBe("remote");

    const second = await applyRemoteMutations(
      { notes: notes as never, syncMeta: syncMeta as never },
      [{ idempotencyKey: "b", entity: "notes", op: "upsert", payload: notes.get(local.id)! }],
    );
    expect(second).toBe(0);
  });

  it("writes and reads the sync cursor via sync_meta", async () => {
    const syncMeta = fakeCollection<SyncMeta>();
    expect(readSyncCursor(syncMeta as never)).toBeNull();

    await writeSyncCursor(syncMeta as never, "7");
    expect(readSyncCursor(syncMeta as never)).toBe("7");
    expect(syncMeta.get(SYNC_META_ID)?.cursor).toBe("7");

    await writeSyncCursor(syncMeta as never, "8");
    expect(readSyncCursor(syncMeta as never)).toBe("8");
  });
});
