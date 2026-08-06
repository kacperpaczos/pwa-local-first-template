import { createCollection, createTransaction } from "@tanstack/db";
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from "@tanstack/browser-db-sqlite-persistence";
import { startOfflineExecutor } from "@tanstack/offline-transactions";
import type { Collection } from "@tanstack/db";
import type { OfflineExecutor } from "@tanstack/offline-transactions";
import { parseNote, type Note } from "./schemas";
import { ensureDeviceKey } from "@/shared/identity/device";
import type { NoteOpPayload } from "@/shared/oplog/payload";
import {
  headRowId,
  type HeadRow,
  type OpLogPersistence,
  type StoredOp,
} from "@/shared/store/oplog-persistence";
import { OpLogStore } from "@/shared/store/oplog-store";
import type { MaterializeTarget } from "@/shared/store/materialize";
import { SyncEngine } from "@/shared/sync/engine";
import { GunLogTransport, parseGunPeers } from "@/shared/sync/gun-log-transport";
import { NoopLogTransport } from "@/shared/sync/noop-transport";
import type { LogSyncTransport } from "@/shared/sync/transport";

const DB_FILE = "pwa-local-first.sqlite";
const DB_NAME = "pwa-local-first";

/**
 * Bumped for the op-log clean break (v2 rows are ignored; on first v3 boot
 * existing local notes are re-published as genesis ops — see startSync).
 * All collections MUST share one schemaVersion: the persistence plugin
 * caches one adapter per (mode, schemaVersion) and re-registers it with the
 * coordinator on every collection setup; mixed versions clobber each other.
 */
const SCHEMA_VERSION = 3;

export const SYNC_ENTITY = "notes";

export type AppDatabase = {
  notes: Collection<Note, string>;
  oplogOps: Collection<StoredOp, string>;
  oplogHeads: Collection<HeadRow, string>;
  offline: OfflineExecutor;
  store: OpLogStore;
  engine: SyncEngine;
  /** Raw wa-sqlite handle — integrity checks and SQL dump export. */
  rawDb: {
    execute: <TRow = unknown>(sql: string, params?: readonly unknown[]) => Promise<readonly TRow[]>;
  };
  /** Start subscriptions + first sync. Call AFTER collections are preloaded. */
  startSync: () => Promise<void>;
  pullRemote: () => Promise<void>;
  /** Rebuild the transport (post identity/pairing import). */
  reinitSyncTransport: () => Promise<void>;
  close: () => Promise<void>;
};

/** Local-only write helper — commits via acceptMutations, no outbox involved. */
async function persistLocal<T extends object, K extends string | number>(
  collection: Collection<T, K>,
  mutate: () => void,
): Promise<void> {
  const tx = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction }) => {
      collection.utils.acceptMutations(transaction);
    },
  });
  tx.mutate(mutate);
  await tx.commit();
}

/** OpLogPersistence over TanStack persisted collections (p2panda-store shape). */
export class CollectionOpLogPersistence implements OpLogPersistence {
  constructor(
    private readonly ops: Collection<StoredOp, string>,
    private readonly heads: Collection<HeadRow, string>,
  ) {}

  getOp(hash: string): StoredOp | undefined {
    return this.ops.get(hash);
  }

  getOpAt(entity: string, device: string, seq: number): StoredOp | undefined {
    return this.ops.toArray.find(
      (op) => op.entity === entity && op.device === device && op.seq === seq,
    );
  }

  listOps(filter: Parameters<OpLogPersistence["listOps"]>[0]): StoredOp[] {
    return this.ops.toArray
      .filter((op) => {
        if (op.entity !== filter.entity) return false;
        if (filter.device !== undefined && op.device !== filter.device) return false;
        if (filter.fromSeq !== undefined && op.seq < filter.fromSeq) return false;
        if (filter.applied !== undefined && op.applied !== filter.applied) return false;
        if (filter.published !== undefined && op.published !== filter.published) return false;
        if (filter.quarantined !== undefined && op.quarantined !== filter.quarantined) {
          return false;
        }
        return true;
      })
      .sort((a, b) => (a.device === b.device ? a.seq - b.seq : a.device < b.device ? -1 : 1));
  }

  async putOp(row: StoredOp): Promise<void> {
    await persistLocal(this.ops, () => {
      if (this.ops.get(row.hash)) {
        this.ops.update(row.hash, (draft) => Object.assign(draft, row));
      } else {
        this.ops.insert(row);
      }
    });
  }

  async patchOp(
    hash: string,
    patch: Partial<Pick<StoredOp, "applied" | "published" | "quarantined" | "quarantineReason">>,
  ): Promise<void> {
    if (!this.ops.get(hash)) return;
    await persistLocal(this.ops, () => {
      this.ops.update(hash, (draft) => Object.assign(draft, patch));
    });
  }

  getHead(entity: string, device: string): HeadRow | undefined {
    return this.heads.get(headRowId(entity, device));
  }

  async putHead(row: HeadRow): Promise<void> {
    await persistLocal(this.heads, () => {
      if (this.heads.get(row.id)) {
        this.heads.update(row.id, (draft) => Object.assign(draft, row));
      } else {
        this.heads.insert(row);
      }
    });
  }

  listHeads(entity?: string): HeadRow[] {
    return this.heads.toArray.filter((h) => entity === undefined || h.entity === entity);
  }
}

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

  const notes = createCollection(
    persistedCollectionOptions<Note, string>({
      id: "notes",
      getKey: (note) => note.id,
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
    getNote: (id) => notes.get(id),
    upsertNote: async (note) => {
      await persistLocal(notes, () => {
        if (notes.get(note.id)) {
          notes.update(note.id, (draft) => Object.assign(draft, note));
        } else {
          notes.insert(note);
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

  const offline = startOfflineExecutor({
    collections: { notes },
    mutationFns: {
      syncNotes: async ({ transaction }) => {
        notes.utils.acceptMutations(transaction);

        // Durably append each mutated row to this device's log first — the
        // log IS the outbox (published flag), so the write survives a crash
        // between append and publish. Then PUBLISH (await, not fire-and-
        // forget): a push failure (offline, locked space) throws here and
        // the offline-transactions executor retries the whole mutation
        // later, exactly like the old push-then-pull cycle did. Pulling
        // remote state stays a background concern — a slow/failed pull must
        // never block or fail a local write.
        for (const mutation of transaction.mutations) {
          const raw = mutation.modified ?? mutation.original;
          const note = parseNote(raw);
          const payload: NoteOpPayload = { kind: "upsert", note };
          await store.append(SYNC_ENTITY, payload);
        }
        await engine.flush();

        void engine.syncNow().catch(() => undefined);
      },
    },
  });

  const startSync = async () => {
    // Populate the store's in-memory read index from whatever this device
    // already has on disk. Must run before anything reads head/unpublished/
    // unapplied state — the collections are preloaded by the caller
    // (DbProvider) before startSync() runs.
    store.hydrate([SYNC_ENTITY]);

    // v2→v3 upgrade / fresh-db genesis: local notes exist but this device's
    // log is empty and no other device's log is known — republish local
    // state as genesis upserts (convergent via LWW/Loro on every peer).
    const ownHead = store.head(SYNC_ENTITY, device.deviceId);
    if (!ownHead && store.heads(SYNC_ENTITY).length === 0 && notes.toArray.length > 0) {
      for (const note of notes.toArray) {
        await store.append(SYNC_ENTITY, { kind: "upsert", note } satisfies NoteOpPayload);
      }
    }
    await engine.syncNow().catch(() => undefined);
  };

  const onOnline = () => {
    void engine.syncNow().catch(() => undefined);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }

  return {
    notes,
    oplogOps,
    oplogHeads,
    offline,
    store,
    engine,
    rawDb: database,
    startSync,
    pullRemote: () => engine.syncNow(),
    reinitSyncTransport: () => engine.restart(),
    close: async () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
      offline.dispose();
      await engine.close();
      coordinator.dispose();
      await database.close?.();
    },
  };
}
