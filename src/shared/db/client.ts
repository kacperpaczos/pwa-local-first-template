import { createCollection } from "@tanstack/db";
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import type { Collection } from "@tanstack/db";
import { COUNTER_ID, emptyCounter, type Counter } from "./schemas";
import { ensureDeviceKey } from "@/shared/identity/device";
import type { HeadRow, StoredOp } from "@/shared/store/oplog-persistence";
import {
  CollectionOpLogPersistence,
  persistLocal,
} from "@/shared/store/collection-oplog-persistence";
import { OpLogStore } from "@/shared/store/oplog-store";
import { materializeCounterOps, type MaterializeTarget } from "@/shared/store/materialize";
import { SyncEngine } from "@/shared/sync/engine";
import { GunLogTransport, parseGunPeers } from "@/shared/sync/gun-log-transport";
import { NoopLogTransport } from "@/shared/sync/noop-transport";
import type { LogSyncTransport } from "@/shared/sync/transport";

const DB_FILE = "pwa-local-first.sqlite";
const DB_NAME = "pwa-local-first";

/**
 * Bumped for the counter domain reset (ADR-012): the notes-era tables are
 * not read. All collections MUST share one schemaVersion: the persistence
 * plugin caches one adapter per (mode, schemaVersion) and re-registers it
 * with the coordinator on every collection setup; mixed versions clobber
 * each other.
 */
const SCHEMA_VERSION = 4;

export const SYNC_ENTITY = "counter";

export type AppDatabase = {
  counter: Collection<Counter, string>;
  oplogOps: Collection<StoredOp, string>;
  oplogHeads: Collection<HeadRow, string>;
  store: OpLogStore;
  engine: SyncEngine;
  entity: string;
  /** Fold pending local ops into the state row (facade calls this after append). */
  materializeLocal: () => Promise<Counter>;
  /** Preload collections + hydrate the op-log index, without starting sync. */
  prepareLocalOnly: () => Promise<void>;
  /** Start subscriptions + first sync. */
  startSync: () => Promise<void>;
  pullRemote: () => Promise<void>;
  /** Rebuild the transport (post identity/pairing import). */
  reinitSyncTransport: () => Promise<void>;
  close: () => Promise<void>;
};

export function createLogTransport(): LogSyncTransport {
  const peers = parseGunPeers(import.meta.env.VITE_GUN_PEERS as string | undefined);
  const fallbackPeers =
    peers.length === 0 && import.meta.env.DEV ? ["http://127.0.0.1:8765/gun"] : peers;

  if (fallbackPeers.length === 0) {
    return new NoopLogTransport();
  }
  return new GunLogTransport({ peers: fallbackPeers });
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

  const counter = createCollection(
    persistedCollectionOptions<Counter, string>({
      id: "counter",
      getKey: (row) => row.id,
      persistence,
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  const oplogOps = createCollection(
    persistedCollectionOptions<StoredOp, string>({
      id: "oplog_ops",
      getKey: (row) => row.hash,
      persistence,
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  const oplogHeads = createCollection(
    persistedCollectionOptions<HeadRow, string>({
      id: "oplog_heads",
      getKey: (row) => row.id,
      persistence,
      schemaVersion: SCHEMA_VERSION,
    }),
  );

  const device = ensureDeviceKey();
  const store = new OpLogStore({
    persistence: new CollectionOpLogPersistence(oplogOps, oplogHeads),
    device,
  });

  const target: MaterializeTarget = {
    getCounter: () => counter.get(COUNTER_ID),
    upsertCounter: async (row) => {
      await persistLocal(counter, () => {
        if (counter.get(row.id)) {
          counter.update(row.id, (draft) => Object.assign(draft, row));
        } else {
          counter.insert(row);
        }
      });
    },
  };

  const engine = new SyncEngine({
    store,
    transport: createLogTransport,
    target,
    entity: SYNC_ENTITY,
  });

  /**
   * Load every collection into memory and populate the op-log read index,
   * WITHOUT starting sync. Idempotent.
   */
  const prepareLocalOnly = async () => {
    await counter.preload();
    await oplogOps.preload();
    await oplogHeads.preload();
    store.hydrate([SYNC_ENTITY]);
  };

  const startSync = async () => {
    // Read index must be populated before anything reads head/unpublished/
    // unapplied state. Normally already done by the caller (DbProvider);
    // repeated here so startSync is safe to call on its own.
    await prepareLocalOnly();
    // Fold anything the last session appended but never materialized (a
    // crash between append and fold), then run the first cycle.
    await materializeCounterOps(store, target);
    await engine.syncNow().catch(() => undefined);
  };

  const onOnline = () => {
    void engine.syncNow().catch(() => undefined);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }

  return {
    counter,
    oplogOps,
    oplogHeads,
    store,
    engine,
    entity: SYNC_ENTITY,
    materializeLocal: async () => {
      await materializeCounterOps(store, target);
      return counter.get(COUNTER_ID) ?? emptyCounter();
    },
    prepareLocalOnly,
    startSync,
    pullRemote: () => engine.syncNow(),
    reinitSyncTransport: () => engine.restart(),
    close: async () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
      await engine.close();
      coordinator.dispose();
      await database.close?.();
    },
  };
}
