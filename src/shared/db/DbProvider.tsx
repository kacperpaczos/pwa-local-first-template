import { createContext, useContext, type ParentComponent, Show } from "solid-js";
import { createResource } from "solid-js";
import { PersistenceUnavailableError } from "@tanstack/db-sqlite-persistence-core";
import { openAppDatabase, type AppDatabase } from "./client";
import { createPersistenceFacade, type PersistenceFacade } from "./facade";
import { setSyncStatus } from "@/shared/sync/status";
import { checkDatabaseIntegrity } from "@/backup/integrity";
import { dbIntegrityStore } from "@/backup/status";
import { exposeIdentityE2eHooks } from "@/shared/identity";
import RecoveryScreen from "@/features/settings/RecoveryScreen";

type DbContextValue = {
  db: AppDatabase;
  facade: PersistenceFacade;
};

const DbContext = createContext<DbContextValue>();

export class DbCorruptError extends Error {
  constructor(public readonly db: AppDatabase) {
    super("SQLite integrity check failed");
    this.name = "DbCorruptError";
  }
}

export const DbProvider: ParentComponent = (props) => {
  const [resource] = createResource(async () => {
    const db = await openAppDatabase();

    // Runs before anything else touches storage: the persistence layer's own
    // driver serializes all further OPFS access through its internal queue,
    // and a raw PRAGMA issued concurrently with that queue can deadlock the
    // OPFS sync access handle instead of just erroring.
    const intact = await checkDatabaseIntegrity(db.rawDb);
    dbIntegrityStore.set(intact ? "ok" : "corrupt");
    if (!intact) {
      throw new DbCorruptError(db);
    }

    await db.offline.waitForInit();
    await db.notes.preload();
    await db.syncMeta.preload();

    void db.pullRemote().catch(() => {
      setSyncStatus(
        typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "idle",
      );
    });
    const facade = createPersistenceFacade(db);
    // Expose for DEV tooling and Playwright e2e (VITE_E2E=1 in the e2e build).
    if (import.meta.env.DEV || import.meta.env.VITE_E2E === "1") {
      (globalThis as unknown as { __db?: unknown }).__db = { db, facade };
      exposeIdentityE2eHooks();
    }
    return {
      db,
      facade,
    } satisfies DbContextValue;
  });

  return (
    <Show
      when={!resource.error}
      fallback={
        <Show
          when={resource.error instanceof DbCorruptError ? resource.error : undefined}
          fallback={
            <main style={{ padding: "2rem", "text-align": "center" }}>
              <h1>Persystencja niedostępna</h1>
              <p>
                {resource.error instanceof PersistenceUnavailableError
                  ? "Ta przeglądarka nie udostępnia OPFS (wymagane do lokalnego SQLite)."
                  : String(resource.error)}
              </p>
            </main>
          }
        >
          {(error) => <RecoveryScreen db={error().db} />}
        </Show>
      }
    >
      <Show when={resource()} fallback={<main style={{ padding: "2rem" }}>Ładowanie bazy…</main>}>
        {(value) => (
          <DbContext.Provider value={value()}>{props.children}</DbContext.Provider>
        )}
      </Show>
    </Show>
  );
};

export function useDb(): DbContextValue {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error("useDb must be used within DbProvider");
  }
  return ctx;
}
