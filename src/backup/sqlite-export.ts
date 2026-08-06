import type { AppDatabase } from "@/shared/db/client";
import { triggerDownload } from "@/shared/lib/download";

/**
 * Best-effort binary/SQL export of the local OPFS SQLite database.
 *
 * TanStack's wa-sqlite handle exposes `execute` but not a stable `serialize()`
 * across versions, so we dump user tables as a portable `.sql` script that
 * can recreate note rows. Prefer JSON backup for cross-device restore via
 * merge; use this for forensic / offline inspection.
 */
export async function exportDatabaseAsSql(db: AppDatabase): Promise<string> {
  const lines: string[] = [
    "-- pwa-local-first SQLite dump",
    `-- exportedAt: ${new Date().toISOString()}`,
    "BEGIN;",
  ];

  const tables = await db.rawDb.execute<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );

  for (const { name } of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;

    const createRows = await db.rawDb.execute<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
      [name],
    );
    const createSql = createRows[0]?.sql;
    if (createSql) {
      lines.push(`${createSql};`);
    }

    const rows = await db.rawDb.execute<Record<string, unknown>>(
      `SELECT * FROM "${name}"`,
    );
    for (const row of rows) {
      const cols = Object.keys(row);
      if (cols.length === 0) continue;
      const values = cols.map((col) => sqlLiteral(row[col]));
      lines.push(
        `INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${values.join(", ")});`,
      );
    }
  }

  lines.push("COMMIT;");
  return lines.join("\n");
}

function sqlLiteral(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) {
    const hex = [...value].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `X'${hex}'`;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export function sqliteDumpFileName(at: Date = new Date()): string {
  return `pwa-local-first-${at.toISOString().replace(/[:.]/g, "-")}.sql`;
}

export function downloadSqlDump(sql: string, at: Date = new Date()): void {
  triggerDownload(sql, sqliteDumpFileName(at), "application/sql");
}
