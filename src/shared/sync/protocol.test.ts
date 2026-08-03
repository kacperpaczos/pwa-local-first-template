import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  parseSyncMutation,
} from "./protocol";
import { createBodyDoc } from "../db/crdt";
import { createEntityId } from "../db/ids";

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
  it("parses a valid client push and round-trips a mutation with body_doc", () => {
    const mutation = {
      idempotencyKey: "k1",
      entity: "notes" as const,
      op: "upsert" as const,
      payload: notePayload(),
    };
    const msg = parseClientMessage({
      type: "push",
      requestId: "r1",
      mutations: [mutation],
    });
    expect(msg.type).toBe("push");
    if (msg.type === "push") {
      expect(msg.mutations[0]?.payload.body_doc).toBe(mutation.payload.body_doc);
    }
    expect(parseSyncMutation(mutation).idempotencyKey).toBe("k1");
  });

  it("parses a valid client pull", () => {
    const msg = parseClientMessage({
      type: "pull",
      requestId: "r2",
      cursor: "3",
    });
    expect(msg).toEqual({ type: "pull", requestId: "r2", cursor: "3" });
  });

  it("parses push_ack and pull_result server messages", () => {
    expect(
      parseServerMessage({
        type: "push_ack",
        requestId: "r",
        accepted: ["a"],
        rejected: [],
      }),
    ).toMatchObject({ type: "push_ack", accepted: ["a"] });

    const mutation = {
      idempotencyKey: "k2",
      entity: "notes" as const,
      op: "upsert" as const,
      payload: notePayload("X"),
    };
    const pull = parseServerMessage({
      type: "pull_result",
      requestId: "r",
      cursor: "1",
      mutations: [mutation],
    });
    expect(pull.type).toBe("pull_result");
  });

  it("rejects invalid client and server payloads", () => {
    expect(() => parseClientMessage({ type: "push" })).toThrow();
    expect(() => parseServerMessage({ type: "push_ack" })).toThrow();
    expect(() =>
      parseSyncMutation({ idempotencyKey: "", entity: "notes", op: "upsert", payload: {} }),
    ).toThrow();
  });
});
