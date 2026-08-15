import { beforeEach, describe, expect, it } from "vitest";
import { resetLamportForTests } from "@/shared/db/lamport";
import { resetStoragePersistForTests } from "@/shared/db/storage-persist";
import { OpLogStore } from "@/shared/store/oplog-store";
import { FakeHub, FakeHubTransport } from "@/testing/harness/fake-hub";
import { createVirtualDevice, ENTITY, settle } from "@/testing/harness/virtual-device";
import { SyncEngine } from "./engine";

/**
 * Integration layer: the whole local stack, several devices, no browser.
 *
 * Everything from `PersistenceFacade` down to the materializer is production
 * code (see virtual-device.ts for the two stand-ins). These cases need at
 * least three modules to be meaningful, so they cannot live in a unit test —
 * and they need multiple devices and deterministic cycles, which makes them
 * expensive and flaky as e2e.
 */
describe("local-first stack", () => {
  beforeEach(() => {
    resetLamportForTests();
    resetStoragePersistForTests();
  });

  it("an increment through the facade reaches another device", async () => {
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    await a.facade.increment();

    // The write is durable in A's own log before anything syncs.
    expect(a.store.head(ENTITY, a.device.deviceId)?.seq).toBe(1);
    expect(a.read().value).toBe(1);

    await settle([a, b]);

    expect(b.read().value).toBe(1);
    expect(b.store.head(ENTITY, a.device.deviceId)?.seq).toBe(1);

    await a.engine.close();
    await b.engine.close();
  });

  it("concurrent increments on two devices SUM instead of conflicting", async () => {
    // The grow-only counter property, end to end: both devices click before
    // either has seen the other's op, and nobody's click is lost.
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    await a.facade.increment();
    await a.facade.increment();
    await b.facade.increment();

    await settle([a, b]);

    expect(a.read().value).toBe(3);
    expect(b.read().value).toBe(3);

    await a.engine.close();
    await b.engine.close();
  });

  it("three devices converge on the same total and the same label", async () => {
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);
    const c = createVirtualDevice(hub);

    await a.facade.increment(1);
    await b.facade.increment(10);
    await c.facade.increment(100);
    await b.facade.setLabel("shared counter");

    await settle([a, b, c]);

    for (const device of [a, b, c]) {
      expect(device.read().value).toBe(111);
      expect(device.read().label).toBe("shared counter");
      expect(device.engine.roster().sort()).toEqual(
        [a.device.deviceId, b.device.deviceId, c.device.deviceId].sort(),
      );
    }

    await a.engine.close();
    await b.engine.close();
    await c.engine.close();
  });

  it("concurrent label edits converge to one value on every device", async () => {
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    await a.facade.setLabel("A's name");
    await b.facade.setLabel("B's name");

    await settle([a, b]);

    // Which one wins is LWW's call — that both agree is the assertion.
    expect(a.read().label).toBe(b.read().label);

    await a.engine.close();
    await b.engine.close();
  });

  it("an increment that never got published still ships after a restart (crash between append and publish)", async () => {
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);

    // Append without flushing — this is the crash.
    await a.store.append(ENTITY, { kind: "increment", amount: 7 });
    expect(a.store.unpublished(ENTITY)).toHaveLength(1);
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
      target: { getCounter: () => undefined, upsertCounter: async () => undefined },
      entity: ENTITY,
      disableInterval: true,
      reactive: false,
    });

    await restartedEngine.syncNow();
    expect(restartedStore.unpublished(ENTITY)).toEqual([]);

    await b.engine.syncNow();
    expect(b.read().value).toBe(7);

    await restartedEngine.close();
    await b.engine.close();
  });
});
