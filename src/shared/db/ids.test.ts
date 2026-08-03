import { describe, expect, it, beforeEach } from "vitest";
import { createEntityId, isEntityId } from "./ids";
import { nextLamport, peekLamport, resetLamportForTests } from "./lamport";
import { parseCreateNoteInput, parseNote } from "./schemas";
import { createBodyDoc } from "./crdt";
import { parseSyncMutation } from "../sync/protocol";

describe("createEntityId", () => {
  it("returns UUIDv7-shaped ids", () => {
    const id = createEntityId();
    expect(isEntityId(id)).toBe(true);
  });
});

describe("lamport", () => {
  beforeEach(() => {
    resetLamportForTests(0);
  });

  it("increments monotonically and respects remote hints", () => {
    expect(nextLamport()).toBe(1);
    expect(nextLamport()).toBe(2);
    expect(nextLamport(10)).toBe(11);
    expect(peekLamport()).toBe(11);
  });
});

describe("schemas", () => {
  it("parses create note input and rejects empty title", () => {
    expect(parseCreateNoteInput({ title: "Hello", body: "x" })).toEqual({
      title: "Hello",
      body: "x",
    });
    expect(() => parseCreateNoteInput({ title: "" })).toThrow();
  });

  it("parses note and sync mutation message", () => {
    const body = createBodyDoc("");
    const note = parseNote({
      id: createEntityId(),
      title: "T",
      title_lamport: 1,
      body: body.text,
      body_doc: body.doc,
      updated_at: new Date().toISOString(),
      deleted_at: null,
      deleted_lamport: 0,
    });
    expect(note.deleted_at).toBeNull();

    const message = parseSyncMutation({
      idempotencyKey: "k1",
      entity: "notes",
      op: "upsert",
      payload: note,
    });
    expect(message.op).toBe("upsert");
  });
});
