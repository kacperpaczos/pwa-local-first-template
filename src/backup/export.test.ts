import { describe, expect, it } from "vitest";
import type { Note } from "../shared/db/schemas";
import { createBodyDoc } from "../shared/db/crdt";
import { createEntityId } from "../shared/db/ids";
import { BACKUP_FORMAT_VERSION, backupSchema, exportNotesAsBackup, serializeBackup } from "./export";

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

function fakeCollection<T>(rows: T[]) {
  return { toArray: rows } as never;
}

describe("exportNotesAsBackup", () => {
  it("includes soft-deleted rows (tombstones matter for consistency)", () => {
    const active = makeNote({ title: "active" });
    const deleted = makeNote({ title: "gone", deleted_at: "2026-01-02T00:00:00.000Z" });

    const backup = exportNotesAsBackup(fakeCollection([active, deleted]));

    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.notes.map((n) => n.id).sort()).toEqual([active.id, deleted.id].sort());
  });

  it("produces a payload that round-trips through the Zod schema", () => {
    const note = makeNote();
    const backup = exportNotesAsBackup(fakeCollection([note]));
    const serialized = serializeBackup(backup);
    const parsed = backupSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(backup);
  });
});
