import * as z from "zod/mini";
import type { NoteForSearch } from "./embeddings";

/** Minimum cosine similarity for a retrieved chunk to count as evidence. */
export const RETRIEVAL_THRESHOLD = 0.3;

export const NO_COVERAGE_ANSWER = "I don't have that in your notes";

export const groundedSourceSchema = z.object({
  noteId: z.string().check(z.minLength(1)),
  quote: z.string().check(z.minLength(1)),
});

export const groundedAnswerSchema = z.object({
  answer: z.string(),
  sources: z.array(groundedSourceSchema),
  confidence: z.number(),
});

export type GroundedSource = z.infer<typeof groundedSourceSchema>;
export type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;

/** Collapse whitespace for substring citation checks. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when `quote` appears in `noteBody` after whitespace normalization. */
export function verifyQuote(quote: string, noteBody: string): boolean {
  const q = normalizeWhitespace(quote);
  if (!q) return false;
  return normalizeWhitespace(noteBody).includes(q);
}

/**
 * Versioned system prompt: facts only from provided fragments; refuse world knowledge.
 */
export function buildGroundedSystemPrompt(date: string): string {
  return [
    `Today's date is ${date}.`,
    "You answer ONLY from the note fragments provided in the user message.",
    "Do not use world knowledge, training data, or guesses as facts.",
    `If the fragments do not cover the question, reply exactly: "${NO_COVERAGE_ANSWER}".`,
    "When you use a fact, keep a short verbatim quote from a fragment.",
    'Prefer JSON: {"answer":"...","sources":[{"noteId":"...","quote":"..."}],"confidence":0.0}.',
  ].join(" ");
}

export function parseGroundedAnswer(data: unknown): GroundedAnswer {
  return groundedAnswerSchema.parse(data);
}

/** Try to extract a grounded JSON object from free-form model output. */
export function tryParseGroundedAnswer(raw: string): GroundedAnswer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    return parseGroundedAnswer(JSON.parse(jsonMatch?.[0] ?? trimmed) as unknown);
  } catch {
    return null;
  }
}

/**
 * Drop unverifiable citations and lower confidence / refuse if sources were required
 * but none survive verification.
 */
export function degradeIfBadCitations(
  result: GroundedAnswer,
  notes: NoteForSearch[],
): GroundedAnswer {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const validSources = result.sources.filter((source) => {
    const note = byId.get(source.noteId);
    if (!note) return false;
    const body = [note.title?.trim(), note.body].filter(Boolean).join("\n");
    return verifyQuote(source.quote, body);
  });

  if (result.sources.length > 0 && validSources.length === 0) {
    return {
      answer: NO_COVERAGE_ANSWER,
      sources: [],
      confidence: 0,
    };
  }

  if (validSources.length < result.sources.length) {
    return {
      ...result,
      sources: validSources,
      confidence: Math.min(result.confidence, 0.4),
    };
  }

  return { ...result, sources: validSources };
}

/** Filter ranked retrieval hits by {@link RETRIEVAL_THRESHOLD}. */
export function filterChunksByThreshold<T extends { score: number }>(
  chunks: T[],
  threshold: number = RETRIEVAL_THRESHOLD,
): T[] {
  return chunks.filter((c) => c.score >= threshold);
}
