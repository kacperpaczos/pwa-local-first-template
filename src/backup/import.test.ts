import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../shared/db/schemas";
import { createBodyDoc } from "../shared/db/crdt";
import { createEntityId } from "../shared/db/ids";
import { resetLamportForTests } from "../shared/db/lamport";

/**
 * `@tanstack/db` is fully mocked below (transactions become a trivial
 * mutate-then-resolve, no real collection/persistence engine runs). This
 * file verifies the import/merge logic itself, not TanStack DB or OPFS
 * SQLite — those are only exercised for real in e2e (`e2e/backup.spec.ts`).
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

import type { Backup } from "./export";
import { importBackup, parseBackupFile } from "./import";
import { SyncMutex } from "../shared/sync/mutex";

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

function fakeCollection<T extends { id: string }>(rows: T[] = []) {
  const map = new Map(rows.map((r) => [r.id, r]));
  return {
    get toArray() {
      return [...map.values()];
    },
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
    utils: { acceptMutations: vi.fn(async () => undefined) },
  };
}

describe("parseBackupFile", () => {
  it("rejects malformed JSON", () => {
    expect(() => parseBackupFile("not json")).toThrow();
  });

  it("rejects a payload that doesn't match the schema", () => {
    expect(() => parseBackupFile(JSON.stringify({ notes: "nope" }))).toThrow();
  });

  it("accepts a well-formed backup", () => {
    const note = makeNote();
    const backup: Backup = {
      formatVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      notes: [note],
    };
    expect(parseBackupFile(JSON.stringify(backup))).toEqual(backup);
  });
});

describe("importBackup", () => {
  beforeEach(() => {
    resetLamportForTests(0);
  });

  it("inserts notes missing locally", async () => {
    const notes = fakeCollection<Note>();
    const syncMeta = fakeCollection();
    const note = makeNote({ title: "from backup" });
    const backup: Backup = {
      formatVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      notes: [note],
    };

    const summary = await importBackup(
      { notes: notes as never, syncMeta: syncMeta as never },
      new SyncMutex(),
      backup,
    );

    expect(summary).toEqual({ totalInBackup: 1, applied: 1 });
    expect(notes.get(note.id)?.title).toBe("from backup");
  });

  it("importing the same backup twice does not duplicate or overwrite with stale data", async () => {
    const notes = fakeCollection<Note>();
    const syncMeta = fakeCollection();
    const note = makeNote({ title: "stable" });
    const backup: Backup = {
      formatVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      notes: [note],
    };
    const mutex = new SyncMutex();

    const first = await importBackup(
      { notes: notes as never, syncMeta: syncMeta as never },
      mutex,
      backup,
    );
    expect(first.applied).toBe(1);
    expect(notes.toArray).toHaveLength(1);

    const second = await importBackup(
      { notes: notes as never, syncMeta: syncMeta as never },
      mutex,
      backup,
    );
    expect(second.applied).toBe(0); // merge saw identical data — no-op, not a duplicate row
    expect(notes.toArray).toHaveLength(1);
    expect(notes.get(note.id)?.title).toBe("stable");
  });

  it("merges an imported note against a newer local edit via per-field LWW, not overwrite", async () => {
    const notes = fakeCollection<Note>();
    const syncMeta = fakeCollection();
    const backedUp = makeNote({ title: "old title", title_lamport: 1 });
    notes.insert({ ...backedUp, title: "newer local title", title_lamport: 9 });

    const backup: Backup = {
      formatVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      notes: [backedUp],
    };
    await importBackup(
      { notes: notes as never, syncMeta: syncMeta as never },
      new SyncMutex(),
      backup,
    );

    expect(notes.get(backedUp.id)?.title).toBe("newer local title");
  });

  it("waits for an in-flight sync-mutex holder before applying (no interleaving with pullRemote)", async () => {
    const notes = fakeCollection<Note>();
    const syncMeta = fakeCollection();
    const note = makeNote({ title: "from backup" });
    const backup: Backup = {
      formatVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      notes: [note],
    };
    const mutex = new SyncMutex();

    let releaseHolder!: () => void;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holding = mutex.runExclusive(() => holderDone);

    const importPromise = importBackup(
      { notes: notes as never, syncMeta: syncMeta as never },
      mutex,
      backup,
    );

    // While the mutex is held elsewhere, the import must not have run yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(notes.get(note.id)).toBeUndefined();

    releaseHolder();
    await holding;
    await importPromise;

    expect(notes.get(note.id)?.title).toBe("from backup");
  });
});
