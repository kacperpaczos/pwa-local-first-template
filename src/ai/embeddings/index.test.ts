import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  embedOne,
  HashEmbeddingProvider,
  HASH_EMBEDDING_DIMS,
  resetEmbeddingProviderForTests,
  resetEmbeddingStoreForTests,
  semanticSearch,
  topK,
  chunkText,
} from "./index";

describe("cosineSimilarity + topK", () => {
  it("returns 1 for identical L2-normalized vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toThrow(
      /mismatch/,
    );
  });

  it("topK ranks by descending score", () => {
    const query = new Float32Array([1, 0]);
    const ranked = topK(
      query,
      [
        { item: "far", vector: new Float32Array([0, 1]) },
        { item: "near", vector: new Float32Array([0.9, 0.1]) },
        { item: "mid", vector: new Float32Array([0.5, 0.5]) },
      ],
      2,
    );
    expect(ranked.map((r) => r.item)).toEqual(["near", "mid"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("topK returns empty for k<=0", () => {
    expect(topK(new Float32Array([1]), [{ item: "a", vector: new Float32Array([1]) }], 0)).toEqual(
      [],
    );
  });
});

describe("HashEmbeddingProvider", () => {
  it("is deterministic for the same text", async () => {
    const provider = new HashEmbeddingProvider();
    await provider.init();
    const [a] = await provider.embed(["Hello world"]);
    const [b] = await provider.embed(["Hello world"]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect([...a!]).toEqual([...b!]);
    expect(a!.length).toBe(HASH_EMBEDDING_DIMS);
  });

  it("produces L2-normalized vectors", () => {
    const vec = embedOne("notatka testowa");
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) sumSq += vec[i]! * vec[i]!;
    expect(Math.sqrt(sumSq)).toBeCloseTo(1, 5);
  });

  it("changes when text changes", () => {
    const a = embedOne("cats and dogs");
    const b = embedOne("quantum physics");
    expect(cosineSimilarity(a, b)).toBeLessThan(0.95);
  });

  it("is case-insensitive after normalization", () => {
    const a = embedOne("Café");
    const b = embedOne("café");
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});

describe("chunkText", () => {
  it("returns empty for blank input", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("splits with overlap", () => {
    const text = "a".repeat(100);
    const chunks = chunkText(text, 40, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.length).toBe(40);
    // Step is size-overlap = 30
    expect(chunks[1]).toBe(text.slice(30, 70));
  });
});

describe("semanticSearch", () => {
  beforeEach(() => {
    resetEmbeddingProviderForTests();
    resetEmbeddingStoreForTests();
  });

  afterEach(() => {
    resetEmbeddingProviderForTests();
    resetEmbeddingStoreForTests();
  });

  it("ranks the more relevant note higher", async () => {
    const ranked = await semanticSearch("recipes for pasta", [
      { id: "1", title: "Cooking", body: "Pasta carbonara recipe with eggs and cheese" },
      { id: "2", title: "Cars", body: "Engine oil change schedule for winter tires" },
    ]);
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.noteId).toBe("1");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });
});
