import { createContext, useContext, type ParentComponent, Show } from "solid-js";
import { createResource } from "solid-js";
import { PersistenceUnavailableError } from "@tanstack/db-sqlite-persistence-core";
import { openAppDatabase, type AppDatabase } from "./client";
import { createPersistenceFacade, type PersistenceFacade } from "./facade";
import { seedLamportFromState } from "./lamport";
import { exposeIdentityE2eHooks } from "@/shared/identity";

type DbContextValue = {
  db: AppDatabase;
  facade: PersistenceFacade;
};

export const DbContext = createContext<DbContextValue>();

export const DbProvider: ParentComponent = (props) => {
  const [resource] = createResource(async () => {
    const db = await openAppDatabase();

    await db.prepareLocalOnly();

    // Seed the in-memory Lamport clock from whatever this device already
    // has on disk, before anything reads or hands out a new value —
    // otherwise a fresh page load starts the clock at 0 and could reissue
    // a value this device already used in an earlier session.
    seedLamportFromState(db.counter.toArray);

    // Subscriptions + first sync — needs preloaded collections, which is
    // why the engine doesn't start inside openAppDatabase.
    void db.startSync().catch(() => {
      /* engine recomputes status itself */
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
        <main class="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-2 p-6 text-center">
          <h1 class="text-2xl font-semibold tracking-tight">Persistence unavailable</h1>
          <p class="text-sm text-muted-foreground">
            {resource.error instanceof PersistenceUnavailableError
              ? "This browser does not expose OPFS (required for local SQLite)."
              : String(resource.error)}
          </p>
        </main>
      }
    >
      <Show
        when={resource()}
        fallback={
          <main class="flex min-h-dvh items-center justify-center p-6 text-sm text-muted-foreground">
            Loading database…
          </main>
        }
      >
        {(value) => <DbContext.Provider value={value()}>{props.children}</DbContext.Provider>}
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
