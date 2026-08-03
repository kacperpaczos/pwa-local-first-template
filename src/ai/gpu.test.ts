import { afterEach, describe, expect, it, vi } from "vitest";
import { hasWebGpu } from "./gpu";

describe("hasWebGpu", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false when navigator is undefined", () => {
    vi.stubGlobal("navigator", undefined);
    expect(hasWebGpu()).toBe(false);
  });

  it("is false when navigator.gpu is missing", () => {
    vi.stubGlobal("navigator", {});
    expect(hasWebGpu()).toBe(false);
  });

  it("is false when navigator.gpu is defined but null/undefined", () => {
    vi.stubGlobal("navigator", { gpu: undefined });
    expect(hasWebGpu()).toBe(false);
  });

  it("is true when navigator.gpu is present", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    expect(hasWebGpu()).toBe(true);
  });
});
