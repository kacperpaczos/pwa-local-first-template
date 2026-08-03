import { describe, expect, it, vi } from "vitest";
import { WebLlmAiProvider } from "./webllm-provider";
import { mapInitProgress, type CreateEngineFn, type WebLlmEngine } from "./webllm-types";

function chunk(content: string) {
  return { choices: [{ delta: { content } }] };
}

function createFakeEngine(parts: string[]): WebLlmEngine {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          async function* gen() {
            for (const part of parts) {
              yield chunk(part);
            }
          }
          return gen();
        }),
      },
    },
    unload: vi.fn(async () => undefined),
  };
}

describe("WebLlmAiProvider", () => {
  it("reports download progress during init", async () => {
    const progress: number[] = [];
    const createEngine: CreateEngineFn = async (_modelId, options) => {
      options.initProgressCallback({ progress: 0.25, text: "quarter" });
      options.initProgressCallback({ progress: 0.75, text: "almost" });
      return createFakeEngine(["ok"]);
    };

    const provider = new WebLlmAiProvider({
      modelId: "fake-model",
      createEngine,
    });

    await provider.init((p) => progress.push(p.progress));
    expect(progress).toEqual([0.25, 0.75, 1]);
  });

  it("streams summarize tokens from the engine", async () => {
    const createEngine: CreateEngineFn = async () => createFakeEngine(["Hel", "lo", "!"]);
    const provider = new WebLlmAiProvider({ modelId: "fake", createEngine });
    await provider.init(() => undefined);

    const out: string[] = [];
    for await (const part of provider.summarize("long note body")) {
      out.push(part);
    }
    expect(out.join("")).toBe("Hello!");
  });

  it("honours AbortSignal during summarize", async () => {
    const createEngine: CreateEngineFn = async () =>
      createFakeEngine(["a", "b", "c", "d"]);
    const provider = new WebLlmAiProvider({ modelId: "fake", createEngine });
    await provider.init(() => undefined);

    const controller = new AbortController();
    const iter = provider.summarize("x", { signal: controller.signal })[Symbol.asyncIterator]();
    await iter.next();
    controller.abort();
    await expect(iter.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws when summarizing before init", async () => {
    const provider = new WebLlmAiProvider({
      modelId: "fake",
      createEngine: async () => createFakeEngine([]),
    });
    const iter = provider.summarize("x");
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/not initialized/);
  });

  it("dispose unloads the engine", async () => {
    const engine = createFakeEngine([]);
    const provider = new WebLlmAiProvider({
      modelId: "fake",
      createEngine: async () => engine,
    });
    await provider.init(() => undefined);
    await provider.dispose();
    expect(engine.unload).toHaveBeenCalledOnce();
  });
});

describe("mapInitProgress", () => {
  it("clamps progress to 0..1", () => {
    expect(mapInitProgress({ progress: -1, text: "x" }).progress).toBe(0);
    expect(mapInitProgress({ progress: 2, text: "x" }).progress).toBe(1);
  });
});
