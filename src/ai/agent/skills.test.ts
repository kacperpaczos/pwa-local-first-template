import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteTools } from "./runtime";
import {
  AI_SKILLS_STORAGE_KEY,
  BUILTIN_SKILLS,
  filterToolsBySkill,
  getSkillById,
  listSkills,
  saveCustomSkills,
} from "./skills";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("filterToolsBySkill", () => {
  const tools = createNoteTools([]);

  it("Strict Q&A only allows search + read", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "strict-qa")!;
    const filtered = filterToolsBySkill(tools, skill);
    expect(filtered.map((t) => t.name).sort()).toEqual(["read_note", "search_notes"]);
  });

  it("Organize notes allows write proposals", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "organize-notes")!;
    const filtered = filterToolsBySkill(tools, skill);
    expect(filtered.map((t) => t.name)).toEqual(
      expect.arrayContaining(["create_note", "update_note_title", "search_notes", "read_note"]),
    );
  });

  it("disabled skill yields no tools", () => {
    const skill = { ...BUILTIN_SKILLS[0]!, enabled: false };
    expect(filterToolsBySkill(tools, skill)).toEqual([]);
  });
});

describe("custom skills storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists builtins and merges custom skills", () => {
    saveCustomSkills([
      {
        id: "custom-1",
        name: "Custom",
        description: "d",
        instructions_md: "do things",
        allowed_tools: ["search_notes"],
        enabled: true,
      },
    ]);
    const skills = listSkills();
    expect(skills.some((s) => s.id === "strict-qa")).toBe(true);
    expect(getSkillById("custom-1")?.name).toBe("Custom");
    expect(globalThis.localStorage.getItem(AI_SKILLS_STORAGE_KEY)).toBeTruthy();
  });
});
