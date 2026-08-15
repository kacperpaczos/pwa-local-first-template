import { describe, expect, it } from "vitest";
import {
  isSupportedProtocolVersion,
  parseSyncMutation,
  PROTOCOL_VERSION,
  ProtocolVersionError,
  SUPPORTED_MAX_V,
  SUPPORTED_MIN_V,
  UnknownEntityError,
} from "./protocol";
import { createBodyDoc } from "../db/crdt";
import { createEntityId } from "../db/ids";
import { parseNote } from "../db/schemas";

function notePayload(title = "Hello") {
  const body = createBodyDoc("body");
  return {
    id: createEntityId(),
    title,
    title_lamport: 1,
    body: body.text,
    body_doc: body.doc,
    updated_at: new Date().toISOString(),
    deleted_at: null,
    deleted_lamport: 0,
  };
}

describe("sync protocol", () => {
  it("defaults missing v to PROTOCOL_VERSION and round-trips body_doc", () => {
    const mutation = {
      idempotencyKey: "k1",
      entity: "notes" as const,
      op: "upsert" as const,
      payload: notePayload(),
    };
    const parsed = parseSyncMutation(mutation);
    expect(parsed.v).toBe(PROTOCOL_VERSION);
    expect(parsed.idempotencyKey).toBe("k1");
    expect(parseNote(parsed.payload).body_doc).toBe(mutation.payload.body_doc);
  });

  it("accepts an explicit supported version", () => {
    const parsed = parseSyncMutation({
      v: PROTOCOL_VERSION,
      idempotencyKey: "k2",
      entity: "notes",
      op: "upsert",
      payload: notePayload("X"),
    });
    expect(parsed.v).toBe(PROTOCOL_VERSION);
  });

  it("rejects invalid mutation payloads", () => {
    expect(() =>
      parseSyncMutation({
        idempotencyKey: "",
        entity: "notes",
        op: "upsert",
        payload: {},
      }),
    ).toThrow();
  });

  it("rejects versions outside the supported range with ProtocolVersionError", () => {
    const tooHigh = SUPPORTED_MAX_V + 1;
    const tooLow = SUPPORTED_MIN_V - 1;

    expect(isSupportedProtocolVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedProtocolVersion(tooHigh)).toBe(false);
    expect(isSupportedProtocolVersion(tooLow)).toBe(false);
    expect(isSupportedProtocolVersion(1.5)).toBe(false);

    expect(() =>
      parseSyncMutation({
        v: tooHigh,
        idempotencyKey: "k3",
        entity: "notes",
        op: "upsert",
        payload: notePayload(),
      }),
    ).toThrow(ProtocolVersionError);

    try {
      parseSyncMutation({
        v: tooLow,
        idempotencyKey: "k4",
        entity: "notes",
        op: "upsert",
        payload: notePayload(),
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolVersionError);
      expect((error as ProtocolVersionError).version).toBe(tooLow);
      expect((error as ProtocolVersionError).message).toMatch(/Unsupported protocol version/);
    }
  });

  it("rejects an unregistered entity with UnknownEntityError", () => {
    try {
      parseSyncMutation({
        idempotencyKey: "k5",
        entity: "widgets",
        op: "upsert",
        payload: {},
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownEntityError);
      expect((error as UnknownEntityError).entity).toBe("widgets");
    }
  });
});
