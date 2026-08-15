import type { AppDatabase } from "@/shared/db/client";

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
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export function sqliteDumpFileName(at: Date = new Date()): string {
  return `pwa-local-first-${at.toISOString().replace(/[:.]/g, "-")}.sql`;
}

export function downloadSqlDump(sql: string, at: Date = new Date()): void {
  if (typeof document === "undefined") {
    throw new Error("downloadSqlDump requires a browser environment");
  }
  const blob = new Blob([sql], { type: "application/sql" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = sqliteDumpFileName(at);
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
