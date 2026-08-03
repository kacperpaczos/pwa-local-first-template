import { createContext, useContext, type ParentComponent, Show } from "solid-js";
import { createResource } from "solid-js";
import { PersistenceUnavailableError } from "@tanstack/db-sqlite-persistence-core";
import { openAppDatabase, type AppDatabase } from "./client";
import { createPersistenceFacade, type PersistenceFacade } from "./facade";
import { setSyncStatus } from "@/shared/sync/status";

type DbContextValue = {
  db: AppDatabase;
  facade: PersistenceFacade;
};

const DbContext = createContext<DbContextValue>();

export const DbProvider: ParentComponent = (props) => {
  const [resource] = createResource(async () => {
    const db = await openAppDatabase();
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
