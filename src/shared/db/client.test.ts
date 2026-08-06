import { describe, expect, it } from "vitest";
import { mutationsFromTransaction, opForMutationType } from "./client";

/**
 * `openAppDatabase` itself needs real OPFS + wa-sqlite and is only
 * exercised in e2e (backup.spec.ts, multi-tab.spec.ts, offline-sync.spec.ts
 * all boot a real DB). This file covers the pure logic that turns a
 * `@tanstack/db` transaction into outbox `SyncMutation`s.
 */
describe("opForMutationType", () => {
  it("maps delete to soft_delete", () => {
    expect(opForMutationType("delete")).toBe("soft_delete");
  });

  it("maps insert and update to upsert", () => {
    expect(opForMutationType("insert")).toBe("upsert");
    expect(opForMutationType("update")).toBe("upsert");
  });
});

describe("mutationsFromTransaction", () => {
  it("uses modified payload for insert/update, keyed with an index suffix", () => {
    const result = mutationsFromTransaction("tx1", [
      { type: "insert", modified: { id: "a" }, original: undefined },
      { type: "update", modified: { id: "a", title: "new" }, original: { id: "a", title: "old" } },
    ]);

    expect(result).toEqual([
      { idempotencyKey: "tx1:0", entity: "notes", op: "upsert", payload: { id: "a" } },
      {
        idempotencyKey: "tx1:1",
        entity: "notes",
        op: "upsert",
        payload: { id: "a", title: "new" },
      },
    ]);
  });

  it("uses the original payload for delete (soft_delete carries the pre-delete row)", () => {
    const result = mutationsFromTransaction("tx1", [
      { type: "delete", modified: undefined, original: { id: "a", deleted_at: null } },
    ]);

    expect(result).toEqual([
      {
        idempotencyKey: "tx1:0",
        entity: "notes",
        op: "soft_delete",
        payload: { id: "a", deleted_at: null },
      },
    ]);
  });

  it("falls back to original when modified is absent on a non-delete mutation", () => {
    const result = mutationsFromTransaction("tx1", [
      { type: "update", modified: undefined, original: { id: "a" } },
    ]);
    expect(result[0]?.payload).toEqual({ id: "a" });
  });
});
