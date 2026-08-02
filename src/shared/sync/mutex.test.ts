import { describe, expect, it } from "vitest";
import { NoopSyncTransport } from "./noop-transport";
import { SyncMutex, runSyncCycle } from "./mutex";

describe("NoopSyncTransport", () => {
  it("accepts all outbox items and returns empty pull", async () => {
    const transport = new NoopSyncTransport();
    const push = await transport.push([
      {
        idempotencyKey: "a",
        entity: "notes",
        op: "upsert",
        payload: { id: "1" },
      },
    ]);
    expect(push.accepted).toEqual(["a"]);
    expect(push.rejected).toEqual([]);

    const pull = await transport.pull(null);
    expect(pull.mutations).toEqual([]);
  });
});

describe("SyncMutex", () => {
  it("serializes exclusive runs", async () => {
    const mutex = new SyncMutex();
    const order: number[] = [];

    const first = mutex.runExclusive(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
      return "a";
    });

    const second = mutex.runExclusive(async () => {
      order.push(3);
      return "b";
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["a", "b"]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("runSyncCycle uses mutex and transport", async () => {
    const transport = new NoopSyncTransport();
    const mutex = new SyncMutex();
    const result = await runSyncCycle(transport, mutex, {
      cursor: null,
      outbox: [
        {
          idempotencyKey: "x",
          entity: "notes",
          op: "soft_delete",
          payload: {},
        },
      ],
    });
    expect(result.push.accepted).toEqual(["x"]);
    expect(result.pull.cursor).toBeNull();
  });
});
