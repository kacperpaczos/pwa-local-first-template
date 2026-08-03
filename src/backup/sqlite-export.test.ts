import { describe, expect, it } from "vitest";
import { exportDatabaseAsSql, sqliteDumpFileName } from "./sqlite-export";

describe("sqliteDumpFileName", () => {
  it("uses .sql extension", () => {
    expect(sqliteDumpFileName(new Date("2026-01-02T03:04:05.678Z"))).toMatch(
      /\.sql$/,
    );
  });
});

describe("exportDatabaseAsSql", () => {
  it("dumps create + insert statements for user tables", async () => {
    const tables = [{ name: "notes" }];
    const create = [{ sql: "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT)" }];
    const rows = [{ id: "a1", title: "hello" }];

    const db = {
      rawDb: {
        execute: async (sql: string) => {
          if (sql.includes("sqlite_master") && sql.includes("type='table'") && sql.includes("ORDER BY")) {
            return tables;
          }
          if (sql.includes("SELECT sql FROM sqlite_master")) {
            return create;
          }
          if (sql.includes('SELECT * FROM "notes"')) {
            return rows;
          }
          return [];
        },
      },
    };

    const dump = await exportDatabaseAsSql(db as never);
    expect(dump).toContain("BEGIN;");
    expect(dump).toContain("CREATE TABLE notes");
    expect(dump).toContain('INSERT INTO "notes"');
    expect(dump).toContain("'hello'");
    expect(dump).toContain("COMMIT;");
  });

  it("escapes single quotes in values", async () => {
    const db = {
      rawDb: {
        execute: async (sql: string) => {
          if (sql.includes("ORDER BY")) return [{ name: "notes" }];
          if (sql.includes("SELECT sql")) return [{ sql: "CREATE TABLE notes (t TEXT)" }];
          if (sql.includes("SELECT *")) return [{ t: "it's fine" }];
          return [];
        },
      },
    };
    const dump = await exportDatabaseAsSql(db as never);
    expect(dump).toContain("'it''s fine'");
  });
});
