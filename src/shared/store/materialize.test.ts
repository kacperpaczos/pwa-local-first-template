import { beforeEach, describe, expect, it } from "vitest";
import { peekLamport, resetLamportForTests } from "@/shared/db/lamport";
import { COUNTER_ID, type Counter } from "@/shared/db/schemas";
import { generateDeviceKey } from "@/shared/identity/device";
import { createOperation } from "@/shared/oplog/header";
import { encodeOpPayload } from "@/shared/oplog/payload";
import { MemoryOpLogPersistence } from "./oplog-persistence";
import { memoryHeadCounter, OpLogStore } from "./oplog-store";
import { materializeCounterOps, type MaterializeTarget } from "./materialize";

const ENTITY = "counter";

function makeStore() {
  const device = generateDeviceKey();
  return {
    device,
    store: new OpLogStore({
      persistence: new MemoryOpLogPersistence(),
      device,
      headCounter: memoryHeadCounter(),
    }),
  };
}

function makeTarget(initial?: Counter) {
  const state = new Map<string, Counter>();
  if (initial) state.set(COUNTER_ID, initial);
  const target: MaterializeTarget = {
    getCounter: () => state.get(COUNTER_ID),
    upsertCounter: async (row) => void state.set(COUNTER_ID, row),
  };
  return { state, target, read: () => state.get(COUNTER_ID) };
}

/** Ingest a remote op into `store` so it lands unapplied. */
async function ingestRemote(
  store: OpLogStore,
  remote: ReturnType<typeof generateDeviceKey>,
  seq: number,
  backlink: string | null,
  payload: unknown,
): Promise<string> {
  const bytes = encodeOpPayload(payload);
  const op = createOperation({
    entity: ENTITY,
    seq,
    backlink,
    payloadBytes: bytes,
    publicKey: remote.publicKey,
    secretKey: remote.secretKey,
    timestamp: seq,
  });
  const verdict = await store.ingest(op, bytes);
  expect(verdict).toBe("stored");
  return op.hash;
}

describe("materializeCounterOps", () => {
  beforeEach(() => {
    resetLamportForTests();
  });

  it("folds own appends: increments sum, the state row is derived from the log", async () => {
    const { store } = makeStore();
    const { target, read } = makeTarget();

    await store.append(ENTITY, { kind: "increment", amount: 1 });
    await store.append(ENTITY, { kind: "increment", amount: 2 });
    const result = await materializeCounterOps(store, target);

    expect(result.applied).toHaveLength(2);
    expect(read()?.value).toBe(3);
    expect(store.unapplied(ENTITY)).toEqual([]);
  });

  it("is idempotent — re-running applies nothing new", async () => {
    const { store } = makeStore();
    const { target, read } = makeTarget();

    await store.append(ENTITY, { kind: "increment", amount: 5 });
    await materializeCounterOps(store, target);
    const again = await materializeCounterOps(store, target);

    expect(again.applied).toEqual([]);
    expect(read()?.value).toBe(5);
  });

  it("sums increments from multiple devices regardless of arrival order", async () => {
    const remoteA = generateDeviceKey();
    const remoteB = generateDeviceKey();

    // Same ops, two stores, opposite ingest order — same total.
    for (const order of ["ab", "ba"] as const) {
      const { store } = makeStore();
      const { target, read } = makeTarget();
      const first = order === "ab" ? remoteA : remoteB;
      const second = order === "ab" ? remoteB : remoteA;
      await ingestRemote(store, first, 1, null, { kind: "increment", amount: 1 });
      await ingestRemote(store, second, 1, null, { kind: "increment", amount: 10 });
      await materializeCounterOps(store, target);
      expect(read()?.value).toBe(11);
    }
  });

  it("set_label folds by LWW — the highest lamport wins regardless of arrival order", async () => {
    const remote = generateDeviceKey();
    const { store } = makeStore();
    const { target, read } = makeTarget();

    const first = await ingestRemote(store, remote, 1, null, {
      kind: "set_label",
      label: "fresh",
      lamport: 5,
    });
    // A LOWER-lamport op arriving later must not win.
    await ingestRemote(store, remote, 2, first, { kind: "set_label", label: "stale", lamport: 1 });
    await materializeCounterOps(store, target);

    expect(read()?.label).toBe("fresh");
    expect(read()?.label_lamport).toBe(5);
    expect(store.unapplied(ENTITY)).toEqual([]);
  });

  it("ties break deterministically by the raw value", async () => {
    const remoteA = generateDeviceKey();
    const remoteB = generateDeviceKey();
    const { store } = makeStore();
    const { target, read } = makeTarget();

    await ingestRemote(store, remoteA, 1, null, { kind: "set_label", label: "aaa", lamport: 3 });
    await ingestRemote(store, remoteB, 1, null, { kind: "set_label", label: "bbb", lamport: 3 });
    await materializeCounterOps(store, target);

    // Same lamport — the greater raw value wins on every device.
    expect(read()?.label).toBe("bbb");
  });

  it("quarantines a poison payload and still applies later ops", async () => {
    const remote = generateDeviceKey();
    const { store } = makeStore();
    const { target, read } = makeTarget();

    const poison = await ingestRemote(store, remote, 1, null, { kind: "increment", amount: -5 });
    await ingestRemote(store, remote, 2, poison, { kind: "increment", amount: 2 });

    const result = await materializeCounterOps(store, target);

    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]?.hash).toBe(poison);
    expect(read()?.value).toBe(2);
    expect(store.quarantined(ENTITY)).toHaveLength(1);
  });

  it("rejects an out-of-range lamport instead of freezing the clock (poisoned counter)", async () => {
    const remote = generateDeviceKey();
    const { store } = makeStore();
    const { target } = makeTarget();

    await ingestRemote(store, remote, 1, null, {
      kind: "set_label",
      label: "huge",
      lamport: 2 ** 53,
    });
    const result = await materializeCounterOps(store, target);

    expect(result.quarantined).toHaveLength(1);
    expect(peekLamport()).toBe(0);
  });

  it("does not quarantine a valid op when the WRITE fails — it retries next cycle", async () => {
    const remote = generateDeviceKey();
    const { store } = makeStore();
    let failWrites = true;
    const state = new Map<string, Counter>();
    const target: MaterializeTarget = {
      getCounter: () => state.get(COUNTER_ID),
      upsertCounter: async (row) => {
        if (failWrites) throw new Error("disk full");
        state.set(COUNTER_ID, row);
      },
    };

    await ingestRemote(store, remote, 1, null, { kind: "increment", amount: 4 });
    await expect(materializeCounterOps(store, target)).rejects.toThrow("disk full");
    expect(store.quarantined(ENTITY)).toEqual([]);
    expect(store.unapplied(ENTITY)).toHaveLength(1);

    failWrites = false;
    await materializeCounterOps(store, target);
    expect(state.get(COUNTER_ID)?.value).toBe(4);
  });
});
