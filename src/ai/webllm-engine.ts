import { CreateMLCEngine } from "@mlc-ai/web-llm";
import type { CreateEngineFn } from "./webllm-types";

/** Production factory — boots a real WebLLM engine (WebGPU + model download). */
export const createWebLlmEngine: CreateEngineFn = async (modelId, options) => {
  const engine = await CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      options.initProgressCallback({
        progress: report.progress,
        text: report.text,
      });
    },
  });
  return engine;
};
