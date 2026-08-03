import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../db/schemas";
import { createBodyDoc } from "../db/crdt";
import { TOMBSTONE_RETENTION_MS, gcTombstones } from "./gc";

/**
 * `@tanstack/db` is fully mocked below (transactions become a trivial
 * mutate-then-resolve, no real collection/persistence engine runs). This
 * file verifies gcTombstones' own retention/threshold logic, not TanStack
 * DB or OPFS SQLite — those are only exercised for real in e2e.
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

function makeNote(partial: Partial<Note> & Pick<Note, "id">): Note {
  const body = createBodyDoc("");
  return {
    title: "t",
    title_lamport: 1,
    body: body.text,
    body_doc: body.doc,
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    deleted_lamport: 0,
    ...partial,
  };
}

function fakeNotes(rows: Note[] = []) {
  const map = new Map(rows.map((r) => [r.id, r]));
  return {
    get toArray() {
      return [...map.values()];
    },
    get: (id: string) => map.get(id),
    delete: (id: string) => {
      map.delete(id);
    },
    utils: { acceptMutations: vi.fn(async () => undefined) },
  };
}

describe("gcTombstones", () => {
  const now = Date.parse("2026-08-03T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes a 90-day default retention", () => {
    expect(TOMBSTONE_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("hard-deletes soft-deleted notes older than retention", async () => {
    const oldDeleted = makeNote({
      id: "old",
      deleted_at: "2026-01-01T00:00:00.000Z",
      deleted_lamport: 3,
    });
    const recentDeleted = makeNote({
      id: "recent",
      deleted_at: "2026-07-20T00:00:00.000Z",
      deleted_lamport: 4,
    });
    const active = makeNote({ id: "active" });
    const notes = fakeNotes([oldDeleted, recentDeleted, active]);

    const removed = await gcTombstones(notes as never, { now, retentionMs: TOMBSTONE_RETENTION_MS });

    expect(removed).toBe(1);
    expect(notes.get("old")).toBeUndefined();
    expect(notes.get("recent")).toBeDefined();
    expect(notes.get("active")).toBeDefined();
  });

  it("returns 0 when nothing qualifies", async () => {
    const notes = fakeNotes([makeNote({ id: "a" })]);
    expect(await gcTombstones(notes as never, { now })).toBe(0);
  });

  it("respects coveredSeq gate on deleted_lamport", async () => {
    const covered = makeNote({
      id: "covered",
      deleted_at: "2026-01-01T00:00:00.000Z",
      deleted_lamport: 5,
    });
    const uncovered = makeNote({
      id: "uncovered",
      deleted_at: "2026-01-01T00:00:00.000Z",
      deleted_lamport: 20,
    });
    const notes = fakeNotes([covered, uncovered]);

    const removed = await gcTombstones(notes as never, {
      now,
      retentionMs: TOMBSTONE_RETENTION_MS,
      coveredSeq: 10,
    });

    expect(removed).toBe(1);
    expect(notes.get("covered")).toBeUndefined();
    expect(notes.get("uncovered")).toBeDefined();
  });

  it("honours a custom retentionMs", async () => {
    const notes = fakeNotes([
      makeNote({
        id: "x",
        deleted_at: "2026-08-02T12:00:00.000Z",
        deleted_lamport: 1,
      }),
    ]);
    expect(await gcTombstones(notes as never, { now, retentionMs: 60 * 60 * 1000 })).toBe(1);
    expect(notes.get("x")).toBeUndefined();
  });
});
