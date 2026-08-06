import type { EmbeddingProvider, NoteChunk } from "../types";
import { HashEmbeddingProvider } from "./hash-provider";
import { topK } from "./similarity";
import { getStoredEmbedding, hashBody, putStoredEmbedding, storageKey } from "./store";

export { HashEmbeddingProvider, HASH_EMBEDDING_DIMS, embedOne } from "./hash-provider";
export { cosineSimilarity, topK, type ScoredItem } from "./similarity";
export {
  clearEmbeddingStore,
  getStoredEmbedding,
  hashBody,
  putStoredEmbedding,
  resetEmbeddingStoreForTests,
  type StoredEmbedding,
} from "./store";

let embeddingProvider: EmbeddingProvider | null = null;

export type NoteForSearch = {
  id: string;
  body: string;
  title?: string;
};

export type RankedNote = {
  noteId: string;
  score: number;
};

/** Lazy-init singleton embedding provider (hash by default). */
export async function ensureEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (!embeddingProvider) {
    embeddingProvider = new HashEmbeddingProvider();
    await embeddingProvider.init();
  }
  return embeddingProvider;
}

/** Test helper — clears the embedding provider singleton. */
export function resetEmbeddingProviderForTests(): void {
  embeddingProvider = null;
}

/**
 * Embed `text` for `noteId` and cache locally (IndexedDB / localStorage).
 * Cache key is noteId + body hash so edits invalidate automatically.
 */
export async function embedAndStore(noteId: string, text: string): Promise<Float32Array> {
  const provider = await ensureEmbeddingProvider();
  const bodyHash = hashBody(text);
  const cached = await getStoredEmbedding(noteId, bodyHash);
  if (cached && cached.modelId === provider.modelId) {
    return Float32Array.from(cached.values);
  }

  const [vector] = await provider.embed([text]);
  if (!vector) {
    throw new Error("Embedding provider returned no vector");
  }

  await putStoredEmbedding({
    key: storageKey(noteId, bodyHash),
    noteId,
    bodyHash,
    modelId: provider.modelId,
    dims: vector.length,
    values: Array.from(vector),
  });
  return vector;
}

/**
 * Rank notes by cosine similarity of their body embeddings to `query`.
 * Returns note ids highest-first.
 */
export async function semanticSearch(
  query: string,
  notes: NoteForSearch[],
  k = 8,
): Promise<RankedNote[]> {
  const active = notes.filter((n) => n.body.trim().length > 0 || (n.title?.trim().length ?? 0) > 0);
  if (active.length === 0 || !query.trim()) return [];

  const provider = await ensureEmbeddingProvider();
  const [queryVec] = await provider.embed([query]);
  if (!queryVec) return [];

  const candidates: Array<{ item: string; vector: Float32Array }> = [];
  for (const note of active) {
    const text = [note.title?.trim(), note.body.trim()].filter(Boolean).join("\n");
    const vector = await embedAndStore(note.id, text);
    candidates.push({ item: note.id, vector });
  }

  return topK(queryVec, candidates, k).map(({ item, score }) => ({
    noteId: item,
    score,
  }));
}

/**
 * Split text into overlapping character windows for RAG retrieval.
 */
export function chunkText(text: string, size = 400, overlap = 50): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (size <= 0) throw new Error("chunk size must be > 0");
  if (overlap < 0 || overlap >= size) {
    throw new Error("overlap must be >= 0 and < size");
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    const end = Math.min(start + size, trimmed.length);
    chunks.push(trimmed.slice(start, end));
    if (end >= trimmed.length) break;
    start += size - overlap;
  }
  return chunks;
}

export type RankedChunk = NoteChunk & { score: number };

/**
 * Build note chunks, embed them, and return the top-k most similar to `query`
 * (with cosine scores).
 */
export async function retrieveRankedChunks(
  query: string,
  notes: NoteForSearch[],
  k = 4,
): Promise<RankedChunk[]> {
  const provider = await ensureEmbeddingProvider();
  const [queryVec] = await provider.embed([query]);
  if (!queryVec) return [];

  const candidates: Array<{ item: NoteChunk; vector: Float32Array }> = [];
  for (const note of notes) {
    const text = [note.title?.trim(), note.body.trim()].filter(Boolean).join("\n");
    if (!text) continue;
    const pieces = chunkText(text);
    if (pieces.length === 0) continue;
    const vectors = await provider.embed(pieces);
    for (let i = 0; i < pieces.length; i++) {
      const vector = vectors[i];
      const piece = pieces[i];
      if (!vector || !piece) continue;
      candidates.push({
        item: { noteId: note.id, text: piece },
        vector,
      });
    }
  }

  return topK(queryVec, candidates, k).map(({ item, score }) => ({
    ...item,
    score,
  }));
}

/**
 * Build note chunks, embed them, and return the top-k most similar to `query`.
 */
export async function retrieveTopChunks(
  query: string,
  notes: NoteForSearch[],
  k = 4,
): Promise<NoteChunk[]> {
  const ranked = await retrieveRankedChunks(query, notes, k);
  return ranked.map(({ noteId, text }) => ({ noteId, text }));
}
