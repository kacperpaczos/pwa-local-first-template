import { createTransaction } from "@tanstack/db";
import type { Collection } from "@tanstack/db";
import {
  headRowId,
  type HeadRow,
  type OpLogPersistence,
  type StoredOp,
} from "@/shared/store/oplog-persistence";

/**
 * Lives next to the port and `MemoryOpLogPersistence` rather than in
 * `db/client.ts` so both implementations can be held to the same contract
 * (`oplog-persistence.contract.ts`) — importing it must not drag in OPFS.
 *
 * Note the semantic difference the contract makes explicit: writes here are
 * confirmed asynchronously by TanStack, so a row is NOT necessarily readable
 * the moment `putOp` resolves. `OpLogStore` keeps its own read index for
 * exactly this reason — see ADR-010's consequences section.
 */

/** Local-only write helper — commits via acceptMutations, no outbox involved. */
export async function persistLocal<T extends object, K extends string | number>(
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
