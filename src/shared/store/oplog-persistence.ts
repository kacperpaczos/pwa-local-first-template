import type { LogHead } from "@/shared/oplog/log";

/**
 * Persisted op row. `payloadJson` is the plaintext payload exactly as
 * appended/received (at-rest model matches today's OPFS rows: local DB is
 * trusted, encryption happens at the transport envelope).
 */
export type StoredOp = {
  /** Op hash — primary key. */
  hash: string;
  entity: string;
  /** Authoring device id (base64url ed25519 public key). */
  device: string;
  seq: number;
  backlink: string | null;
  timestamp: number;
  signature: string;
  payloadJson: string;
  /** Materializer has folded this op into the entity table. */
  applied: boolean;
  /** Transport has durably published this op (log doubles as the outbox). */
  published: boolean;
  quarantined: boolean;
  quarantineReason: string | null;
};

export type HeadRow = LogHead & {
  /** `${entity}:${device}` — primary key. */
  id: string;
  entity: string;
  device: string;
};

export function headRowId(entity: string, device: string): string {
  return `${entity}:${device}`;
}

/**
 * Storage port for the op log — deliberately trait-shaped so the v0.2 swap
 * targets `p2panda-store`'s OperationStore/LogStore. Implemented over
 * TanStack persisted collections in app code and over Maps in tests.
 */
export interface OpLogPersistence {
  getOp(hash: string): StoredOp | undefined;
  getOpAt(entity: string, device: string, seq: number): StoredOp | undefined;
  listOps(filter: {
    entity: string;
    device?: string;
    fromSeq?: number;
    applied?: boolean;
    published?: boolean;
    quarantined?: boolean;
  }): StoredOp[];
  putOp(row: StoredOp): Promise<void>;
  patchOp(
    hash: string,
    patch: Partial<Pick<StoredOp, "applied" | "published" | "quarantined" | "quarantineReason">>,
  ): Promise<void>;
  getHead(entity: string, device: string): HeadRow | undefined;
  putHead(row: HeadRow): Promise<void>;
  listHeads(entity?: string): HeadRow[];
}

/** Reference in-memory implementation (tests, and the Noop transport path). */
export class MemoryOpLogPersistence implements OpLogPersistence {
  private ops = new Map<string, StoredOp>();
  private heads = new Map<string, HeadRow>();

  getOp(hash: string): StoredOp | undefined {
    return this.ops.get(hash);
  }

  getOpAt(entity: string, device: string, seq: number): StoredOp | undefined {
    for (const op of this.ops.values()) {
      if (op.entity === entity && op.device === device && op.seq === seq) return op;
    }
    return undefined;
  }

  listOps(filter: Parameters<OpLogPersistence["listOps"]>[0]): StoredOp[] {
    const out: StoredOp[] = [];
    for (const op of this.ops.values()) {
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

  async putOp(row: StoredOp): Promise<void> {
    this.ops.set(row.hash, { ...row });
  }

  async patchOp(
    hash: string,
    patch: Partial<Pick<StoredOp, "applied" | "published" | "quarantined" | "quarantineReason">>,
  ): Promise<void> {
    const existing = this.ops.get(hash);
    if (!existing) return;
    this.ops.set(hash, { ...existing, ...patch });
  }

  getHead(entity: string, device: string): HeadRow | undefined {
    return this.heads.get(headRowId(entity, device));
  }

  async putHead(row: HeadRow): Promise<void> {
    this.heads.set(row.id, { ...row });
  }

  listHeads(entity?: string): HeadRow[] {
    return [...this.heads.values()].filter((h) => entity === undefined || h.entity === entity);
  }
}
