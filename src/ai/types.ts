import * as z from "zod/mini";

/**
 * Shared AI contracts for on-device WebLLM (chat, summarize, suggestMeta).
 * Providers and the session layer implement this interface; UI and tests
 * depend on these types rather than WebLLM specifics.
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
  chat(message: string, opts?: GenOpts): AsyncIterable<string>;
  summarize(body: string, opts?: GenOpts): AsyncIterable<string>;
  suggestMeta(body: string): Promise<SuggestedMeta>;
  answer(question: string, context: NoteChunk[], opts?: GenOpts): AsyncIterable<string>;
  dispose(): Promise<void>;
}

export interface EmbeddingProvider {
  init(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly modelId: string;
}
