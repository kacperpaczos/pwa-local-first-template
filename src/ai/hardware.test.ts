import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectHardware, recommendTier, resolveAiTier, type HardwareProfile } from "./hardware";
import { AI_TIER_STORAGE_KEY, setPersistedAiTier } from "./config";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function profile(partial: Partial<HardwareProfile>): HardwareProfile {
  return {
    deviceMemory: null,
    maxBufferSize: null,
    maxStorageBufferBindingSize: null,
    isMobile: false,
    storageFreeBytes: null,
    gpuVendor: null,
    gpuArchitecture: null,
    ...partial,
  };
}

describe("recommendTier", () => {
  it("recommends max on strong desktop GPU + RAM + storage", () => {
    expect(
      recommendTier(
        profile({
          deviceMemory: 16,
          maxBufferSize: 2 * 1024 * 1024 * 1024,
          storageFreeBytes: 20 * 1024 * 1024 * 1024,
          isMobile: false,
        }),
      ),
    ).toBe("max");
  });

  it("falls to std on mobile even with strong GPU", () => {
    expect(
      recommendTier(
        profile({
          deviceMemory: 16,
          maxBufferSize: 2 * 1024 * 1024 * 1024,
          storageFreeBytes: 20 * 1024 * 1024 * 1024,
          isMobile: true,
        }),
      ),
    ).toBe("std");
  });

  it("falls to std when buffer is below MAX threshold", () => {
    expect(
      recommendTier(
        profile({
          deviceMemory: 16,
          maxBufferSize: 512 * 1024 * 1024,
          storageFreeBytes: 20 * 1024 * 1024 * 1024,
        }),
      ),
    ).toBe("std");
  });

  it("recommends dev when deviceMemory is very low", () => {
    expect(
      recommendTier(
        profile({
          deviceMemory: 2,
          maxBufferSize: 2 * 1024 * 1024 * 1024,
          storageFreeBytes: 20 * 1024 * 1024 * 1024,
        }),
      ),
    ).toBe("dev");
  });

  it("recommends std when RAM/buffer unknown (conservative)", () => {
    expect(recommendTier(profile({}))).toBe("std");
  });
});

describe("resolveAiTier + persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    setPersistedAiTier(null);
    vi.unstubAllGlobals();
  });

  it("honours forced override over recommendation", () => {
    const result = resolveAiTier(
      profile({
        deviceMemory: 16,
        maxBufferSize: 2 * 1024 * 1024 * 1024,
        storageFreeBytes: 20 * 1024 * 1024 * 1024,
      }),
      { forced: "dev", remember: true },
    );
    expect(result.recommended).toBe("max");
    expect(result.active).toBe("dev");
    expect(globalThis.localStorage.getItem(AI_TIER_STORAGE_KEY)).toBe("dev");
  });
});

describe("detectHardware", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads deviceMemory, adapter limits, mobile UA, and storage", async () => {
    vi.stubGlobal("navigator", {
      deviceMemory: 8,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      gpu: {
        requestAdapter: async () => ({
          limits: {
            maxBufferSize: 1_073_741_824,
            maxStorageBufferBindingSize: 268_435_456,
          },
          info: { vendor: "apple", architecture: "metal" },
        }),
      },
      storage: {
        estimate: async () => ({ quota: 10_000_000_000, usage: 1_000_000_000 }),
      },
    });

    const hw = await detectHardware();
    expect(hw.deviceMemory).toBe(8);
    expect(hw.maxBufferSize).toBe(1_073_741_824);
    expect(hw.maxStorageBufferBindingSize).toBe(268_435_456);
    expect(hw.isMobile).toBe(true);
    expect(hw.storageFreeBytes).toBe(9_000_000_000);
    expect(hw.gpuVendor).toBe("apple");
  });
});
