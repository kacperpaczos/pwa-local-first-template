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

  it("a second tab appends on top of the first tab's op without duplicating seq (old bug 2)", async () => {
    // Both tabs share one database (BrowserCollectionCoordinator) and one
    // localStorage counter, but each has its own store instance whose read
    // index is only hydrated at boot.
    const persistence = new MemoryOpLogPersistence();
    const device = generateDeviceKey();
    const counter = memoryHeadCounter();

    const tabA = new OpLogStore({ persistence, device, headCounter: counter });
    const tabB = new OpLogStore({ persistence, device, headCounter: counter });
    tabA.hydrate([ENTITY]);
    tabB.hydrate([ENTITY]); // both hydrated while the log was empty

    const first = await tabA.append(ENTITY, { kind: "upsert", note: { id: "a" } });
    expect(counter.get(ENTITY)).toBe(1);

    // Tab B's index is stale, but the row IS in the shared database — B must
    // re-read rather than fail or reuse seq 1.
    const second = await tabB.append(ENTITY, { kind: "upsert", note: { id: "b" } });
    expect(second.header.seq).toBe(2);
    expect(second.header.backlink).toBe(first.hash);

    // ...and the tab stays usable for every subsequent write.
    const third = await tabB.append(ENTITY, { kind: "upsert", note: { id: "c" } });
    expect(third.header.seq).toBe(3);
  });

  it("self-heals when the head row was lost after its op was persisted", async () => {
    const { persistence, device, counter, store } = makeStore();
    const first = await store.append(ENTITY, { kind: "upsert", note: { id: "a" } });

    // Simulate a crash between putOp and putHead: the op is durable, the
    // head row and the counter never landed.
    const withoutHead = new MemoryOpLogPersistence();
    await withoutHead.putOp(persistence.getOp(first.hash)!);
    const recovered = new OpLogStore({
      persistence: withoutHead,
      device,
      headCounter: memoryHeadCounter(),
    });
    recovered.hydrate([ENTITY]);

    // Must chain onto the orphaned op, NOT reissue seq 1 (which would fork
    // this device's own log against any peer that already has op 1).
    const next = await recovered.append(ENTITY, { kind: "upsert", note: { id: "b" } });
    expect(next.header.seq).toBe(2);
    expect(next.header.backlink).toBe(first.hash);
    void counter;
  });

  it("throws rather than forking when the op at the counter's height is truly gone", async () => {
    const { device, counter, store } = makeStore();
    await store.append(ENTITY, { kind: "upsert", note: { id: "a" } });

    // Empty database + a counter that says height 1: the op is unrecoverable,
    // so extending is impossible without reusing seq 1.
    const empty = new MemoryOpLogPersistence();
    const stranded = new OpLogStore({ persistence: empty, device, headCounter: counter });
    stranded.hydrate([ENTITY]);
    await expect(stranded.append(ENTITY, { kind: "upsert", note: { id: "b" } })).rejects.toThrow(
      /op 1 is missing/,
    );
  });

  it("resetOwnPublished re-queues only this device's ops (space change)", async () => {
    const { store } = makeStore();
    const remote = generateDeviceKey();
    const mine = await store.append(ENTITY, { kind: "upsert", note: { id: "a" } });
    const theirs = remoteOp(remote, 1, null);
    await store.ingest(theirs.op, theirs.bytes);
    await store.markPublished([mine.hash]);
    expect(store.unpublished(ENTITY)).toEqual([]);

    await store.resetOwnPublished(ENTITY);

    const requeued = store.unpublished(ENTITY);
    expect(requeued.map((row) => row.hash)).toEqual([mine.hash]);
    // The remote device's op belongs to its own log — we must not republish it.
    expect(requeued.some((row) => row.hash === theirs.op.hash)).toBe(false);
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
