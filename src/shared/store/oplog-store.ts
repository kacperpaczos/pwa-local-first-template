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
 */
export class OpLogStore {
  private readonly persistence: OpLogPersistence;
  private readonly device: DeviceKey;
  private readonly counter: HeadCounter | null;
  private readonly lock: ExclusiveLock;
  private readonly now: () => number;

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

  /** Sign and durably append a payload to this device's log for `entity`. */
  append(entity: string, payload: unknown): Promise<Operation> {
    return this.lock(async () => {
      const persisted = this.persistence.getHead(entity, this.device.deviceId);
      const counted = this.counter?.get(entity) ?? 0;
      const height = Math.max(persisted?.seq ?? 0, counted);
      const backlink =
        height === 0
          ? null
          : ((persisted?.seq === height
              ? persisted.hash
              : this.persistence.getOpAt(entity, this.device.deviceId, height)?.hash) ?? null);
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

      await this.persistence.putOp({
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
      });
      await this.putHead(entity, this.device.deviceId, { seq: op.header.seq, hash: op.hash });
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
      return this.persistence.getOp(op.hash) ? "duplicate" : "invalid";
    }
    if (!verifyOperation(op, payloadBytes)) {
      return "invalid";
    }

    const entity = op.header.entity;
    const device = op.header.publicKey;
    const head = this.persistence.getHead(entity, device);
    const verdict = validateAgainstHead(
      op,
      head ? { seq: head.seq, hash: head.hash } : null,
      (seq) => this.persistence.getOpAt(entity, device, seq)?.hash,
    );
    if (verdict !== "ok") {
      return verdict;
    }

    await this.persistence.putOp({
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
    });
    await this.putHead(entity, device, { seq: op.header.seq, hash: op.hash });
    return "stored";
  }

  head(entity: string, device: string): LogHead | null {
    const row = this.persistence.getHead(entity, device);
    return row ? { seq: row.seq, hash: row.hash } : null;
  }

  heads(entity: string): HeadRow[] {
    return this.persistence.listHeads(entity);
  }

  opsSince(entity: string, device: string, fromSeq: number): StoredOp[] {
    return this.persistence.listOps({ entity, device, fromSeq });
  }

  unpublished(entity: string): StoredOp[] {
    return this.persistence.listOps({ entity, published: false, quarantined: false });
  }

  unapplied(entity: string): StoredOp[] {
    return this.persistence.listOps({ entity, applied: false, quarantined: false });
  }

  quarantined(entity: string): StoredOp[] {
    return this.persistence.listOps({ entity, quarantined: true });
  }

  async markPublished(hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) {
      await this.persistence.patchOp(hash, { published: true });
    }
  }

  async markApplied(hashes: readonly string[]): Promise<void> {
    for (const hash of hashes) {
      await this.persistence.patchOp(hash, { applied: true });
    }
  }

  async quarantine(hash: string, reason: string): Promise<void> {
    await this.persistence.patchOp(hash, {
      quarantined: true,
      quarantineReason: reason,
      applied: false,
    });
  }

  private async putHead(entity: string, device: string, head: LogHead): Promise<void> {
    const row: HeadRow = {
      id: headRowId(entity, device),
      entity,
      device,
      seq: head.seq,
      hash: head.hash,
    };
    await this.persistence.putHead(row);
  }
}
