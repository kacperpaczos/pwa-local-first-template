import { createCollection } from "@tanstack/db";
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { startOfflineExecutor } from "@tanstack/offline-transactions";
import type { Collection } from "@tanstack/db";
import type { OfflineExecutor } from "@tanstack/offline-transactions";
import type { Note } from "./schemas";
import { NoopSyncTransport } from "@/shared/sync/noop-transport";
import { SyncMutex, runSyncCycle } from "@/shared/sync/mutex";
import type { SyncMutation, SyncTransport } from "@/shared/sync/transport";

const DB_FILE = "pwa-local-first.sqlite";
const DB_NAME = "pwa-local-first";

export type AppDatabase = {
  notes: Collection<Note, string>;
  offline: OfflineExecutor;
  transport: SyncTransport;
  syncMutex: SyncMutex;
  close: () => Promise<void>;
};

function mutationsFromTransaction(
  idempotencyKey: string,
  mutations: ReadonlyArray<{
    type: string;
    modified?: unknown;
    original?: unknown;
  }>,
): SyncMutation[] {
  return mutations.map((mutation, index) => {
    const payload =
      mutation.type === "delete"
        ? mutation.original
        : (mutation.modified ?? mutation.original);

    return {
      idempotencyKey: `${idempotencyKey}:${index}`,
      entity: "notes" as const,
      op: mutation.type === "delete" ? ("soft_delete" as const) : ("upsert" as const),
      payload,
    };
  });
}

export async function openAppDatabase(): Promise<AppDatabase> {
  const database = await openBrowserWASQLiteOPFSDatabase({
    databaseName: DB_FILE,
  });

  const coordinator = new BrowserCollectionCoordinator({
    dbName: DB_NAME,
  });

  const persistence = createBrowserWASQLitePersistence({
    database,
    coordinator,
  });

  const notes = createCollection(
    persistedCollectionOptions<Note, string>({
      id: "notes",
      getKey: (note) => note.id,
      persistence,
      schemaVersion: 1,
    }),
  );

  const transport: SyncTransport = new NoopSyncTransport();
  const syncMutex = new SyncMutex();

  const offline = startOfflineExecutor({
    collections: { notes },
    mutationFns: {
      syncNotes: async ({ transaction, idempotencyKey }) => {
        // Persist optimistic mutations into SQLite (required for local-only / persisted collections).
        notes.utils.acceptMutations(transaction);
        await runSyncCycle(transport, syncMutex, {
          cursor: null,
          outbox: mutationsFromTransaction(idempotencyKey, transaction.mutations),
        });
      },
    },
  });

  return {
    notes,
    offline,
    transport,
    syncMutex,
    close: async () => {
      offline.dispose();
      coordinator.dispose();
      await database.close?.();
    },
  };
}
