import type { EmbeddingProvider } from "../types";

/** Fixed output dimension — small enough for local note search. */
export const HASH_EMBEDDING_DIMS = 256;

/** Character n-gram size used for the bag-of-hashes features. */
export const HASH_NGRAM = 3;

/**
 * Deterministic local embedding via bag-of-hashed character n-grams.
 * No ML deps — safe for the PWA bundle. Swap for a transformers adapter later
 * by implementing the same `EmbeddingProvider` interface.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = "hash-ngram-v1";

  async init(): Promise<void> {
    /* no-op — pure CPU hashing */
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => embedOne(text));
  }
}

/** Pure helper — same algorithm as `HashEmbeddingProvider.embed` for one string. */
export function embedOne(text: string, dims = HASH_EMBEDDING_DIMS): Float32Array {
  const vec = new Float32Array(dims);
  const normalized = text.normalize("NFKC").toLowerCase();
  if (normalized.length === 0) {
    return vec;
  }

  const padded = ` ${normalized} `;
  for (let i = 0; i <= padded.length - HASH_NGRAM; i++) {
    const gram = padded.slice(i, i + HASH_NGRAM);
    const h = fnv1a32(gram);
    const index = h % dims;
    // Signed feature (±1) reduces collisions a bit (simhash-style).
    const sign = (h & 0x8000_0000) === 0 ? 1 : -1;
    vec[index] += sign;
  }

  return l2Normalize(vec);
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i]! * vec[i]!;
  }
  if (sumSq <= 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < vec.length; i++) {
    vec[i]! *= inv;
  }
  return vec;
}
