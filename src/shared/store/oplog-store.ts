import type { DeviceKey } from "@/shared/identity/device";
import { createOperation, verifyOperation, type Operation } from "@/shared/oplog/header";
import { validateAgainstHead, type LogHead } from "@/shared/oplog/log";
import { encodeOpPayload } from "@/shared/oplog/payload";
import { headRowId, type HeadRow, type OpLogPersistence, type StoredOp } from "./oplog-persistence";

const APPEND_LOCK = "pwa-oplog-writer";

export type IngestResult = "stored" | "duplicate" | "gap" | "fork" | "invalid";

/**
 * Cross-tab monotone counter for the device's own log height. localStorage
 * writes are synchronous and immediately visible to sibling tabs, which the
 * async collection replication is not — under the append Web Lock this gives
 * read-your-predecessor's-write for seq derivation. Reconciled with the
 * persisted head via max() on every append, so a cleared counter recovers
 * from the persisted log. (Clearing localStorage also clears the device key,
 * which mints a whole new log — the two can't go stale independently.)
 */
export type HeadCounter = {
  get(entity: string): number;
  set(entity: string, seq: number): void;
};

export function localStorageHeadCounter(
  deviceId: string,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): HeadCounter {
  const key = (entity: string) => `pwa-oplog-head:${entity}:${deviceId}`;
  return {
    get(entity) {
      const raw = storage.getItem(key(entity));
      const n = raw === null ? 0 : Number(raw);
      return Number.isInteger(n) && n > 0 ? n : 0;
    },
    set(entity, seq) {
      storage.setItem(key(entity), String(seq));
    },
  };
}

export function memoryHeadCounter(): HeadCounter {
  const map = new Map<string, number>();
  return {
    get: (entity) => map.get(entity) ?? 0,
    set: (entity, seq) => void map.set(entity, seq),
  };
}

type ExclusiveLock = <T>(fn: () => Promise<T>) => Promise<T>;

/** navigator.locks when available (waits, unlike ifAvailable); else a local promise chain. */
function makeAppendLock(): ExclusiveLock {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) {
    return <T>(fn: () => Promise<T>) =>
      locks.request(APPEND_LOCK, { mode: "exclusive" }, () => fn()) as Promise<T>;
  }
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export type OpLogStoreOptions = {
  persistence: OpLogPersistence;
  device: DeviceKey;
  headCounter?: HeadCounter;
  /** Injected for tests. */
  lock?: ExclusiveLock;
  now?: () => number;
};

/**
 * Append-only per-device operation logs over a storage port.
 *
 * Structural fixes over the retired seq/cursor scheme:
 * - `append` derives seq from PERSISTED state inside an exclusive Web Lock —
 *   a reload or a second tab can never restart the numbering (old bugs 1+2).
 * - `ingest` quarantines undecodable/forked ops instead of throwing, so one
 *   poison op can never wedge the pipeline (old bug 3).
 * - The `published` flag makes the log itself the durable outbox.
 *
 * Reads (`head`/`heads`/`unpublished`/`unapplied`/`quarantined`/`opsSince`)
 * are served from an in-memory index the store owns, NOT by re-querying
 * `persistence` on every call. `persistedCollectionOptions` collections
 * confirm a write asynchronously (a round trip through the storage
 * coordinator) — reading `collection.toArray` immediately after `await
 * tx.commit()` resolves can observe the row as momentarily ABSENT before it
 * reappears a tick later. Deriving `unpublished()` from that live query right
 * after `append()` would intermittently miss the op just written. The index
 * is the single source of truth for reads; `persistence` is durability +
 * (via `hydrate`) the source for restoring the index across reloads.
 */
export class OpLogStore {
  private readonly persistence: OpLogPersistence;
  private readonly device: DeviceKey;
  private readonly counter: HeadCounter | null;
  private readonly lock: ExclusiveLock;
  private readonly now: () => number;

  private readonly opsByHash = new Map<string, StoredOp>();
  private readonly headsByKey = new Map<string, HeadRow>();

  constructor(options: OpLogStoreOptions) {
    this.persistence = options.persistence;
    this.device = options.device;
    this.counter =
      options.headCounter ??
      (typeof localStorage !== "undefined"
        ? localStorageHeadCounter(options.device.deviceId)
        : null);
    this.lock = options.lock ?? makeAppendLock();
    this.now = options.now ?? (() => Date.now());
  }

  get deviceId(): string {
    return this.device.deviceId;
  }

  /**
   * Populate the in-memory index from `persistence`. Call once, after the
   * underlying collections have finished preloading — MemoryOpLogPersistence
   * (tests) is synchronous from construction, so this is a no-op there, but
   * a real app boot must call it explicitly (see `client.ts#startSync`).
   */
  hydrate(entities: readonly string[]): void {
    for (const entity of entities) {
      for (const op of this.persistence.listOps({ entity })) {
        this.opsByHash.set(op.hash, op);
      }
      for (const head of this.persistence.listHeads(entity)) {
        this.headsByKey.set(head.id, head);
      }
    }
  }

  /** Sign and durably append a payload to this device's log for `entity`. */
  append(entity: string, payload: unknown): Promise<Operation> {
    return this.lock(async () => {
      const head = this.headIndexed(entity, this.device.deviceId);
      const counted = this.counter?.get(entity) ?? 0;
      const height = Math.max(head?.seq ?? 0, counted);
      const backlink = height === 0 ? null : ((head?.seq === height ? head.hash : null) ?? null);
      if (height > 0 && backlink === null) {
        throw new Error(`Op log for "${entity}" is at height ${height} but the head op is missing`);
      }

      const payloadBytes = encodeOpPayload(payload);
      const op = createOperation({
        entity,
        seq: height + 1,
        backlink,
        payloadBytes,
        publicKey: this.device.publicKey,
        secretKey: this.device.secretKey,
        timestamp: this.now(),
      });

      const row: StoredOp = {
        hash: op.hash,
        entity,
        device: this.device.deviceId,
        seq: op.header.seq,
        backlink: op.header.backlink,
        timestamp: op.header.timestamp,
        signature: op.signature,
        payloadJson: JSON.stringify(payload),
        // Local writes are already folded into the entity table by the
        // facade's own transaction — the materializer must not re-apply them.
        applied: true,
        published: false,
        quarantined: false,
        quarantineReason: null,
      };
      await this.persistence.putOp(row);
      this.opsByHash.set(row.hash, row);
      await this.setHead(entity, this.device.deviceId, { seq: op.header.seq, hash: op.hash });
      this.counter?.set(entity, op.header.seq);
      return op;
    });
  }

  /**
   * Ingest a remote op. Chain-valid ops advance the head even when their
   * payload later fails to decode/materialize (that is per-op quarantine,
   * see materialize.ts); ops failing structural verification or forking the
   * chain are quarantined WITHOUT advancing the head.
   */
  async ingest(op: Operation, payloadBytes: Uint8Array): Promise<IngestResult> {
    if (op.header.publicKey === this.device.deviceId) {
      // Own ops re-delivered by the mesh are never re-ingested.
      return this.opsByHash.has(op.hash) ? "duplicate" : "invalid";
    }
    if (!verifyOperation(op, payloadBytes)) {
      return "invalid";
    }

    const entity = op.header.entity;
    const device = op.header.publicKey;
    const head = this.headIndexed(entity, device);
    const verdict = validateAgainstHead(
      op,
      head ? { seq: head.seq, hash: head.hash } : null,
      (seq) => this.opAtIndexed(entity, device, seq)?.hash,
    );
    if (verdict !== "ok") {
      return verdict;
    }

    const row: StoredOp = {
      hash: op.hash,
      entity,
      device,
      seq: op.header.seq,
      backlink: op.header.backlink,
      timestamp: op.header.timestamp,
      signature: op.signature,
      payloadJson: new TextDecoder().decode(payloadBytes),
      applied: false,
      published: true,
      quarantined: false,
      quarantineReason: null,
    };
    await this.persistence.putOp(row);
    this.opsByHash.set(row.hash, row);
    await this.setHead(entity, device, { seq: op.header.seq, hash: op.hash });
    return "stored";
  }

  head(entity: string, device: string): LogHead | null {
    const row = this.headIndexed(entity, device);
    return row ? { seq: row.seq, hash: row.hash } : null;
  }

  heads(entity: string): HeadRow[] {
    return [...this.headsByKey.values()].filter((h) => h.entity === entity);
  }

  opsSince(entity: string, device: string, fromSeq: number): StoredOp[] {
    return this.query({ entity, device, fromSeq });
  }

  unpublished(entity: string): StoredOp[] {
    return this.query({ entity, published: false, quarantined: false });
  }

  unapplied(entity: string): StoredOp[] {
    return this.query({ entity, applied: false, quarantined: false });
  }

  quarantined(entity: string): StoredOp[] {
    return this.query({ entity, quarantined: true });
  }

  async markPublished(hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) {
      await this.persistence.patchOp(hash, { published: true });
      this.patchIndexed(hash, { published: true });
    }
  }

  async markApplied(hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) {
      await this.persistence.patchOp(hash, { applied: true });
      this.patchIndexed(hash, { applied: true });
    }
  }

  async quarantine(hash: string, reason: string): Promise<void> {
    const patch = { quarantined: true, quarantineReason: reason, applied: false } as const;
    await this.persistence.patchOp(hash, patch);
    this.patchIndexed(hash, patch);
  }

  private headIndexed(entity: string, device: string): HeadRow | undefined {
    return this.headsByKey.get(headRowId(entity, device));
  }

  private opAtIndexed(entity: string, device: string, seq: number): StoredOp | undefined {
    for (const op of this.opsByHash.values()) {
      if (op.entity === entity && op.device === device && op.seq === seq) return op;
    }
    return undefined;
  }

  private query(filter: {
    entity: string;
    device?: string;
    fromSeq?: number;
    applied?: boolean;
    published?: boolean;
    quarantined?: boolean;
  }): StoredOp[] {
    const out: StoredOp[] = [];
    for (const op of this.opsByHash.values()) {
      if (op.entity !== filter.entity) continue;
      if (filter.device !== undefined && op.device !== filter.device) continue;
      if (filter.fromSeq !== undefined && op.seq < filter.fromSeq) continue;
      if (filter.applied !== undefined && op.applied !== filter.applied) continue;
      if (filter.published !== undefined && op.published !== filter.published) continue;
      if (filter.quarantined !== undefined && op.quarantined !== filter.quarantined) continue;
      out.push(op);
    }
    return out.sort((a, b) =>
      a.device === b.device ? a.seq - b.seq : a.device < b.device ? -1 : 1,
    );
  }

  private patchIndexed(
    hash: string,
    patch: Partial<Pick<StoredOp, "applied" | "published" | "quarantined" | "quarantineReason">>,
  ): void {
    const existing = this.opsByHash.get(hash);
    if (existing) this.opsByHash.set(hash, { ...existing, ...patch });
  }

  private async setHead(entity: string, device: string, head: LogHead): Promise<void> {
    const row: HeadRow = {
      id: headRowId(entity, device),
      entity,
      device,
      seq: head.seq,
      hash: head.hash,
    };
    await this.persistence.putHead(row);
    this.headsByKey.set(row.id, row);
  }
}
