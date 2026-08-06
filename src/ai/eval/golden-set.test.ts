import { describe, expect, it } from "vitest";
import {
  filterChunksByThreshold,
  NO_COVERAGE_ANSWER,
  RETRIEVAL_THRESHOLD,
  degradeIfBadCitations,
  verifyQuote,
} from "../grounding";
import { GOLDEN_SET, matchesNoCoverage, type GoldenCase } from "./golden-set";

type MockChunk = { noteId: string; text: string; score: number };

/**
 * Mock retrieval: map golden-case mockScores onto note body chunks.
 * No real embedding model.
 */
function mockRetrieve(gc: GoldenCase): MockChunk[] {
  return gc.notes
    .map((note) => ({
      noteId: note.id,
      text: [note.title, note.body].filter(Boolean).join("\n"),
      score: gc.mockScores?.[note.id] ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Mock grounded answerer used by golden-set tests (not WebLLM).
 */
function mockAnswerFromRetrieval(gc: GoldenCase, chunks: MockChunk[]): string {
  const usable = filterChunksByThreshold(chunks, RETRIEVAL_THRESHOLD);
  if (usable.length === 0) {
    return NO_COVERAGE_ANSWER;
  }

  if (gc.expected === "answer_from_notes") {
    const top = usable[0]!;
    const grounded = degradeIfBadCitations(
      {
        answer: `From notes: ${top.text.slice(0, 80)}`,
        sources: [{ noteId: top.noteId, quote: top.text.slice(0, 40) }],
        confidence: top.score,
      },
      gc.notes,
    );
    return grounded.answer;
  }

  // World-knowledge / trap questions must not invent facts even if retrieval
  // somehow returned noise — still refuse when expectation says so.
  if (gc.expected === "refuse_world_knowledge" || gc.expected === "admit_no_coverage") {
    return NO_COVERAGE_ANSWER;
  }

  return NO_COVERAGE_ANSWER;
}

describe("golden-set anti-hallucination (mock retrieval)", () => {
  it("has 8–12 bilingual trap cases", () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(8);
    expect(GOLDEN_SET.length).toBeLessThanOrEqual(12);
    expect(GOLDEN_SET.some((c) => c.lang === "pl")).toBe(true);
    expect(GOLDEN_SET.some((c) => c.lang === "en")).toBe(true);
  });

  for (const gc of GOLDEN_SET) {
    it(`${gc.id}: ${gc.expected}`, () => {
      const retrieved = mockRetrieve(gc);
      const above = filterChunksByThreshold(retrieved, RETRIEVAL_THRESHOLD);
      const answer = mockAnswerFromRetrieval(gc, retrieved);

      if (gc.expected === "refuse_world_knowledge" || gc.expected === "admit_no_coverage") {
        expect(above).toHaveLength(0);
        expect(matchesNoCoverage(answer)).toBe(true);
      }

      if (gc.expected === "answer_from_notes") {
        expect(above.length).toBeGreaterThan(0);
        expect(matchesNoCoverage(answer)).toBe(false);
        const quote = above[0]!.text.slice(0, 40);
        expect(verifyQuote(quote, above[0]!.text)).toBe(true);
      }
    });
  }
});
