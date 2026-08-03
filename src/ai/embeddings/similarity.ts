export type ScoredItem<T> = { item: T; score: number };

/** Cosine similarity for equal-length Float32Array vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Returns the `k` highest-scoring items by cosine similarity to `query`.
 * Stable for ties (earlier index wins).
 */
export function topK<T>(
  query: Float32Array,
  candidates: Array<{ item: T; vector: Float32Array }>,
  k: number,
): ScoredItem<T>[] {
  if (k <= 0) return [];
  const scored: ScoredItem<T>[] = candidates.map(({ item, vector }) => ({
    item,
    score: cosineSimilarity(query, vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.min(k, scored.length));
}
