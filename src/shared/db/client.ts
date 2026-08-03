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
import type { SyncMeta } from "./sync-meta";
import { SyncMutex, runSyncCycle } from "@/shared/sync/mutex";
import type { SyncMutation, SyncTransport } from "@/shared/sync/transport";
import { createSyncTransport } from "@/shared/sync/ws-transport";
import {
  applyRemoteMutations,
  readRelayCursor,
  withSyncStatus,
  writeRelayCursor,
} from "@/shared/sync/apply-remote";
import { setSyncStatus } from "@/shared/sync/status";

const DB_FILE = "pwa-local-first.sqlite";
const DB_NAME = "pwa-local-first";

export type AppDatabase = {
  notes: Collection<Note, string>;
  syncMeta: Collection<SyncMeta, string>;
  offline: OfflineExecutor;
  transport: SyncTransport;
  syncMutex: SyncMutex;
  /** Raw wa-sqlite handle — integrity checks (Etap 4.0) and future .sqlite export. */
  rawDb: { execute: <TRow = unknown>(sql: string, params?: readonly unknown[]) => Promise<readonly TRow[]> };
  pullRemote: () => Promise<void>;
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
      schemaVersion: 2,
    }),
  );

  const syncMeta = createCollection(
    persistedCollectionOptions<SyncMeta, string>({
      id: "sync_meta",
      getKey: (row) => row.id,
      persistence,
      // Must match `notes`' schemaVersion: @tanstack/browser-db-sqlite-persistence
      // caches one adapter per (mode, schemaVersion) and re-registers it with the
      // BrowserCollectionCoordinator on every collection setup. Collections sharing
      // a coordinator with *different* schemaVersion values clobber each other's
      // active adapter, breaking the other collection's schema-mismatch check.
      schemaVersion: 2,
    }),
  );

  const transport = createSyncTransport();
  const syncMutex = new SyncMutex();

  const pullRemote = async () => {
    await withSyncStatus(async () => {
      await syncMutex.runExclusive(async () => {
        const cursor = readRelayCursor(syncMeta);
        const pull = await transport.pull(cursor);
        await applyRemoteMutations({ notes, syncMeta }, pull.mutations);
        if (pull.cursor !== cursor) {
          await writeRelayCursor(syncMeta, pull.cursor);
        }
      });
    });
  };

  const offline = startOfflineExecutor({
    collections: { notes, syncMeta },
    mutationFns: {
      syncNotes: async ({ transaction, idempotencyKey }) => {
        notes.utils.acceptMutations(transaction);

        await withSyncStatus(async () => {
          try {
            const cursor = readRelayCursor(syncMeta);
            const { pull } = await runSyncCycle(transport, syncMutex, {
              cursor,
              outbox: mutationsFromTransaction(idempotencyKey, transaction.mutations),
            });
            await applyRemoteMutations({ notes, syncMeta }, pull.mutations);
            if (pull.cursor !== cursor) {
              await writeRelayCursor(syncMeta, pull.cursor);
            }
          } catch (error) {
            setSyncStatus(
              typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "idle",
            );
            throw error;
          }
        });
      },
    },
  });

  const onOnline = () => {
    void pullRemote().catch(() => {
      /* outbox retries separately */
    });
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }

  return {
    notes,
    syncMeta,
    offline,
    transport,
    syncMutex,
    rawDb: database,
    pullRemote,
    close: async () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
      offline.dispose();
      if ("close" in transport && typeof transport.close === "function") {
        await transport.close();
      }
      coordinator.dispose();
      await database.close?.();
    },
  };
}
