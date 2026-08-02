import { describe, expect, it } from "vitest";
import { resolveNoteLww, shouldApplyRemote } from "./lww";
import type { Note } from "../db/schemas";

function note(partial: Partial<Note> & Pick<Note, "id" | "lamport" | "updated_at">): Note {
  return {
    title: "t",
    body: "",
    deleted_at: null,
    ...partial,
  };
}

describe("resolveNoteLww", () => {
  it("prefers higher lamport", () => {
    const local = note({
      id: "1",
      lamport: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
      title: "local",
    });
    const remote = note({
      id: "1",
      lamport: 2,
      updated_at: "2026-01-01T00:00:00.000Z",
      title: "remote",
    });
    expect(resolveNoteLww(local, remote).title).toBe("remote");
  });

  it("uses updated_at when lamport ties", () => {
    const local = note({
      id: "1",
      lamport: 2,
      updated_at: "2026-01-01T00:00:00.000Z",
      title: "local",
    });
    const remote = note({
      id: "1",
      lamport: 2,
      updated_at: "2026-01-02T00:00:00.000Z",
      title: "remote",
    });
    expect(resolveNoteLww(local, remote).title).toBe("remote");
  });

  it("shouldApplyRemote is true when missing local", () => {
    const remote = note({
      id: "1",
      lamport: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(shouldApplyRemote(undefined, remote)).toBe(true);
  });
});
