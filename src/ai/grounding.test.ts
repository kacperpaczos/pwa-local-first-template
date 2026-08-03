import { afterEach, describe, expect, it } from "vitest";
import {
  buildGroundedSystemPrompt,
  degradeIfBadCitations,
  filterChunksByThreshold,
  NO_COVERAGE_ANSWER,
  RETRIEVAL_THRESHOLD,
  verifyQuote,
} from "./grounding";

describe("verifyQuote", () => {
  it("matches substring after whitespace normalization", () => {
    expect(verifyQuote("pasta   carbonara", "Tonight: Pasta\ncarbonara with eggs")).toBe(true);
  });

  it("rejects quotes not present in the note", () => {
    expect(verifyQuote("quantum entanglement", "Shopping list: milk")).toBe(false);
  });
});

describe("buildGroundedSystemPrompt", () => {
  it("includes date and refuse rule", () => {
    const prompt = buildGroundedSystemPrompt("2026-08-03");
    expect(prompt).toContain("2026-08-03");
    expect(prompt).toContain(NO_COVERAGE_ANSWER);
    expect(prompt.toLowerCase()).toContain("world knowledge");
  });
});

describe("degradeIfBadCitations", () => {
  const notes = [{ id: "n1", title: "Food", body: "Pasta carbonara with eggs" }];

  it("keeps verified quotes", () => {
    const result = degradeIfBadCitations(
      {
        answer: "Pasta",
        sources: [{ noteId: "n1", quote: "Pasta carbonara" }],
        confidence: 0.9,
      },
      notes,
    );
    expect(result.sources).toHaveLength(1);
    expect(result.confidence).toBe(0.9);
  });

  it("refuses when all citations fail", () => {
    const result = degradeIfBadCitations(
      {
        answer: "Made up",
        sources: [{ noteId: "n1", quote: "not in the note at all" }],
        confidence: 0.9,
      },
      notes,
    );
    expect(result.answer).toBe(NO_COVERAGE_ANSWER);
    expect(result.sources).toEqual([]);
    expect(result.confidence).toBe(0);
  });

  it("lowers confidence when some citations are dropped", () => {
    const result = degradeIfBadCitations(
      {
        answer: "Mixed",
        sources: [
          { noteId: "n1", quote: "Pasta carbonara" },
          { noteId: "n1", quote: "totally fabricated" },
        ],
        confidence: 0.95,
      },
      notes,
    );
    expect(result.sources).toHaveLength(1);
    expect(result.confidence).toBeLessThanOrEqual(0.4);
  });
});

describe("filterChunksByThreshold", () => {
  afterEach(() => {
    /* no-op — keeps suite shape consistent */
  });

  it("drops scores below RETRIEVAL_THRESHOLD", () => {
    const kept = filterChunksByThreshold([
      { score: RETRIEVAL_THRESHOLD, id: "a" },
      { score: RETRIEVAL_THRESHOLD - 0.01, id: "b" },
      { score: 0.9, id: "c" },
    ]);
    expect(kept.map((c) => c.id)).toEqual(["a", "c"]);
  });
});
