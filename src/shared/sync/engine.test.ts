import { describe, expect, it } from "vitest";
import { createBodyDoc } from "@/shared/db/crdt";
import { resetLamportForTests } from "@/shared/db/lamport";
import type { Note } from "@/shared/db/schemas";
import { generateDeviceKey } from "@/shared/identity/device";
import { MemoryOpLogPersistence } from "@/shared/store/oplog-persistence";
import { OpLogStore, memoryHeadCounter } from "@/shared/store/oplog-store";
import type { MaterializeTarget } from "@/shared/store/materialize";
import { SyncEngine } from "./engine";
import { syncStatusStore } from "./status";
import type {
  FetchResult,
  HeadAnnouncement,
  LogSyncTransport,
  PublishableOp,
  Unsubscribe,
} from "./transport";

/**
 * In-memory hub shared by every FakeHubTransport — the "mesh". No crypto:
 * payloads travel as plaintext bytes; encryption is the Gun transport's
 * concern and is covered in gun-log-transport.test.ts.
 */
class FakeHub {
  rows = new Map<string, { op: PublishableOp["op"]; payloadJson: string }>();
  heads = new Map<string, HeadAnnouncement>();
  acks = new Map<string, Record<string, number>>();
  headListeners = new Set<(head: HeadAnnouncement) => void>();
  ackListeners = new Set<(device: string, acks: Record<string, number>) => void>();
  /** Rows temporarily invisible to fetch — simulates relay propagation lag. */
  hidden = new Set<string>();

  key(entity: string, device: string, seq: number): string {
    return `${entity}/${device}/${seq}`;
  }
}

class FakeHubTransport implements LogSyncTransport {
  constructor(private readonly hub: FakeHub) {}

  async ready(): Promise<void> {}

  async publish(entity: string, ops: readonly PublishableOp[]): Promise<void> {
    let head: HeadAnnouncement | null = null;
    for (const { op, payloadJson } of ops) {
      this.hub.rows.set(this.hub.key(entity, op.header.publicKey, op.header.seq), {
        op,
        payloadJson,
      });
      if (!head || op.header.seq > head.seq) {
        head = { device: op.header.publicKey, seq: op.header.seq, hash: op.hash };
      }
    }
    if (head) {
      this.hub.heads.set(`${entity}/${head.device}`, head);
      for (const listener of this.hub.headListeners) listener(head);
    }
  }

  async publishAcks(_entity: string, device: string, acks: Record<string, number>): Promise<void> {
    this.hub.acks.set(device, acks);
    for (const listener of this.hub.ackListeners) listener(device, acks);
  }

  subscribeHeads(entity: string, cb: (head: HeadAnnouncement) => void): Unsubscribe {
    this.hub.headListeners.add(cb);
    for (const [key, head] of this.hub.heads) {
      if (key.startsWith(`${entity}/`)) cb(head);
    }
    return () => this.hub.headListeners.delete(cb);
  }

  subscribeAcks(
    _entity: string,
    cb: (device: string, acks: Record<string, number>) => void,
  ): Unsubscribe {
    this.hub.ackListeners.add(cb);
    for (const [device, acks] of this.hub.acks) cb(device, acks);
    return () => this.hub.ackListeners.delete(cb);
  }

  async fetchOps(
    entity: string,
    device: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<FetchResult> {
    const ops: FetchResult["ops"] = [];
    for (let seq = fromSeq; seq <= toSeq; seq++) {
      const key = this.hub.key(entity, device, seq);
      if (this.hub.hidden.has(key)) continue;
      const row = this.hub.rows.get(key);
      if (!row) continue;
      ops.push({ op: row.op, payloadBytes: new TextEncoder().encode(row.payloadJson) });
    }
    return { ops, sawUnsupportedVersion: false };
  }

  async close(): Promise<void> {}
}

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

function makePeer(hub: FakeHub) {
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
    transport: () => new FakeHubTransport(hub),
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
