import type {
  AiProvider,
  GenOpts,
  InitProgress,
  NoteChunk,
  SuggestedMeta,
} from "./types";
import { parseSuggestedMeta } from "./types";
import {
  mapInitProgress,
  type CreateEngineFn,
  type WebLlmEngine,
  type WebLlmProviderOptions,
} from "./webllm-types";

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("AI operation aborted", "AbortError");
  }
}

/**
 * AiProvider backed by WebLLM. `createEngine` is injectable so Vitest can
 * cover download progress + streaming inference without WebGPU or HF downloads.
 */
export class WebLlmAiProvider implements AiProvider {
  private engine: WebLlmEngine | null = null;
  private readonly modelId: string;
  private readonly createEngine: CreateEngineFn;

  constructor(options: WebLlmProviderOptions) {
    this.modelId = options.modelId;
    this.createEngine = options.createEngine;
  }

  async init(onProgress: (progress: InitProgress) => void, signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    if (this.engine) {
      onProgress({ progress: 1, text: "already loaded" });
      return;
    }

    const onAbort = () => {
      /* CreateMLCEngine has no cancel; we refuse to keep the engine if aborted mid-flight. */
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      this.engine = await this.createEngine(this.modelId, {
        initProgressCallback: (report) => {
          onProgress(mapInitProgress(report));
        },
      });
      assertNotAborted(signal);
      onProgress({ progress: 1, text: "ready" });
    } catch (error) {
      this.engine = null;
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async *summarize(body: string, opts?: GenOpts): AsyncIterable<string> {
    yield* this.streamChat(
      [
        {
          role: "system",
          content:
            "You summarize notes. Reply with a short summary in the same language as the note. No preamble.",
        },
        { role: "user", content: body },
      ],
      opts,
    );
  }

  async suggestMeta(body: string): Promise<SuggestedMeta> {
    const chunks: string[] = [];
    for await (const part of this.streamChat(
      [
        {
          role: "system",
          content:
            'Return ONLY JSON: {"title":"...","tags":["..."]}. Title max 120 chars, at most 8 short tags.',
        },
        { role: "user", content: body },
      ],
      undefined,
    )) {
      chunks.push(part);
    }
    const raw = chunks.join("").trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return parseSuggestedMeta(JSON.parse(jsonMatch?.[0] ?? raw) as unknown);
  }

  async *answer(question: string, context: NoteChunk[], opts?: GenOpts): AsyncIterable<string> {
    const contextBlock = context
      .map((c) => `[note ${c.noteId}]\n${c.text}`)
      .join("\n\n");
    yield* this.streamChat(
      [
        {
          role: "system",
          content: "Answer using only the provided note context. If unsure, say so briefly.",
        },
        {
          role: "user",
          content: `Context:\n${contextBlock}\n\nQuestion: ${question}`,
        },
      ],
      opts,
    );
  }

  async dispose(): Promise<void> {
    if (!this.engine) return;
    await this.engine.unload();
    this.engine = null;
  }

  private async *streamChat(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    opts?: GenOpts,
  ): AsyncIterable<string> {
    assertNotAborted(opts?.signal);
    if (!this.engine) {
      throw new Error("WebLLM engine is not initialized — call init() first");
    }

    const stream = await this.engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.2,
    });

    if (!Symbol.asyncIterator || !(Symbol.asyncIterator in Object(stream))) {
      const nonStream = stream as { choices: Array<{ message?: { content?: string | null } }> };
      const content = nonStream.choices[0]?.message?.content ?? "";
      if (content) yield content;
      return;
    }

    for await (const chunk of stream as AsyncIterable<{
      choices?: Array<{ delta?: { content?: string | null } }>;
    }>) {
      assertNotAborted(opts?.signal);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
