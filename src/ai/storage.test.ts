import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiStorageHeadroomStore,
  estimateStorageHeadroom,
  refreshAiStorageHeadroom,
} from "./storage";

describe("estimateStorageHeadroom", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    aiStorageHeadroomStore.set(null);
  });

  it("is optimistic when navigator.storage.estimate is unsupported", async () => {
    vi.stubGlobal("navigator", {});
    const result = await estimateStorageHeadroom(1_000_000);
    expect(result).toEqual({ ok: true, quota: null, usage: null, required: 1_200_000 });
  });

  it("is optimistic when the browser reports no quota", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: undefined, usage: 100 }) },
    });
    const result = await estimateStorageHeadroom(1_000_000);
    expect(result.ok).toBe(true);
    expect(result.quota).toBeNull();
  });

  it("rejects when free space is below required * 1.2", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 1_000_000, usage: 500_000 }) },
    });
    // free = 500_000, required = 1_000_000 * 1.2 = 1_200_000
    const result = await estimateStorageHeadroom(1_000_000);
    expect(result.ok).toBe(false);
    expect(result.quota).toBe(1_000_000);
    expect(result.usage).toBe(500_000);
  });

  it("accepts when free space covers required * 1.2", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 5_000_000, usage: 0 }) },
    });
    const result = await estimateStorageHeadroom(1_000_000);
    expect(result.ok).toBe(true);
  });

  it("refreshAiStorageHeadroom publishes to aiStorageHeadroomStore", async () => {
    vi.stubGlobal("navigator", {
      storage: { estimate: async () => ({ quota: 5_000_000, usage: 0 }) },
    });
    const result = await refreshAiStorageHeadroom(1_000_000);
    expect(result.ok).toBe(true);
    expect(aiStorageHeadroomStore.get()).toEqual(result);
  });
});
