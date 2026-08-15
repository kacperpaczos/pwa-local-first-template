import { describe, expect, it } from "vitest";
import { createBodyDoc } from "@/shared/db/crdt";
import { resetLamportForTests } from "@/shared/db/lamport";
import type { Note } from "@/shared/db/schemas";
import { generateDeviceKey } from "@/shared/identity/device";
import { MemoryOpLogPersistence } from "@/shared/store/oplog-persistence";
import { OpLogStore, memoryHeadCounter } from "@/shared/store/oplog-store";
import type { MaterializeTarget } from "@/shared/store/materialize";
import { FakeHub, FakeHubTransport } from "@/testing/harness/fake-hub";
import { SyncEngine } from "./engine";
import { NoopLogTransport } from "./noop-transport";
import { syncStatusStore } from "./status";
import type { LogSyncTransport } from "./transport";

function note(partial: Partial<Note> & Pick<Note, "id">): Note {
  const body = createBodyDoc(partial.body ?? "");
  return {
    title: "t",
    title_lamport: 1,
    body: body.text,
    deleted_at: null,
    deleted_lamport: 0,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
    body_doc: partial.body_doc ?? body.doc,
  };
}

function makePeer(hub: FakeHub, transport?: () => LogSyncTransport) {
  const persistence = new MemoryOpLogPersistence();
  const device = generateDeviceKey();
  const counter = memoryHeadCounter();
  const store = new OpLogStore({ persistence, device, headCounter: counter });
  const notes = new Map<string, Note>();
  const target: MaterializeTarget = {
    getNote: (id) => notes.get(id),
    upsertNote: async (n) => void notes.set(n.id, n),
  };
  const engine = new SyncEngine({
    store,
    transport: transport ?? (() => new FakeHubTransport(hub)),
    target,
    disableInterval: true,
    // Deterministic control in tests: only the syncNow() calls we make run —
    // no background cycle kicked off by a remote head announcement.
    reactive: false,
  });
  return { persistence, device, counter, store, notes, engine };
}

describe("SyncEngine", () => {
  it("ships an append from A to B: flush → head → fetch → ingest → materialize", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = makePeer(hub);
    const peerB = makePeer(hub);

    await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n1", title: "hi" }) });
    await peerA.engine.syncNow();
    await peerB.engine.syncNow();

    expect(peerB.notes.get("n1")?.title).toBe("hi");
    expect(peerB.store.head("notes", peerA.device.deviceId)?.seq).toBe(1);

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("keeps syncing after a reload — new store instance, same persistence (old bug 1)", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = makePeer(hub);
    const peerB = makePeer(hub);

    await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n1" }) });
    await peerA.engine.syncNow();
    await peerB.engine.syncNow();
    await peerA.engine.close();

    // "Reload" of A: fresh store + engine over the SAME persisted state.
    // Production hydrates the read index once collections finish preloading
    // (client.ts#startSync) — simulate that same step here.
    const reloadedStore = new OpLogStore({
      persistence: peerA.persistence,
      device: peerA.device,
      headCounter: peerA.counter,
    });
    reloadedStore.hydrate(["notes"]);
    const reloadedEngine = new SyncEngine({
      store: reloadedStore,
      transport: () => new FakeHubTransport(hub),
      target: { getNote: () => undefined, upsertNote: async () => undefined },
      disableInterval: true,
      reactive: false,
    });

    await reloadedStore.append("notes", { kind: "upsert", note: note({ id: "n2", title: "po" }) });
    await reloadedEngine.syncNow();
    await peerB.engine.syncNow();

    // Under the old scheme B's cursor filtered A's restarted seq numbers
    // silently; with per-device logs the post-reload op lands at seq 2.
    expect(peerB.notes.get("n2")?.title).toBe("po");
    expect(peerB.store.head("notes", peerA.device.deviceId)?.seq).toBe(2);

    await reloadedEngine.close();
    await peerB.engine.close();
  });

  it("quarantines a poison op, surfaces degraded, and keeps later ops flowing (old bug 3)", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = makePeer(hub);
    const peerB = makePeer(hub);

    // B already has the note the poison op will try to merge into.
    peerB.notes.set("poisoned", note({ id: "poisoned" }));

    await peerA.store.append("notes", {
      kind: "upsert",
      note: note({ id: "poisoned", body_doc: "!!!corrupt!!!" }),
    });
    await peerA.store.append("notes", { kind: "upsert", note: note({ id: "ok", title: "alive" }) });
    await peerA.engine.syncNow();
    await peerB.engine.syncNow();

    expect(peerB.notes.get("ok")?.title).toBe("alive");
    expect(peerB.store.quarantined("notes")).toHaveLength(1);
    expect(syncStatusStore.get()).toBe("degraded");

    // A second cycle does NOT retry the quarantined op — sync can't wedge.
    await peerB.engine.syncNow();
    expect(peerB.notes.get("ok")?.title).toBe("alive");

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("retries a gap when the relay lags, and completes once rows appear", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = makePeer(hub);
    const peerB = makePeer(hub);

    const first = await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n1" }) });
    await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n2" }) });
    await peerA.engine.syncNow();

    // Row 1 hasn't propagated to the relay yet: B can see the head (seq 2)
    // but must not ingest seq 2 without seq 1 (gap).
    hub.hidden.add(hub.key("notes", peerA.device.deviceId, first.header.seq));
    await peerB.engine.syncNow();
    expect(peerB.store.head("notes", peerA.device.deviceId)).toBeNull();

    hub.hidden.clear();
    await peerB.engine.syncNow();
    expect(peerB.store.head("notes", peerA.device.deviceId)?.seq).toBe(2);
    expect(peerB.notes.get("n1")).toBeDefined();
    expect(peerB.notes.get("n2")).toBeDefined();

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("a transport that sends nothing (no peers) leaves ops queued, and they ship once a relay exists", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    // Offline-only build: VITE_GUN_PEERS unset → NoopLogTransport.
    const peerA = makePeer(hub, () => new NoopLogTransport());

    await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n1" }) });
    await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n2" }) });
    await peerA.engine.syncNow();

    // Marking these published would strand them: a later head announcement
    // would sit above rows no peer can ever fetch.
    expect(peerA.store.unpublished("notes")).toHaveLength(2);

    // A relay is configured later (rebuild) — the whole history must ship.
    await peerA.engine.close();
    const relayed = new SyncEngine({
      store: peerA.store,
      transport: () => new FakeHubTransport(hub),
      target: { getNote: () => undefined, upsertNote: async () => undefined },
      disableInterval: true,
      reactive: false,
    });
    await relayed.syncNow();
    expect(peerA.store.unpublished("notes")).toEqual([]);

    const peerB = makePeer(hub);
    await peerB.engine.syncNow();
    expect(peerB.notes.get("n1")).toBeDefined();
    expect(peerB.notes.get("n2")).toBeDefined();

    await relayed.close();
    await peerB.engine.close();
  });

  it("restart re-publishes this device's log into the new space (pairing)", async () => {
    resetLamportForTests();
    const oldSpace = new FakeHub();
    const newSpace = new FakeHub();
    let current = oldSpace;

    const peerB = makePeer(oldSpace, () => new FakeHubTransport(current));
    await peerB.store.append("notes", { kind: "upsert", note: note({ id: "pre1" }) });
    await peerB.store.append("notes", { kind: "upsert", note: note({ id: "pre2" }) });
    await peerB.engine.syncNow();
    expect(peerB.store.unpublished("notes")).toEqual([]);

    // B pairs into A's space: the transport now authenticates a different
    // graph, where nothing B published before is reachable.
    current = newSpace;
    await peerB.engine.restart();

    const peerA = makePeer(newSpace);
    await peerA.engine.syncNow();

    // Pre-pairing history must arrive, not be stranded behind stale
    // published flags (which would also leave a permanent fetch gap).
    expect(peerA.notes.get("pre1")).toBeDefined();
    expect(peerA.notes.get("pre2")).toBeDefined();
    expect(peerA.store.head("notes", peerB.device.deviceId)?.seq).toBe(2);

    await peerA.engine.close();
    await peerB.engine.close();
  });

  it("isOpCovered is vacuously true with no known peers (standalone device, safe to GC)", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = makePeer(hub);

    const op = await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n1" }) });
    await peerA.engine.syncNow();

    expect(peerA.engine.roster()).toEqual([peerA.device.deviceId]);
    expect(peerA.engine.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(true);

    await peerA.engine.close();
  });

  it("a peer known only from persisted heads still blocks coverage at boot (pre-subscription GC)", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = makePeer(hub);
    const peerB = makePeer(hub);

    await peerB.store.append("notes", { kind: "upsert", note: note({ id: "seed" }) });
    await peerB.engine.syncNow();
    await peerA.engine.syncNow(); // A now has B's log head persisted
    const op = await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n1" }) });
    await peerA.engine.syncNow();

    // "Reload" of A: a brand-new engine whose in-memory heads/acks are empty
    // and whose subscriptions have not delivered anything yet — exactly the
    // state the startup GC pass runs in.
    await peerA.engine.close();
    const rebooted = new SyncEngine({
      store: peerA.store,
      transport: () => new FakeHubTransport(hub),
      target: { getNote: () => undefined, upsertNote: async () => undefined },
      disableInterval: true,
      reactive: false,
    });

    expect(rebooted.roster()).toContain(peerB.device.deviceId);
    expect(rebooted.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(false);

    await rebooted.close();
    await peerB.engine.close();
  });

  it("requires an explicit ack once a peer is known, before enabling the GC coverage gate", async () => {
    resetLamportForTests();
    const hub = new FakeHub();
    const peerA = makePeer(hub);
    const peerB = makePeer(hub);

    // Make B known to A first (an unrelated op puts B's head in A's roster).
    await peerB.store.append("notes", { kind: "upsert", note: note({ id: "seed" }) });
    await peerB.engine.syncNow();
    await peerA.engine.syncNow();
    expect(peerA.engine.roster()).toContain(peerB.device.deviceId);

    const op = await peerA.store.append("notes", { kind: "upsert", note: note({ id: "n1" }) });
    await peerA.engine.syncNow();
    // B is known but hasn't acked A's op yet — must not be covered.
    expect(peerA.engine.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(false);

    await peerB.engine.syncNow(); // B ingests A's op, publishes acks including it
    await peerA.engine.syncNow(); // A observes B's acks

    expect(peerA.engine.isOpCovered(peerA.device.deviceId, op.header.seq)).toBe(true);

    await peerA.engine.close();
    await peerB.engine.close();
  });
});
