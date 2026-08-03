import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStoragePersisted, resetStoragePersistForTests, storagePersistStore } from "./status";

describe("ensureStoragePersisted", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetStoragePersistForTests();
  });

  it("reports unsupported when navigator.storage.persist is missing", async () => {
    vi.stubGlobal("navigator", {});
    await ensureStoragePersisted();
    expect(storagePersistStore.get()).toBe("unsupported");
  });

  it("reports persisted when the browser grants it", async () => {
    vi.stubGlobal("navigator", { storage: { persist: async () => true } });
    await ensureStoragePersisted();
    expect(storagePersistStore.get()).toBe("persisted");
  });

  it("reports not-persisted when the browser refuses", async () => {
    vi.stubGlobal("navigator", { storage: { persist: async () => false } });
    await ensureStoragePersisted();
    expect(storagePersistStore.get()).toBe("not-persisted");
  });

  it("only asks the browser once per session", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist } });
    await ensureStoragePersisted();
    await ensureStoragePersisted();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
