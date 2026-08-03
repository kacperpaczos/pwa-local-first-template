import { describe, expect, it } from "vitest";
import { mergeNote } from "./merge-note";
import { createBodyDoc, updateBodyDoc } from "../db/crdt";
import type { Note } from "../db/schemas";

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

  it("uses updated_at as a tiebreaker when title_lamport ties", () => {
    const local = note({
      id: "1",
      title: "local",
      title_lamport: 2,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const remote = note({
      id: "1",
      title: "remote",
      title_lamport: 2,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    expect(mergeNote(local, remote).title).toBe("remote");
  });

  it("does not let a body-only remote edit clobber a concurrent local title edit", () => {
    const local = note({ id: "1", title: "local title", title_lamport: 5 });
    const remote = note({ id: "1", title: "stale title", title_lamport: 1 });
    expect(mergeNote(local, remote).title).toBe("local title");
  });
});

describe("mergeNote — deleted_at (per-field LWW)", () => {
  it("prefers the higher deleted_lamport, independent of title", () => {
    const local = note({ id: "1", deleted_at: null, deleted_lamport: 1 });
    const remote = note({ id: "1", deleted_at: "2026-01-01T00:00:00.000Z", deleted_lamport: 2 });
    const merged = mergeNote(local, remote);
    expect(merged.deleted_at).toBe("2026-01-01T00:00:00.000Z");
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
});
