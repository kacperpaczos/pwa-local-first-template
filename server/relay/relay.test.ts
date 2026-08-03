import { describe, expect, it, beforeEach } from "vitest";
import { RelayStore } from "./store";
import { createBodyDoc } from "../../src/shared/db/crdt";
import { createEntityId } from "../../src/shared/db/ids";

function validMutation(idempotencyKey: string, title = "T") {
  const body = createBodyDoc("hi");
  return {
    idempotencyKey,
    entity: "notes" as const,
    op: "upsert" as const,
    payload: {
      id: createEntityId(),
      title,
      title_lamport: 1,
      body: body.text,
      body_doc: body.doc,
      updated_at: new Date().toISOString(),
      deleted_at: null,
      deleted_lamport: 0,
    },
  };
}

describe("RelayStore", () => {
  let store: RelayStore;

  beforeEach(() => {
    store = new RelayStore();
  });

  it("accepts valid mutations and advances cursor", () => {
    const push = store.push([validMutation("k1")]);
    expect(push.accepted).toEqual(["k1"]);
    expect(push.rejected).toEqual([]);

    const pull = store.pull(null);
    expect(pull.mutations).toHaveLength(1);
    expect(pull.cursor).toBe("1");
    expect(store.stats()).toEqual({ entries: 1, keys: 1 });
  });

  it("treats duplicate idempotency keys as accepted without duplicating the log", () => {
    const m = validMutation("dup");
    store.push([m]);
    store.push([m]);
    expect(store.stats().entries).toBe(1);
    expect(store.pull(null).mutations).toHaveLength(1);
  });

  it("rejects invalid mutations", () => {
    const outcome = store.push([{ idempotencyKey: "bad", entity: "notes", op: "upsert" }]);
    expect(outcome.accepted).toEqual([]);
    expect(outcome.rejected[0]?.reason).toBe("invalid_mutation");
  });

  it("pulls only entries after the cursor", () => {
    store.push([validMutation("a")]);
    store.push([validMutation("b")]);
    const pull = store.pull("1");
    expect(pull.mutations).toHaveLength(1);
    expect(pull.mutations[0]?.idempotencyKey).toBe("b");
    expect(pull.cursor).toBe("2");
  });

  it("reset clears log and keys", () => {
    store.push([validMutation("x")]);
    store.reset();
    expect(store.stats()).toEqual({ entries: 0, keys: 0 });
    expect(store.pull(null).mutations).toEqual([]);
  });
});
