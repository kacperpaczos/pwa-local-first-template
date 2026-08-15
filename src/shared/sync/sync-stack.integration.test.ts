import { beforeEach, describe, expect, it } from "vitest";
import { resetLamportForTests } from "@/shared/db/lamport";
import { OpLogStore } from "@/shared/store/oplog-store";
import { FakeHub } from "@/testing/harness/fake-hub";
import { createVirtualDevice, ENTITY, settle } from "@/testing/harness/virtual-device";
import { SyncEngine } from "./engine";
import { FakeHubTransport } from "@/testing/harness/fake-hub";

/**
 * Integration layer: the whole local stack, several devices, no browser.
 *
 * Everything from `PersistenceFacade` down to the materializer is production
 * code (see virtual-device.ts for the three stand-ins). These cases need at
 * least three modules to be meaningful, so they cannot live in a unit test —
 * and they need multiple devices and deterministic cycles, which makes them
 * expensive and flaky as e2e.
 */
describe("local-first stack", () => {
  beforeEach(() => {
    resetLamportForTests();
  });

  it("a write through the facade reaches another device", async () => {
    // The gap this layer exists for: facade → outbox → op log → publish →
    // ingest → materialize. Below this test, nothing connected the facade to
    // the log; above it, only e2e did.
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    const created = await a.facade.createNote({ title: "from A", body: "hello" });

    // The write is durable in A's own log before anything syncs.
    expect(a.store.head(ENTITY, a.device.deviceId)?.seq).toBe(1);

    await settle([a, b]);

    expect(b.notes.get(created.id)?.title).toBe("from A");
    expect(b.notes.get(created.id)?.body).toBe("hello");
    expect(b.store.head(ENTITY, a.device.deviceId)?.seq).toBe(1);

    await a.engine.close();
    await b.engine.close();
  });

  it("an edit made through the facade propagates as a second op, not a replacement log", async () => {
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    const created = await a.facade.createNote({ title: "draft" });
    await settle([a, b]);
    await a.facade.updateNote(created.id, { title: "final", body: "body text" });
    await settle([a, b]);

    expect(a.store.head(ENTITY, a.device.deviceId)?.seq).toBe(2);
    expect(b.notes.get(created.id)?.title).toBe("final");
    expect(b.notes.get(created.id)?.body).toBe("body text");

    await a.engine.close();
    await b.engine.close();
  });

  it("three devices converge, each on the others' writes", async () => {
    // The unit tests only ever pair two peers; the roster, ack map and fetch
    // planning all behave differently once a third log exists.
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);
    const c = createVirtualDevice(hub);

    const fromA = await a.facade.createNote({ title: "a-note" });
    const fromB = await b.facade.createNote({ title: "b-note" });
    const fromC = await c.facade.createNote({ title: "c-note" });

    await settle([a, b, c]);

    for (const device of [a, b, c]) {
      expect(device.notes.get(fromA.id)?.title).toBe("a-note");
      expect(device.notes.get(fromB.id)?.title).toBe("b-note");
      expect(device.notes.get(fromC.id)?.title).toBe("c-note");
    }

    for (const device of [a, b, c]) {
      expect(device.engine.roster().sort()).toEqual(
        [a.device.deviceId, b.device.deviceId, c.device.deviceId].sort(),
      );
    }

    await a.engine.close();
    await b.engine.close();
    await c.engine.close();
  });

  it("concurrent edits to the same note converge to one state on both devices", async () => {
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    const created = await a.facade.createNote({ title: "shared", body: "start" });
    await settle([a, b]);

    // Both edit before either has seen the other's op.
    await a.facade.updateNote(created.id, { title: "from A" });
    await b.facade.updateNote(created.id, { body: "from B" });

    await settle([a, b]);

    const onA = a.notes.get(created.id);
    const onB = b.notes.get(created.id);
    expect(onA).toBeDefined();
    // Convergence is the assertion — which side wins the title is LWW's call,
    // asserted in merge-note.test.ts. What matters here is that the full
    // path (two facades, two logs, CRDT body, materializer) agrees.
    expect(onA?.title).toBe(onB?.title);
    expect(onA?.body).toBe(onB?.body);
    expect(onA?.body).toContain("from B");

    await a.engine.close();
    await b.engine.close();
  });

  it("an append that never got published still ships after a restart (crash between append and publish)", async () => {
    // BACKLOG §11: the log doubles as the outbox, so a crash between the
    // durable append and the publish must leave the op queued, not lost.
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    await a.store.append(ENTITY, {
      kind: "upsert",
      note: {
        id: "crash-1",
        title: "written but never published",
        title_lamport: 1,
        body: "",
        body_doc: (await a.facade.createNote({ title: "seed" })).body_doc,
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
        deleted_lamport: 0,
      },
    });
    // No flush: this is the crash.
    expect(a.store.unpublished(ENTITY).some((op) => op.hash)).toBe(true);
    await a.engine.close();

    // Restart: fresh store + engine over the same persisted state, exactly
    // like client.ts#prepareLocalOnly does on boot.
    const restartedStore = new OpLogStore({
      persistence: a.persistence,
      device: a.device,
      headCounter: a.counter,
    });
    restartedStore.hydrate([ENTITY]);
    const restartedEngine = new SyncEngine({
      store: restartedStore,
      transport: () => new FakeHubTransport(hub),
      target: { getNote: () => undefined, upsertNote: async () => undefined },
      entity: ENTITY,
      disableInterval: true,
      reactive: false,
    });

    await restartedEngine.syncNow();
    expect(restartedStore.unpublished(ENTITY)).toEqual([]);

    await b.engine.syncNow();
    expect(b.notes.get("crash-1")?.title).toBe("written but never published");

    await restartedEngine.close();
    await b.engine.close();
  });
});
