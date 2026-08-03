import type { AgentTool } from "./runtime";

export type Skill = {
  id: string;
  name: string;
  description: string;
  instructions_md: string;
  allowed_tools: string[];
  enabled: boolean;
};

export const AI_SKILLS_STORAGE_KEY = "pwa-ai-skills";

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "strict-qa",
    name: "Strict Q&A",
    description: "Answer only from notes; no writes.",
    instructions_md:
      "Answer the user's question using only search_notes and read_note. " +
      "Never propose creating or updating notes. If notes lack coverage, say so.",
    allowed_tools: ["search_notes", "read_note"],
    enabled: true,
  },
  {
    id: "organize-notes",
    name: "Organize notes",
    description: "Search, read, and propose create/title updates (UI confirms writes).",
    instructions_md:
      "Help organize notes. You may search and read freely. " +
      "For create_note / update_note_title, prepare a clear proposal — do not assume it was written.",
    allowed_tools: ["search_notes", "read_note", "create_note", "update_note_title"],
    enabled: true,
  },
];

function isSkill(value: unknown): value is Skill {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.description === "string" &&
    typeof s.instructions_md === "string" &&
    Array.isArray(s.allowed_tools) &&
    typeof s.enabled === "boolean"
  );
}

function browserStorage(): Storage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage && typeof storage.getItem === "function") return storage;
  } catch {
    /* unavailable */
  }
  return undefined;
}

/** Custom skills from localStorage (builtins are separate). */
export function loadCustomSkills(): Skill[] {
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(AI_SKILLS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSkill);
  } catch {
    return [];
  }
}

export function saveCustomSkills(skills: Skill[]): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(AI_SKILLS_STORAGE_KEY, JSON.stringify(skills));
  } catch {
    /* quota / private mode */
  }
}

export function listSkills(): Skill[] {
  const custom = loadCustomSkills();
  const customIds = new Set(custom.map((s) => s.id));
  return [...BUILTIN_SKILLS.filter((s) => !customIds.has(s.id)), ...custom];
}

export function getSkillById(id: string): Skill | undefined {
  return listSkills().find((s) => s.id === id);
}

/** Keep only tools allowed by the skill (and only when the skill is enabled). */
export function filterToolsBySkill(tools: AgentTool[], skill: Skill): AgentTool[] {
  if (!skill.enabled) return [];
  const allowed = new Set(skill.allowed_tools);
  return tools.filter((t) => allowed.has(t.name));
}
