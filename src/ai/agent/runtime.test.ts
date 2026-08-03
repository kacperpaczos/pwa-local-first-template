import { describe, expect, it } from "vitest";
import { createNoteTools, runAgentTurn } from "./runtime";
import type { AiProvider } from "../types";

describe("runAgentTurn", () => {
  it("returns pendingWrite for create_note without writing", async () => {
    const tools = createNoteTools([]);
    const create = tools.find((t) => t.name === "create_note")!;
    const result = await create.execute({ title: "Hello", body: "world" });
    expect(result).toEqual({
      pendingWrite: {
        tool: "create_note",
        args: { title: "Hello", body: "world" },
        summary: 'Create note “Hello”',
      },
    });
  });

  it("blocks disallowed tools via skill filter", async () => {
    const provider: AiProvider = {
      init: async () => undefined,
      chat: async function* () {
        yield JSON.stringify({
          action: "tool",
          tool: "create_note",
          args: { title: "Nope" },
        });
      },
      summarize: async function* () {
        yield "";
      },
      suggestMeta: async () => ({ title: "t", tags: [] }),
      answer: async function* () {
        yield "";
      },
      dispose: async () => undefined,
    };

    const result = await runAgentTurn({
      question: "make a note",
      notes: [],
      provider,
      skill: {
        id: "strict-qa",
        name: "Strict Q&A",
        description: "",
        instructions_md: "",
        allowed_tools: ["search_notes", "read_note"],
        enabled: true,
      },
    });

    expect(result.answer).toMatch(/not available/i);
    expect(result.pendingWrite).toBeUndefined();
  });
});
