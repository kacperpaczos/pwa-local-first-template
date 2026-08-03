export type RawSqlExecutor = {
  execute: (sql: string, params?: readonly unknown[]) => Promise<readonly unknown[]>;
};

/**
 * `PRAGMA integrity_check` returns a single row `{ integrity_check: "ok" }`
 * when the file is sound, otherwise one row per problem found.
 */
export async function checkDatabaseIntegrity(db: RawSqlExecutor): Promise<boolean> {
  const rows = (await db.execute("PRAGMA integrity_check")) as ReadonlyArray<{
    integrity_check: string;
  }>;
  return rows.length === 1 && rows[0]?.integrity_check === "ok";
}
