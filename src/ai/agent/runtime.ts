import * as z from "zod/mini";
import { semanticSearch, type NoteForSearch } from "../embeddings";
import { degradeIfBadCitations, NO_COVERAGE_ANSWER, tryParseGroundedAnswer } from "../grounding";
import type { AiProvider } from "../types";
import { filterToolsBySkill, type Skill } from "./skills";

export type AgentTool = {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export type PendingWrite = {
  tool: "create_note" | "update_note_title";
  args: Record<string, unknown>;
  summary: string;
};

export type AgentStep = {
  action: "tool" | "answer" | "plan";
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  answer?: string;
};

export type AgentTurnResult = {
  answer: string;
  steps: AgentStep[];
  pendingWrite?: PendingWrite;
  confidence: number;
};

const plannerSchema = z.object({
  action: z.enum(["tool", "answer"]),
  tool: z.optional(z.string()),
  args: z.optional(z.record(z.string(), z.unknown())),
  answer: z.optional(z.string()),
  confidence: z.optional(z.number()),
});

export type PlannerDecision = z.infer<typeof plannerSchema>;

export function parsePlannerDecision(data: unknown): PlannerDecision {
  return plannerSchema.parse(data);
}

function tryParsePlanner(raw: string): PlannerDecision | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    return parsePlannerDecision(JSON.parse(jsonMatch?.[0] ?? raw) as unknown);
  } catch {
    return null;
  }
}

async function collectText(iterable: AsyncIterable<string>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of iterable) {
    parts.push(chunk);
  }
  return parts.join("");
}

/**
 * Built-in note tools. Destructive writes return `{ pendingWrite }` payloads
 * instead of mutating storage — UI must confirm.
 */
export function createNoteTools(notes: NoteForSearch[]): AgentTool[] {
  return [
    {
      name: "search_notes",
      description: "Semantic search over local notes. Args: { query: string, k?: number }",
      async execute(args) {
        const query = typeof args.query === "string" ? args.query : "";
        const k = typeof args.k === "number" ? args.k : 5;
        return semanticSearch(query, notes, k);
      },
    },
    {
      name: "read_note",
      description: "Read one note by id. Args: { noteId: string }",
      async execute(args) {
        const noteId = typeof args.noteId === "string" ? args.noteId : "";
        const note = notes.find((n) => n.id === noteId);
        if (!note) return { error: "note not found" };
        return { id: note.id, title: note.title ?? "", body: note.body };
      },
    },
    {
      name: "create_note",
      description:
        "Propose creating a note (requires UI confirmation). Args: { title: string, body?: string }",
      async execute(args) {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const body = typeof args.body === "string" ? args.body : "";
        if (!title) return { error: "title required" };
        const pendingWrite: PendingWrite = {
          tool: "create_note",
          args: { title, body },
          summary: `Create note “${title}”`,
        };
        return { pendingWrite };
      },
    },
    {
      name: "update_note_title",
      description:
        "Propose renaming a note (requires UI confirmation). Args: { noteId: string, title: string }",
      async execute(args) {
        const noteId = typeof args.noteId === "string" ? args.noteId : "";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!noteId || !title) return { error: "noteId and title required" };
        const pendingWrite: PendingWrite = {
          tool: "update_note_title",
          args: { noteId, title },
          summary: `Rename note ${noteId} → “${title}”`,
        };
        return { pendingWrite };
      },
    },
  ];
}

function simplePlan(question: string, tools: AgentTool[]): PlannerDecision {
  const hasSearch = tools.some((t) => t.name === "search_notes");
  if (hasSearch) {
    return {
      action: "tool",
      tool: "search_notes",
      args: { query: question, k: 5 },
      confidence: 0.5,
    };
  }
  return {
    action: "answer",
    answer: NO_COVERAGE_ANSWER,
    confidence: 0,
  };
}

async function planNext(
  question: string,
  tools: AgentTool[],
  skill: Skill | undefined,
  history: AgentStep[],
  provider: AiProvider | null,
): Promise<PlannerDecision> {
  if (!provider) {
    if (history.length === 0) return simplePlan(question, tools);
    return {
      action: "answer",
      answer: formatToolHistoryAnswer(history),
      confidence: 0.4,
    };
  }

  const toolCatalog = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const skillBlock = skill
    ? `Skill: ${skill.name}\n${skill.instructions_md}`
    : "No skill selected.";
  const historyBlock =
    history.length === 0 ? "(none)" : history.map((s) => JSON.stringify(s)).join("\n");

  const prompt = [
    "You are an on-device note agent. Reply with ONLY JSON:",
    '{"action":"tool"|"answer","tool":"...","args":{},"answer":"...","confidence":0.0}',
    skillBlock,
    "Available tools:",
    toolCatalog || "(none)",
    "Prior steps:",
    historyBlock,
    `User question: ${question}`,
  ].join("\n");

  try {
    const raw = await collectText(provider.chat(prompt));
    const parsed = tryParsePlanner(raw);
    if (parsed) return parsed;
  } catch {
    /* fall through to heuristic */
  }

  if (history.length === 0) return simplePlan(question, tools);
  return {
    action: "answer",
    answer: formatToolHistoryAnswer(history),
    confidence: 0.35,
  };
}

function formatToolHistoryAnswer(history: AgentStep[]): string {
  const lastTool = [...history].reverse().find((s) => s.action === "tool");
  if (!lastTool) return NO_COVERAGE_ANSWER;
  return `Based on tools: ${JSON.stringify(lastTool.result ?? null)}`;
}

function extractPendingWrite(result: unknown): PendingWrite | undefined {
  if (!result || typeof result !== "object") return undefined;
  const pw = (result as { pendingWrite?: PendingWrite }).pendingWrite;
  if (!pw || typeof pw !== "object") return undefined;
  if (pw.tool !== "create_note" && pw.tool !== "update_note_title") return undefined;
  return pw;
}

export type RunAgentTurnInput = {
  question: string;
  notes: NoteForSearch[];
  provider?: AiProvider | null;
  tools?: AgentTool[];
  skill?: Skill;
  maxSteps?: number;
};

/**
 * Thin agent loop: plan → optional tool → answer.
 * Write tools never mutate storage; they surface `pendingWrite` for UI confirm.
 */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult> {
  const maxSteps = input.maxSteps ?? 4;
  const allTools = input.tools ?? createNoteTools(input.notes);
  const tools = input.skill ? filterToolsBySkill(allTools, input.skill) : allTools;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const steps: AgentStep[] = [];
  let pendingWrite: PendingWrite | undefined;

  for (let i = 0; i < maxSteps; i++) {
    const decision = await planNext(
      input.question,
      tools,
      input.skill,
      steps,
      input.provider ?? null,
    );

    if (decision.action === "answer") {
      let answer = decision.answer?.trim() || NO_COVERAGE_ANSWER;
      let confidence = decision.confidence ?? 0.5;
      const grounded = tryParseGroundedAnswer(answer);
      if (grounded) {
        const degraded = degradeIfBadCitations(grounded, input.notes);
        answer = degraded.answer;
        confidence = degraded.confidence;
      }
      steps.push({ action: "answer", answer });
      return { answer, steps, pendingWrite, confidence };
    }

    const toolName = decision.tool ?? "";
    const tool = byName.get(toolName);
    if (!tool) {
      steps.push({
        action: "plan",
        tool: toolName,
        result: { error: `tool not allowed: ${toolName}` },
      });
      return {
        answer: `Tool “${toolName}” is not available for this skill.`,
        steps,
        pendingWrite,
        confidence: 0,
      };
    }

    const args = (decision.args ?? {}) as Record<string, unknown>;
    const result = await tool.execute(args);
    steps.push({ action: "tool", tool: toolName, args, result });

    const pw = extractPendingWrite(result);
    if (pw) {
      pendingWrite = pw;
      return {
        answer: `Proposed write pending confirmation: ${pw.summary}`,
        steps,
        pendingWrite,
        confidence: decision.confidence ?? 0.6,
      };
    }
  }

  return {
    answer: formatToolHistoryAnswer(steps),
    steps,
    pendingWrite,
    confidence: 0.3,
  };
}
