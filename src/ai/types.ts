import * as z from "zod/mini";

/**
 * Skeleton contract for Faza 3 (WebLLM). No implementation lands until
 * Etap 3.1 — this file only fixes the shape so later stages (and the
 * mock-based adapter tests) can be written against a stable interface.
 */

export type InitProgress = {
  /** 0..1 */
  progress: number;
  text: string;
};

export type GenOpts = {
  signal?: AbortSignal;
};

export type NoteChunk = {
  noteId: string;
  text: string;
};

export const suggestedMetaSchema = z.object({
  title: z.string().check(z.minLength(1), z.maxLength(120)),
  tags: z.array(z.string().check(z.minLength(1), z.maxLength(32))).check(z.maxLength(8)),
});

export type SuggestedMeta = z.infer<typeof suggestedMetaSchema>;

export function parseSuggestedMeta(data: unknown): SuggestedMeta {
  return suggestedMetaSchema.parse(data);
}

export interface AiProvider {
  init(onProgress: (progress: InitProgress) => void, signal?: AbortSignal): Promise<void>;
  summarize(body: string, opts?: GenOpts): AsyncIterable<string>;
  suggestMeta(body: string): Promise<SuggestedMeta>;
  answer(question: string, context: NoteChunk[]): AsyncIterable<string>;
  dispose(): Promise<void>;
}

export interface EmbeddingProvider {
  init(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly modelId: string;
}
