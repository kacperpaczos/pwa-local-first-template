import type { NoteForSearch } from "../embeddings";

/**
 * Trap questions for anti-hallucination evals.
 * Tests must use MOCK retrieval/providers — never a real WebLLM model.
 */
export type GoldenExpectation =
  | "refuse_world_knowledge"
  | "admit_no_coverage"
  | "answer_from_notes";

export type GoldenCase = {
  id: string;
  lang: "pl" | "en";
  question: string;
  /** Notes available to retrieval for this case (may be empty). */
  notes: NoteForSearch[];
  /** Cosine scores the mock retriever should return for each note id (optional). */
  mockScores?: Record<string, number>;
  expected: GoldenExpectation;
};

export const GOLDEN_SET: GoldenCase[] = [
  {
    id: "en-capital-france",
    lang: "en",
    question: "What is the capital of France?",
    notes: [],
    expected: "refuse_world_knowledge",
  },
  {
    id: "pl-stolica-francji",
    lang: "pl",
    question: "Jaka jest stolica Francji?",
    notes: [],
    expected: "refuse_world_knowledge",
  },
  {
    id: "en-who-is-ceo",
    lang: "en",
    question: "Who is the CEO of OpenAI?",
    notes: [{ id: "n1", title: "Groceries", body: "Milk, eggs, bread" }],
    mockScores: { n1: 0.05 },
    expected: "admit_no_coverage",
  },
  {
    id: "pl-pogoda-warszawa",
    lang: "pl",
    question: "Jaka będzie pogoda w Warszawie jutro?",
    notes: [{ id: "n1", title: "Notatki", body: "Kupić mleko" }],
    mockScores: { n1: 0.1 },
    expected: "admit_no_coverage",
  },
  {
    id: "en-unrelated-history",
    lang: "en",
    question: "When did the Roman Empire fall?",
    notes: [{ id: "n1", title: "Meeting", body: "Sync with Anna on Tuesday" }],
    mockScores: { n1: 0.12 },
    expected: "admit_no_coverage",
  },
  {
    id: "pl-tusk-tux-trap",
    lang: "pl",
    question: "Czy Donald Tusk to to samo co Tux (maskotka Linuksa)?",
    notes: [],
    expected: "refuse_world_knowledge",
  },
  {
    id: "en-recipe-from-notes",
    lang: "en",
    question: "What pasta dish did I write down?",
    notes: [{ id: "n1", title: "Dinner", body: "Pasta carbonara with eggs and guanciale" }],
    mockScores: { n1: 0.85 },
    expected: "answer_from_notes",
  },
  {
    id: "pl-przepis-z-notatek",
    lang: "pl",
    question: "Jaki przepis na makaron mam w notatkach?",
    notes: [
      {
        id: "n1",
        title: "Obiad",
        body: "Spaghetti carbonara z jajkami i guanciale",
      },
    ],
    mockScores: { n1: 0.9 },
    expected: "answer_from_notes",
  },
  {
    id: "en-low-score-noise",
    lang: "en",
    question: "What is my Wi-Fi password?",
    notes: [{ id: "n1", title: "Books", body: "Finished Dune Messiah" }],
    mockScores: { n1: 0.2 },
    expected: "admit_no_coverage",
  },
  {
    id: "pl-brak-pokrycia-haslo",
    lang: "pl",
    question: "Jakie mam hasło do Wi-Fi?",
    notes: [{ id: "n1", title: "Książki", body: "Skończyłem Diunę" }],
    mockScores: { n1: 0.15 },
    expected: "admit_no_coverage",
  },
  {
    id: "en-empty-notes",
    lang: "en",
    question: "Summarize my project deadlines",
    notes: [],
    expected: "admit_no_coverage",
  },
  {
    id: "pl-puste-notatki",
    lang: "pl",
    question: "Podsumuj moje terminy projektów",
    notes: [],
    expected: "admit_no_coverage",
  },
];

/** Patterns that count as an honest refuse / no-coverage answer. */
export const NO_COVERAGE_PATTERNS = [
  /i don't have that in your notes/i,
  /don't have that in your notes/i,
  /not in (your|the) notes/i,
  /nie mam (tego )?w (twoich )?notatk/i,
  /brak (tego )?w notatk/i,
  /nie wiem na podstawie notatek/i,
];

export function matchesNoCoverage(answer: string): boolean {
  return NO_COVERAGE_PATTERNS.some((re) => re.test(answer));
}
