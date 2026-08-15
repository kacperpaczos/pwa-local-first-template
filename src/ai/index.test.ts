import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These exercise the *real* wiring — actual env var reading (config.ts) and
 * actual navigator.gpu detection (gpu.ts) — not the `overrides` escape hatch
 * on initAiFeature, which only proves the if/else in index.ts itself works.
 * Each test resets modules + stubs env before importing, because
 * aiFeatureEnabled is a top-level const frozen at import time.
 */
describe("initAiFeature (real config + real gpu detection)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is unavailable when VITE_AI_ENABLED=false, even with navigator.gpu present", async () => {
    vi.stubEnv("VITE_AI_ENABLED", "false");
    vi.stubGlobal("navigator", { gpu: {} });

    const { initAiFeature } = await import("./index");
    expect(initAiFeature()).toEqual({ kind: "unavailable", reason: "disabled" });
  });

  it("is unavailable when the flag is on but navigator.gpu is absent", async () => {
    vi.stubGlobal("navigator", {});

    const { initAiFeature } = await import("./index");
    expect(initAiFeature()).toEqual({ kind: "unavailable", reason: "no-webgpu" });
  });

  it("is available when the flag is on and navigator.gpu is present", async () => {
    vi.stubGlobal("navigator", { gpu: {} });

    const { initAiFeature } = await import("./index");
    expect(initAiFeature()).toEqual({ kind: "available", cached: false });
  });

  it("writes the resolved status into aiStatusStore, not just the return value", async () => {
    vi.stubGlobal("navigator", { gpu: {} });

    const { initAiFeature } = await import("./index");
    const { aiStatusStore } = await import("./status");
    initAiFeature();
    expect(aiStatusStore.get()).toEqual({ kind: "available", cached: false });
  });

  it("keeps AI available and stores headroom when free space is low", async () => {
    vi.stubGlobal("navigator", {
      gpu: {},
      storage: {
        estimate: async () => ({ quota: 100_000_000, usage: 90_000_000 }),
      },
    });

    const { initAiFeature, aiStorageHeadroomStore, aiModelApproxBytes } = await import("./index");
    expect(initAiFeature()).toEqual({ kind: "available", cached: false });

    await vi.waitFor(() => {
      const headroom = aiStorageHeadroomStore.get();
      expect(headroom).not.toBeNull();
      expect(headroom?.ok).toBe(false);
      expect(headroom?.required).toBe(aiModelApproxBytes * 1.2);
    });
  });
});
