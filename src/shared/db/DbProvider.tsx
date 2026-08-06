import { createContext, useContext, type ParentComponent, Show } from "solid-js";
import { createResource } from "solid-js";
import { PersistenceUnavailableError } from "@tanstack/db-sqlite-persistence-core";
import { openAppDatabase, type AppDatabase } from "./client";
import { createPersistenceFacade, type PersistenceFacade } from "./facade";
import { gcTombstones } from "@/shared/sync/gc";
import { makeTombstoneCoverage } from "@/shared/sync/coverage";
import { seedLamportFromNotes } from "./lamport";
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
    await db.oplogOps.preload();
    await db.oplogHeads.preload();

    // Seed the in-memory Lamport clock from whatever this device already
    // has on disk, before anything (GC gating, the first sync) reads or
    // hands out a new value — otherwise a fresh page load starts the clock
    // at 0 and could reissue a value this device already used in an
    // earlier session.
    seedLamportFromNotes(db.notes.toArray);

    // Subscriptions + genesis publish + first sync — needs preloaded
    // collections, which is why the engine doesn't start inside
    // openAppDatabase.
    void db.startSync().catch(() => {
      /* engine recomputes status itself */
    });

    // Fire-and-forget tombstone GC. A tombstone is only hard-deleted when
    // every device in the roster has acked the op that recorded it — the
    // retention window remains the backstop for devices that never return.
    void gcTombstones(db.notes, {
      isCovered: makeTombstoneCoverage(() => db.oplogOps.toArray, db.engine),
    }).catch(() => {
      /* GC is best-effort */
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
          {(error) => <RecoveryScreen db={error().db} />}
        </Show>
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
