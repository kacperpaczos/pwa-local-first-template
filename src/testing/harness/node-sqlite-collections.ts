import { DatabaseSync } from "node:sqlite";
import { createCollection, type Collection } from "@tanstack/db";
import {
  createSQLiteCorePersistenceAdapter,
  persistedCollectionOptions,
  type SQLiteDriver,
} from "@tanstack/db-sqlite-persistence-core";

/**
 * Real TanStack persisted collections, backed by an in-memory SQLite database
 * through Node's built-in `node:sqlite`.
 *
 * The production stack (`db/client.ts`) runs the same
 * `persistedCollectionOptions` + `SQLiteCorePersistenceAdapter` over wa-sqlite
 * in OPFS. Only the driver differs, so the collection semantics under test
 * here — notably that a write is confirmed asynchronously and a row is NOT
 * readable the instant `commit()` resolves — are the production semantics,
 * not an approximation.
 *
 * Requires Node ≥ 23.4 (`node:sqlite` unflagged); see `nodeSqliteAvailable`.
 */

/** False on Node versions where `node:sqlite` needs --experimental-sqlite. */
export const nodeSqliteAvailable = ((): boolean => {
  try {
    new DatabaseSync(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

function createNodeSqliteDriver(db: DatabaseSync): SQLiteDriver {
  const driver: SQLiteDriver = {
    exec: async (sql) => {
      db.exec(sql);
    },
    query: async <T>(sql: string, params: ReadonlyArray<unknown> = []) =>
      db.prepare(sql).all(...(params as never[])) as unknown as ReadonlyArray<T>,
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    // node:sqlite is synchronous, so a plain BEGIN/COMMIT pair is enough —
    // there is no concurrent statement to interleave.
    transaction: async (fn) => {
      db.exec("BEGIN");
      try {
        const out = await fn(driver);
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return driver;
}

export type NodeSqliteCollections = {
  collection: <T extends object, K extends string | number>(
    id: string,
    getKey: (row: T) => K,
  ) => Collection<T, K>;
  close: () => void;
};

export function createNodeSqliteCollections(schemaVersion = 3): NodeSqliteCollections {
  const db = new DatabaseSync(":memory:");
  const adapter = createSQLiteCorePersistenceAdapter({
    driver: createNodeSqliteDriver(db),
    schemaVersion,
  });

  return {
    collection: <T extends object, K extends string | number>(id: string, getKey: (row: T) => K) =>
      createCollection(
        persistedCollectionOptions<T, K>({
          id,
          getKey,
          persistence: { adapter },
          schemaVersion,
        }),
      ),
    close: () => db.close(),
  };
}
