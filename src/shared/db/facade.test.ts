import { beforeEach, describe, expect, it } from "vitest";
import { resetLamportForTests } from "./lamport";
import { resetStoragePersistForTests } from "./storage-persist";
import { FakeHub } from "@/testing/harness/fake-hub";
import { createVirtualDevice, ENTITY } from "@/testing/harness/virtual-device";

/**
 * The facade is exercised over the real store + materializer (virtual
 * device harness); only the transport and OPFS are stand-ins — see
 * virtual-device.ts for what that means.
 */
describe("PersistenceFacade", () => {
  beforeEach(() => {
    resetLamportForTests(0);
    resetStoragePersistForTests();
  });

  it("increment appends one durable op and folds it into the state row", async () => {
    const device = createVirtualDevice(new FakeHub());

    const counter = await device.facade.increment();

    expect(counter.value).toBe(1);
    expect(device.read().value).toBe(1);
    expect(device.store.head(ENTITY, device.device.deviceId)?.seq).toBe(1);
    await device.engine.close();
  });

  it("increments accumulate — each one is its own op", async () => {
    const device = createVirtualDevice(new FakeHub());

    await device.facade.increment();
    await device.facade.increment(4);
    const counter = await device.facade.increment();

    expect(counter.value).toBe(6);
    expect(device.store.head(ENTITY, device.device.deviceId)?.seq).toBe(3);
    await device.engine.close();
  });

  it("rejects a non-positive or fractional amount", async () => {
    const device = createVirtualDevice(new FakeHub());

    expect(() => device.facade.increment(0)).toThrow();
    expect(() => device.facade.increment(-2)).toThrow();
    expect(() => device.facade.increment(1.5)).toThrow();
    expect(device.read().value).toBe(0);
    await device.engine.close();
  });

  it("setLabel stamps the next Lamport value and folds via LWW", async () => {
    const device = createVirtualDevice(new FakeHub());

    await device.facade.setLabel("first");
    const counter = await device.facade.setLabel("second");

    expect(counter.label).toBe("second");
    expect(counter.label_lamport).toBe(2);
    await device.engine.close();
  });

  it("a write is durable before it is published", async () => {
    const device = createVirtualDevice(new FakeHub());

    await device.facade.increment();
    // The op exists in the log regardless of what the (background) publish
    // did — the log is the outbox.
    const ops = device.persistence.listOps({ entity: ENTITY, device: device.device.deviceId });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.applied).toBe(true);
    await device.engine.close();
  });
});
