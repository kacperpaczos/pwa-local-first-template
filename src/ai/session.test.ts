import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerWithRag,
  aiTelemetryStore,
  downloadAiModel,
  resetAiSessionForTests,
  suggestMetaWithAi,
  summarizeWithAi,
  touchAiActivity,
  unloadAiModel,
} from "./session";
import { aiStatusStore, setAiAvailable, setAiUnavailable } from "./status";
import type { AiProvider } from "./types";

function mockProvider(options?: {
  failInit?: boolean;
  chunks?: string[];
  meta?: { title: string; tags: string[] };
  invalidMeta?: unknown;
}): AiProvider {
  return {
    init: vi.fn(async (onProgress) => {
      if (options?.failInit) {
        throw new Error("download failed");
      }
      onProgress({ progress: 0.4, text: "mid" });
      onProgress({ progress: 1, text: "done" });
    }),
    chat: async function* () {
      for (const c of options?.chunks ?? ["hi"]) {
        yield c;
      }
    },
    summarize: async function* () {
      for (const c of options?.chunks ?? ["sum"]) {
        yield c;
      }
    },
    suggestMeta: vi.fn(async () => {
      if (options?.invalidMeta !== undefined) {
        return options.invalidMeta as never;
      }
      return options?.meta ?? { title: "t", tags: [] };
    }),
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

  afterEach(() => {
    resetAiSessionForTests();
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
    globalThis.__createAiProvider = () => mockProvider({ chunks: ["Ala", " ma ", "kota"] });
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

  it("suggestMetaWithAi validates provider output", async () => {
    const provider = mockProvider({
      meta: { title: "Shopping list", tags: ["errands"] },
    });
    globalThis.__createAiProvider = () => provider;
    await downloadAiModel();

    await expect(suggestMetaWithAi("milk and eggs")).resolves.toEqual({
      title: "Shopping list",
      tags: ["errands"],
    });
    expect(provider.suggestMeta).toHaveBeenCalledWith("milk and eggs");
    expect(aiStatusStore.get()).toEqual({ kind: "ready" });
  });

  it("suggestMetaWithAi rejects invalid meta and records error", async () => {
    globalThis.__createAiProvider = () => mockProvider({ invalidMeta: { title: "", tags: [] } });
    await downloadAiModel();

    await expect(suggestMetaWithAi("x")).rejects.toThrow();
    expect(aiStatusStore.get().kind).toBe("error");
  });

  it("suggestMetaWithAi requires a ready model", async () => {
    await expect(suggestMetaWithAi("x")).rejects.toThrow(/not ready/);
  });

  it("dedupes concurrent downloadAiModel calls", async () => {
    let initCalls = 0;
    globalThis.__createAiProvider = () => ({
      ...mockProvider(),
      init: vi.fn(async (onProgress) => {
        initCalls += 1;
        await new Promise((r) => setTimeout(r, 30));
        onProgress({ progress: 1, text: "done" });
      }),
    });

    await Promise.all([downloadAiModel(), downloadAiModel()]);
    expect(initCalls).toBe(1);
    expect(aiStatusStore.get()).toEqual({ kind: "ready" });
  });

  it("runGeneration updates telemetry on success and error", async () => {
    globalThis.__createAiProvider = () => mockProvider({ chunks: ["ok"] });
    await downloadAiModel();
    expect(aiTelemetryStore.get()).toEqual({ inferCount: 0, errorCount: 0, lastMs: null });

    await summarizeWithAi("note");
    const ok = aiTelemetryStore.get();
    expect(ok.inferCount).toBe(1);
    expect(ok.errorCount).toBe(0);
    expect(ok.lastMs).toEqual(expect.any(Number));

    globalThis.__createAiProvider = () => ({
      ...mockProvider(),
      // biome-ignore lint/correctness/useYield: mock stream that fails before yielding
      summarize: async function* () {
        throw new Error("boom");
      },
    });
    // Provider already loaded — force error via a fresh download after unload.
    await unloadAiModel();
    globalThis.__createAiProvider = () => ({
      ...mockProvider(),
      // biome-ignore lint/correctness/useYield: mock stream that fails before yielding
      summarize: async function* () {
        throw new Error("boom");
      },
    });
    await downloadAiModel();
    await expect(summarizeWithAi("x")).rejects.toThrow("boom");
    expect(aiTelemetryStore.get().errorCount).toBe(1);
  });

  it("answerWithRag retrieves context and streams answer", async () => {
    const provider = mockProvider();
    globalThis.__createAiProvider = () => provider;
    await downloadAiModel();

    const text = await answerWithRag("pasta?", [
      { id: "n1", title: "Food", body: "Pasta carbonara with eggs" },
    ]);
    expect(text).toBe("a");
    expect(aiStatusStore.get()).toEqual({ kind: "ready" });
  });

  it("answerWithRag refuses when retrieval is below threshold", async () => {
    globalThis.__createAiProvider = () => mockProvider();
    await downloadAiModel();

    const text = await answerWithRag("quantum chromodynamics vacuum expectation?", [
      { id: "n1", title: "Groceries", body: "Milk and eggs" },
    ]);
    expect(text).toMatch(/don't have that in your notes/i);
  });

  it("warmupAi runs a silent chat after download", async () => {
    let chatCalls = 0;
    const provider = mockProvider();
    const originalChat = provider.chat;
    provider.chat = ((message: string, opts?: { signal?: AbortSignal }) => {
      chatCalls += 1;
      return originalChat(message, opts);
    }) as typeof provider.chat;
    globalThis.__createAiProvider = () => provider;
    await downloadAiModel();
    expect(chatCalls).toBeGreaterThan(0);
  });

  it("unloadAiModel refuses to unload while a generation is in progress", async () => {
    let resolveChunk: (() => void) | undefined;
    globalThis.__createAiProvider = () => ({
      ...mockProvider(),
      summarize: async function* () {
        yield "partial";
        await new Promise<void>((resolve) => {
          resolveChunk = resolve;
        });
        yield " done";
      },
    });
    await downloadAiModel();

    const summarizePromise = summarizeWithAi("note");
    await vi.waitFor(() => expect(aiStatusStore.get().kind).toBe("busy"));

    await expect(unloadAiModel()).rejects.toThrow(/generation is in progress/);
    // Refusing to unload must not have torn anything down.
    expect(aiStatusStore.get().kind).toBe("busy");

    resolveChunk?.();
    await summarizePromise;
    expect(aiStatusStore.get()).toEqual({ kind: "ready" });

    // Once idle again, unload works normally.
    await expect(unloadAiModel()).resolves.toBeUndefined();
  });
});

describe("idle unload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAiSessionForTests();
    setAiAvailable();
    delete globalThis.__createAiProvider;
  });

  afterEach(() => {
    // Clear before restoring real timers so a pending idle timeout is not promoted.
    resetAiSessionForTests();
    vi.useRealTimers();
    delete globalThis.__createAiProvider;
  });

  it("unloads the model after 10 minutes of inactivity", async () => {
    const provider = mockProvider();
    globalThis.__createAiProvider = () => provider;
    await downloadAiModel();
    expect(aiStatusStore.get()).toEqual({ kind: "ready" });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(provider.dispose).toHaveBeenCalled();
    expect(aiStatusStore.get().kind).toBe("available");
  });

  it("touchAiActivity resets the idle timer", async () => {
    const provider = mockProvider();
    globalThis.__createAiProvider = () => provider;
    await downloadAiModel();

    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    touchAiActivity();
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(provider.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(provider.dispose).toHaveBeenCalled();
  });
});

describe("shouldUseAiHarness", () => {
  it("allows DEV, VITE_E2E=1, and Vitest MODE=test", async () => {
    const { shouldUseAiHarness } = await import("./session");
    expect(shouldUseAiHarness({ DEV: true })).toBe(true);
    expect(shouldUseAiHarness({ VITE_E2E: "1" })).toBe(true);
    expect(shouldUseAiHarness({ MODE: "test" })).toBe(true);
  });

  it("blocks production builds", async () => {
    const { shouldUseAiHarness } = await import("./session");
    expect(shouldUseAiHarness({ DEV: false, MODE: "production", VITE_E2E: undefined })).toBe(false);
  });
});
