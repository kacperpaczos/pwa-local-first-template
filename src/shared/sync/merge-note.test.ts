import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeNote } from "./merge-note";
import { createBodyDoc, updateBodyDoc } from "../db/crdt";
import type { Note } from "../db/schemas";
import { CONFLICT_LOG_STORAGE_KEY, listConflicts } from "./conflict-log";

function stubLocalStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

function note(partial: Partial<Note> & Pick<Note, "id">): Note {
  const body = createBodyDoc("");
  return {
    title: "t",
    title_lamport: 0,
    body: body.text,
    body_doc: body.doc,
    deleted_at: null,
    deleted_lamport: 0,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("mergeNote — title (per-field LWW)", () => {
  it("prefers the higher title_lamport", () => {
    const local = note({ id: "1", title: "local", title_lamport: 1 });
    const remote = note({ id: "1", title: "remote", title_lamport: 2 });
    expect(mergeNote(local, remote).title).toBe("remote");
  });

  it("ignores wall-clock updated_at on a lamport tie — value order decides", () => {
    // A later updated_at must NOT win: device clocks are unsynchronized, so
    // the outcome would depend on clock skew. The stable value comparison
    // picks "zulu" > "alpha" regardless of which side has the later clock.
    const local = note({
      id: "1",
      title: "zulu",
      title_lamport: 2,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const remote = note({
      id: "1",
      title: "alpha",
      title_lamport: 2,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    expect(mergeNote(local, remote).title).toBe("zulu");
  });

  it("does not let a body-only remote edit clobber a concurrent local title edit", () => {
    const local = note({ id: "1", title: "local title", title_lamport: 5 });
    const remote = note({ id: "1", title: "stale title", title_lamport: 1 });
    expect(mergeNote(local, remote).title).toBe("local title");
  });

  it("converges to the same title on both peers on an exact tie (lamport AND updated_at)", () => {
    // Regression test: an asymmetric "remote wins ties" rule makes device A
    // (which sees B as "remote") and device B (which sees A as "remote")
    // each pick their own side — permanent divergence. The tie-break must
    // be a pure function of the two values, independent of which side is
    // locally called "local" vs "remote".
    const deviceA = note({
      id: "1",
      title: "alpha",
      title_lamport: 3,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const deviceB = note({
      id: "1",
      title: "bravo",
      title_lamport: 3,
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const resolvedOnA = mergeNote(deviceA, deviceB).title;
    const resolvedOnB = mergeNote(deviceB, deviceA).title;
    expect(resolvedOnA).toBe(resolvedOnB);
  });
});

describe("mergeNote — deleted_at (per-field LWW)", () => {
  it("prefers the higher deleted_lamport, independent of title", () => {
    const local = note({ id: "1", deleted_at: null, deleted_lamport: 1 });
    const remote = note({ id: "1", deleted_at: "2026-01-01T00:00:00.000Z", deleted_lamport: 2 });
    const merged = mergeNote(local, remote);
    expect(merged.deleted_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps title and deleted_at independent under concurrent edits", () => {
    const local = note({
      id: "1",
      title: "new title",
      title_lamport: 5,
      deleted_at: null,
      deleted_lamport: 1,
    });
    const remote = note({
      id: "1",
      title: "old title",
      title_lamport: 1,
      deleted_at: "2026-01-01T00:00:00.000Z",
      deleted_lamport: 4,
    });
    const merged = mergeNote(local, remote);
    expect(merged.title).toBe("new title");
    expect(merged.deleted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(merged.title_lamport).toBe(5);
    expect(merged.deleted_lamport).toBe(4);
  });
});

describe("mergeNote — conflict_log recording", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records when remote title wins over a different local title", () => {
    const storage = stubLocalStorage();
    const local = note({ id: "1", title: "local", title_lamport: 1 });
    const remote = note({ id: "1", title: "remote", title_lamport: 2 });
    mergeNote(local, remote);
    const conflicts = listConflicts({ noteId: "1" }, storage);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      field: "title",
      lostValue: "local",
      lostLamport: 1,
      wonValue: "remote",
    });
    expect(storage.getItem(CONFLICT_LOG_STORAGE_KEY)).toBeTruthy();
  });

  it("records when remote deleted_at wins over a different local value", () => {
    const storage = stubLocalStorage();
    const local = note({ id: "1", deleted_at: null, deleted_lamport: 1 });
    const remote = note({
      id: "1",
      deleted_at: "2026-01-01T00:00:00.000Z",
      deleted_lamport: 2,
    });
    mergeNote(local, remote);
    const conflicts = listConflicts({ noteId: "1" }, storage);
    expect(conflicts.some((c) => c.field === "deleted_at")).toBe(true);
  });

  it("does not record when local title wins", () => {
    const storage = stubLocalStorage();
    const local = note({ id: "1", title: "local title", title_lamport: 5 });
    const remote = note({ id: "1", title: "stale title", title_lamport: 1 });
    mergeNote(local, remote);
    expect(listConflicts({ noteId: "1" }, storage)).toHaveLength(0);
  });

  it("is a no-op without localStorage", () => {
    vi.stubGlobal("localStorage", undefined);
    const local = note({ id: "1", title: "local", title_lamport: 1 });
    const remote = note({ id: "1", title: "remote", title_lamport: 2 });
    expect(() => mergeNote(local, remote)).not.toThrow();
  });
});

describe("mergeNote — body (CRDT merge, not LWW)", () => {
  it("merges concurrent, non-conflicting edits from a common ancestor", () => {
    const base = createBodyDoc("Hello world");

    const localEdit = updateBodyDoc(base.doc, "Hello brave world");
    const remoteEdit = updateBodyDoc(base.doc, "Hello world!");

    const local = note({ id: "1", body: localEdit.text, body_doc: localEdit.doc });
    const remote = note({ id: "1", body: remoteEdit.text, body_doc: remoteEdit.doc });

    const merged = mergeNote(local, remote);

    // A winner-takes-all LWW would produce one of the two edits; CRDT merge
    // combines both concurrent insertions instead of dropping either.
    expect(merged.body).toBe("Hello brave world!");
  });

  it("is symmetric regardless of merge direction", () => {
    const base = createBodyDoc("abc");
    const a = updateBodyDoc(base.doc, "xabc");
    const b = updateBodyDoc(base.doc, "abcy");

    const noteA = note({ id: "1", body: a.text, body_doc: a.doc });
    const noteB = note({ id: "1", body: b.text, body_doc: b.doc });

    expect(mergeNote(noteA, noteB).body).toBe(mergeNote(noteB, noteA).body);
  });

  it("updates body_doc after a CRDT merge and uses max clocks", () => {
    const base = createBodyDoc("Hello world");
    const localEdit = updateBodyDoc(base.doc, "Hello brave world");
    const remoteEdit = updateBodyDoc(base.doc, "Hello world!");
    const local = note({
      id: "1",
      body: localEdit.text,
      body_doc: localEdit.doc,
      title_lamport: 2,
      deleted_lamport: 3,
    });
    const remote = note({
      id: "1",
      body: remoteEdit.text,
      body_doc: remoteEdit.doc,
      title_lamport: 5,
      deleted_lamport: 1,
    });
    const merged = mergeNote(local, remote);
    expect(merged.body).toBe("Hello brave world!");
    expect(merged.body_doc).not.toBe(local.body_doc);
    expect(merged.body_doc).not.toBe(remote.body_doc);
    expect(merged.title_lamport).toBe(5);
    expect(merged.deleted_lamport).toBe(3);
  });
});
