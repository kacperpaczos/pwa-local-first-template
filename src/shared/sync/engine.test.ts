import { describe, expect, it } from "vitest";
import { resetLamportForTests } from "@/shared/db/lamport";
import { COUNTER_ID, type Counter } from "@/shared/db/schemas";
import { OpLogStore } from "@/shared/store/oplog-store";
import type { MaterializeTarget } from "@/shared/store/materialize";
import { FakeHub, FakeHubTransport } from "@/testing/harness/fake-hub";
import { createVirtualDevice, ENTITY } from "@/testing/harness/virtual-device";
import { SyncEngine } from "./engine";
import { NoopLogTransport } from "./noop-transport";
import { syncStatusStore } from "./status";

const inc = (amount: number) => ({ kind: "increment", amount }) as const;
const setLabel = (label: string, lamport: number) =>
  ({ kind: "set_label", label, lamport }) as const;

/** Engine over an existing store — the "reload"/"rebuild" shape several cases need. */
function rebuiltEngine(store: OpLogStore, hub: FakeHub) {
  const state = new Map<string, Counter>();
  const target: MaterializeTarget = {
    getCounter: () => state.get(COUNTER_ID),
    upsertCounter: async (row) => void state.set(COUNTER_ID, row),
  };
  const engine = new SyncEngine({
    store,
    transport: () => new FakeHubTransport(hub),
    target,
    entity: ENTITY,
    disableInterval: true,
    reactive: false,
  });
  return { engine, state };
}

describe("SyncEngine", () => {
  it("ships an append from A to B: flush → head → fetch → ingest → materialize", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);
    const peerB = createVirtualDevice(hub);

    await peerA.store.append(ENTITY, inc(2));
    await peerA.engine.syncNow();
    await peerB.engine.syncNow();

    expect(peerA.read().value).toBe(2);
    expect(peerB.read().value).toBe(2);
    expect(peerB.store.head(ENTITY, peerA.device.deviceId)?.seq).toBe(1);

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("keeps syncing after a reload — new store instance, same persistence (old bug 1)", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);
    const peerB = createVirtualDevice(hub);

    await peerA.store.append(ENTITY, inc(1));
    await peerA.engine.syncNow();
    await peerB.engine.syncNow();
    await peerA.engine.close();

    // "Reload" of A: fresh store + engine over the SAME persisted state.
    const reloadedStore = new OpLogStore({
      persistence: peerA.persistence,
      device: peerA.device,
      headCounter: peerA.counter,
    });
    reloadedStore.hydrate([ENTITY]);
    const reloaded = rebuiltEngine(reloadedStore, hub);

    await reloadedStore.append(ENTITY, inc(10));
    await reloaded.engine.syncNow();
    await peerB.engine.syncNow();

    // Under the old scheme B's cursor filtered A's restarted seq numbers
    // silently; with per-device logs the post-reload op lands at seq 2.
    expect(peerB.read().value).toBe(11);
    expect(peerB.store.head(ENTITY, peerA.device.deviceId)?.seq).toBe(2);

    await reloaded.engine.close();
    await peerB.engine.close();
  });

  it("quarantines a poison op, surfaces degraded, and keeps later ops flowing (old bug 3)", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);
    const peerB = createVirtualDevice(hub);

    // A poison payload: fails schema validation at fold time on B.
    await peerA.store.append(ENTITY, { kind: "set_label", label: "x", lamport: 2 ** 53 });
    await peerA.store.append(ENTITY, inc(3));
    await peerA.engine.syncNow();
    await peerB.engine.syncNow();

    expect(peerB.read().value).toBe(3);
    expect(peerB.store.quarantined(ENTITY)).toHaveLength(1);
    expect(syncStatusStore.get()).toBe("degraded");

    // A second cycle does NOT retry the quarantined op — sync can't wedge.
    await peerB.engine.syncNow();
    expect(peerB.read().value).toBe(3);

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("retries a gap when the relay lags, and completes once rows appear", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);
    const peerB = createVirtualDevice(hub);

    const first = await peerA.store.append(ENTITY, inc(1));
    await peerA.store.append(ENTITY, inc(1));
    await peerA.engine.syncNow();

    // Row 1 hasn't propagated to the relay yet: B can see the head (seq 2)
    // but must not ingest seq 2 without seq 1 (gap).
    hub.hidden.add(hub.key(ENTITY, peerA.device.deviceId, first.header.seq));
    await peerB.engine.syncNow();
    expect(peerB.store.head(ENTITY, peerA.device.deviceId)).toBeNull();

    hub.hidden.clear();
    await peerB.engine.syncNow();
    expect(peerB.store.head(ENTITY, peerA.device.deviceId)?.seq).toBe(2);
    expect(peerB.read().value).toBe(2);

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("a transport that sends nothing (no peers) leaves ops queued, and they ship once a relay exists", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    // Offline-only build: VITE_GUN_PEERS unset → NoopLogTransport.
    const peerA = createVirtualDevice(hub, { transport: () => new NoopLogTransport() });

    await peerA.store.append(ENTITY, inc(1));
    await peerA.store.append(ENTITY, inc(1));
    await peerA.engine.syncNow();

    // Local state still folds — offline is fully functional.
    expect(peerA.read().value).toBe(2);
    // Marking these published would strand them: a later head announcement
    // would sit above rows no peer can ever fetch.
    expect(peerA.store.unpublished(ENTITY)).toHaveLength(2);

    // A relay is configured later (rebuild) — the whole history must ship.
    await peerA.engine.close();
    const relayed = rebuiltEngine(peerA.store, hub);
    await relayed.engine.syncNow();
    expect(peerA.store.unpublished(ENTITY)).toEqual([]);

    const peerB = createVirtualDevice(hub);
    await peerB.engine.syncNow();
    expect(peerB.read().value).toBe(2);

    await relayed.engine.close();
    await peerB.engine.close();
  });

  it("restart re-publishes this device's log into the new space (pairing)", async () => {
    resetLamportForTests();
    const oldSpace = new FakeHub();
    const newSpace = new FakeHub();
    let current = oldSpace;

    const peerB = createVirtualDevice(oldSpace, {
      transport: () => new FakeHubTransport(current),
    });
    await peerB.store.append(ENTITY, inc(1));
    await peerB.store.append(ENTITY, inc(1));
    await peerB.engine.syncNow();
    expect(peerB.store.unpublished(ENTITY)).toEqual([]);

    // B pairs into A's space: the transport now authenticates a different
    // graph, where nothing B published before is reachable.
    current = newSpace;
    await peerB.engine.restart();

    const peerA = createVirtualDevice(newSpace);
    await peerA.engine.syncNow();

    // Pre-pairing history must arrive, not be stranded behind stale
    // published flags (which would also leave a permanent fetch gap).
    expect(peerA.read().value).toBe(2);
    expect(peerA.store.head(ENTITY, peerB.device.deviceId)?.seq).toBe(2);

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("isOpCovered is vacuously true with no known peers (standalone device)", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);

    const op = await peerA.store.append(ENTITY, inc(1));
    await peerA.engine.syncNow();

    expect(peerA.engine.roster()).toEqual([peerA.device.deviceId]);
    expect(peerA.engine.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(true);

    await peerA.engine.close();
  });

  it("a peer known only from persisted heads still blocks coverage at boot", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);
    const peerB = createVirtualDevice(hub);

    await peerB.store.append(ENTITY, inc(1));
    await peerB.engine.syncNow();
    await peerA.engine.syncNow(); // A now has B's log head persisted
    const op = await peerA.store.append(ENTITY, inc(1));
    await peerA.engine.syncNow();

    // "Reload" of A: a brand-new engine whose in-memory heads/acks are empty
    // and whose subscriptions have not delivered anything yet.
    await peerA.engine.close();
    const rebooted = rebuiltEngine(peerA.store, hub);

    expect(rebooted.engine.roster()).toContain(peerB.device.deviceId);
    expect(rebooted.engine.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(false);

    await rebooted.engine.close();
    await peerB.engine.close();
  });

  it("requires an explicit ack once a peer is known, before reporting coverage", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);
    const peerB = createVirtualDevice(hub);

    // Make B known to A first (an unrelated op puts B's head in A's roster).
    await peerB.store.append(ENTITY, inc(1));
    await peerB.engine.syncNow();
    await peerA.engine.syncNow();
    expect(peerA.engine.roster()).toContain(peerB.device.deviceId);

    const op = await peerA.store.append(ENTITY, inc(1));
    await peerA.engine.syncNow();
    // B is known but hasn't acked A's op yet — must not be covered.
    expect(peerA.engine.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(false);

    await peerB.engine.syncNow(); // B ingests A's op, publishes acks including it
    await peerA.engine.syncNow(); // A observes B's acks

    expect(peerA.engine.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(true);

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("concurrent label edits converge to one winner via LWW", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = createVirtualDevice(hub);
    const peerB = createVirtualDevice(hub);

    // Both write before either has seen the other's op.
    await peerA.store.append(ENTITY, setLabel("from A", 1));
    await peerB.store.append(ENTITY, setLabel("from B", 1));

    await peerA.engine.syncNow();
    await peerB.engine.syncNow();
    await peerA.engine.syncNow();

    // Same lamport — the raw-value tie-break picks the same winner everywhere.
    expect(peerA.read().label).toBe(peerB.read().label);
    expect(peerA.read().label).toBe("from B");

    await peerA.engine.close();
    await peerB.engine.close();
  });
});
