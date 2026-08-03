import type { InitProgress } from "./types";

/**
 * Narrow engine surface used by `WebLlmAiProvider`.
 * Kept tiny so unit tests can stub it without booting WebGPU.
 */
export type WebLlmChatChunk = {
  choices?: Array<{ delta?: { content?: string | null } }>;
};

export type WebLlmEngine = {
  chat: {
    completions: {
      create: (request: {
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        stream?: boolean;
        temperature?: number;
      }) => Promise<
        | AsyncIterable<WebLlmChatChunk>
        | { choices: Array<{ message?: { content?: string | null } }> }
      >;
    };
  };
  unload: () => Promise<void>;
};

export type CreateEngineFn = (
  modelId: string,
  options: {
    initProgressCallback: (report: { progress: number; text: string }) => void;
  },
) => Promise<WebLlmEngine>;

export type WebLlmProviderOptions = {
  modelId: string;
  createEngine: CreateEngineFn;
};

export function mapInitProgress(report: { progress: number; text: string }): InitProgress {
  return {
    progress: Math.min(1, Math.max(0, report.progress)),
    text: report.text,
  };
}
