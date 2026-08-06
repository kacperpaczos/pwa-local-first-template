import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "@/shared/identity/device";
import { createOperation, type Operation } from "@/shared/oplog/header";
import { encodeOpPayload } from "@/shared/oplog/payload";
import { MemoryOpLogPersistence } from "./oplog-persistence";
import { OpLogStore, memoryHeadCounter } from "./oplog-store";

const ENTITY = "notes";

function makeStore(
  persistence = new MemoryOpLogPersistence(),
  device = generateDeviceKey(),
  counter = memoryHeadCounter(),
) {
  return {
    persistence,
    device,
    counter,
    store: new OpLogStore({ persistence, device, headCounter: counter }),
  };
}

function remoteOp(
  device: ReturnType<typeof generateDeviceKey>,
  seq: number,
  backlink: string | null,
  payload: unknown = { kind: "upsert", note: { id: `n${seq}` } },
): { op: Operation; bytes: Uint8Array } {
  const bytes = encodeOpPayload(payload);
  return {
    op: createOperation({
      entity: ENTITY,
      seq,
      backlink,
      payloadBytes: bytes,
      publicKey: device.publicKey,
      secretKey: device.secretKey,
      timestamp: seq,
    }),
    bytes,
  };
}

describe("OpLogStore.append", () => {
  it("builds a hash-linked chain with 1-based seq", async () => {
    const { store } = makeStore();
    const first = await store.append(ENTITY, { kind: "upsert", note: { id: "a" } });
    const second = await store.append(ENTITY, { kind: "upsert", note: { id: "b" } });
    expect(first.header.seq).toBe(1);
    expect(first.header.backlink).toBeNull();
    expect(second.header.seq).toBe(2);
    expect(second.header.backlink).toBe(first.hash);
    expect(store.head(ENTITY, store.deviceId)).toEqual({ seq: 2, hash: second.hash });
  });

  it("seq survives store re-instantiation over the same persistence (old bug 1)", async () => {
    const { persistence, device, counter, store } = makeStore();
    await store.append(ENTITY, { kind: "upsert", note: { id: "a" } });
    await store.append(ENTITY, { kind: "upsert", note: { id: "b" } });

    // "Page reload": a brand-new store instance over the same persisted state.
    // Production calls hydrate() once collections finish preloading — tests
    // simulate that same step explicitly.
    const reloaded = new OpLogStore({ persistence, device, headCounter: counter });
    reloaded.hydrate([ENTITY]);
    const next = await reloaded.append(ENTITY, { kind: "upsert", note: { id: "c" } });
    expect(next.header.seq).toBe(3);
  });

  it("recovers the height from the cross-tab counter when persistence lags (old bug 2)", async () => {
    const { device, counter, store } = makeStore();
    await store.append(ENTITY, { kind: "upsert", note: { id: "a" } });
    expect(counter.get(ENTITY)).toBe(1);

    // Second tab: fresh (empty) collection replica, SAME localStorage counter.
    const lagging = new MemoryOpLogPersistence();
    const tabB = new OpLogStore({ persistence: lagging, device, headCounter: counter });
    await expect(tabB.append(ENTITY, { kind: "upsert", note: { id: "b" } })).rejects.toThrow(
      /height 1/,
    );
    // The counter refuses to re-issue seq 1 — better a loud error than a
    // silent overlapping seq that would fork the log.
  });

  it("serializes concurrent appends to distinct seqs", async () => {
    const { store } = makeStore();
    const ops = await Promise.all([
      store.append(ENTITY, { kind: "upsert", note: { id: "a" } }),
      store.append(ENTITY, { kind: "upsert", note: { id: "b" } }),
      store.append(ENTITY, { kind: "upsert", note: { id: "c" } }),
    ]);
    expect(ops.map((op) => op.header.seq).sort()).toEqual([1, 2, 3]);
  });

  it("appends start unpublished and flushable, own ops are already applied", async () => {
    const { store } = makeStore();
    const op = await store.append(ENTITY, { kind: "upsert", note: { id: "a" } });
    expect(store.unpublished(ENTITY).map((row) => row.hash)).toEqual([op.hash]);
    expect(store.unapplied(ENTITY)).toEqual([]);
    await store.markPublished([op.hash]);
    expect(store.unpublished(ENTITY)).toEqual([]);
  });
});

describe("OpLogStore.ingest", () => {
  it("stores a valid chain and advances the remote head", async () => {
    const { store } = makeStore();
    const remote = generateDeviceKey();
    const first = remoteOp(remote, 1, null);
    const second = remoteOp(remote, 2, first.op.hash);

    expect(await store.ingest(first.op, first.bytes)).toBe("stored");
    expect(await store.ingest(second.op, second.bytes)).toBe("stored");
    expect(store.head(ENTITY, remote.deviceId)).toEqual({ seq: 2, hash: second.op.hash });
    expect(store.unapplied(ENTITY)).toHaveLength(2);
  });

  it("reports duplicate / gap / fork without corrupting the head", async () => {
    const { store } = makeStore();
    const remote = generateDeviceKey();
    const first = remoteOp(remote, 1, null);
    await store.ingest(first.op, first.bytes);

    expect(await store.ingest(first.op, first.bytes)).toBe("duplicate");

    const third = remoteOp(remote, 3, first.op.hash);
    expect(await store.ingest(third.op, third.bytes)).toBe("gap");

    const forked = remoteOp(remote, 1, null, { kind: "upsert", note: { id: "other" } });
    expect(await store.ingest(forked.op, forked.bytes)).toBe("fork");

    expect(store.head(ENTITY, remote.deviceId)).toEqual({ seq: 1, hash: first.op.hash });
  });

  it("rejects structurally invalid ops as invalid", async () => {
    const { store } = makeStore();
    const remote = generateDeviceKey();
    const { op, bytes } = remoteOp(remote, 1, null);
    expect(await store.ingest({ ...op, signature: op.signature.slice(1) }, bytes)).toBe("invalid");
    expect(await store.ingest(op, new TextEncoder().encode("{}"))).toBe("invalid");
    expect(store.head(ENTITY, remote.deviceId)).toBeNull();
  });

  it("quarantine keeps the op out of unapplied and is persistent", async () => {
    const { persistence, device, store } = makeStore();
    const remote = generateDeviceKey();
    const { op, bytes } = remoteOp(remote, 1, null);
    await store.ingest(op, bytes);
    await store.quarantine(op.hash, "corrupt body_doc");

    expect(store.unapplied(ENTITY)).toEqual([]);
    expect(store.quarantined(ENTITY)[0]).toMatchObject({
      hash: op.hash,
      quarantineReason: "corrupt body_doc",
    });

    const reloaded = new OpLogStore({ persistence, device, headCounter: memoryHeadCounter() });
    reloaded.hydrate([ENTITY]);
    expect(reloaded.quarantined(ENTITY)).toHaveLength(1);
  });
});
