import { createContext, useContext, type ParentComponent, Show } from "solid-js";
import { createResource } from "solid-js";
import { PersistenceUnavailableError } from "@tanstack/db-sqlite-persistence-core";
import { openAppDatabase, type AppDatabase } from "./client";
import { createPersistenceFacade, type PersistenceFacade } from "./facade";

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
    const facade = createPersistenceFacade(db);
    if (import.meta.env.DEV) {
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
