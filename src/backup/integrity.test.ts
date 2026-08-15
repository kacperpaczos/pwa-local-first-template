import { describe, expect, it } from "vitest";
import { checkDatabaseIntegrity } from "./integrity";

describe("checkDatabaseIntegrity", () => {
  it("is true when PRAGMA integrity_check reports ok", async () => {
    const db = { execute: async () => [{ integrity_check: "ok" }] };
    expect(await checkDatabaseIntegrity(db)).toBe(true);
  });

  it("is false when PRAGMA integrity_check reports a problem", async () => {
    const db = { execute: async () => [{ integrity_check: "row 12 missing from index" }] };
    expect(await checkDatabaseIntegrity(db)).toBe(false);
  });

  it("is false when multiple problem rows come back", async () => {
    const db = {
      execute: async () => [{ integrity_check: "problem 1" }, { integrity_check: "problem 2" }],
    };
    expect(await checkDatabaseIntegrity(db)).toBe(false);
  });
});
