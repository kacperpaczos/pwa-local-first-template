import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadAiModel,
  resetAiSessionForTests,
  summarizeWithAi,
} from "./session";
import {
  aiStatusStore,
  setAiAvailable,
  setAiUnavailable,
} from "./status";
import type { AiProvider } from "./types";

function mockProvider(options?: {
  failInit?: boolean;
  chunks?: string[];
}): AiProvider {
  return {
    init: vi.fn(async (onProgress) => {
      if (options?.failInit) {
        throw new Error("download failed");
      }
      onProgress({ progress: 0.4, text: "mid" });
      onProgress({ progress: 1, text: "done" });
    }),
    summarize: async function* () {
      for (const c of options?.chunks ?? ["sum"]) {
        yield c;
      }
    },
    suggestMeta: vi.fn(async () => ({ title: "t", tags: [] })),
    answer: async function* () {
      yield "a";
    },
    dispose: vi.fn(async () => undefined),
  };
}

describe("AI session download + inference", () => {
  beforeEach(() => {
    resetAiSessionForTests();
    setAiAvailable();
    delete globalThis.__createAiProvider;
  });

  it("downloadAiModel transitions downloading → ready", async () => {
    const provider = mockProvider();
    globalThis.__createAiProvider = () => provider;

    const seen: string[] = [];
    const unsub = aiStatusStore.subscribe((s) => {
      seen.push(s.kind);
    });

    await downloadAiModel();
    unsub();

    expect(aiStatusStore.get()).toEqual({ kind: "ready" });
    expect(seen).toContain("downloading");
    expect(seen[seen.length - 1]).toBe("ready");
    expect(provider.init).toHaveBeenCalledOnce();
  });

  it("downloadAiModel records errors", async () => {
    globalThis.__createAiProvider = () => mockProvider({ failInit: true });
    await expect(downloadAiModel()).rejects.toThrow("download failed");
    expect(aiStatusStore.get()).toEqual({ kind: "error", reason: "download failed" });
  });

  it("refuses download when unavailable", async () => {
    setAiUnavailable("no-webgpu");
    await expect(downloadAiModel()).rejects.toThrow(/unavailable/);
  });

  it("summarizeWithAi streams chunks and returns busy→ready", async () => {
    globalThis.__createAiProvider = () =>
      mockProvider({ chunks: ["Ala", " ma ", "kota"] });
    await downloadAiModel();

    const chunks: string[] = [];
    const text = await summarizeWithAi("długa notatka", (c) => chunks.push(c));
    expect(text).toBe("Ala ma kota");
    expect(chunks).toEqual(["Ala", " ma ", "kota"]);
    expect(aiStatusStore.get()).toEqual({ kind: "ready" });
  });

  it("summarizeWithAi requires a ready model", async () => {
    await expect(summarizeWithAi("x")).rejects.toThrow(/not ready/);
  });
});
