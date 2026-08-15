import { describe, expect, it } from "vitest";
import { headRowId, type HeadRow, type OpLogPersistence, type StoredOp } from "./oplog-persistence";

/**
 * The `OpLogPersistence` contract, run against every implementation.
 *
 * `MemoryOpLogPersistence` backs every unit test in the sync layer, while
 * `CollectionOpLogPersistence` is what actually ships. Holding both to one
 * suite is the only thing that keeps them from drifting — and they do differ
 * in one visible way, which the contract states rather than hides:
 *
 * **Reads are eventually consistent after a write.** TanStack confirms a
 * persisted write asynchronously, so a row is not necessarily readable the
 * moment `putOp`/`putHead` resolves. `OpLogStore` maintains its own read
 * index precisely because of this (ADR-010, consequences). Assertions below
 * therefore poll — the in-memory implementation satisfies them on the first
 * tick, and a stricter "synchronously visible" contract would be a promise
 * the shipping implementation cannot keep.
 */

/** Polls until `read` returns something truthy, or fails after `timeoutMs`. */
export async function eventually<T>(read: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Value never became readable within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function makeOp(partial: Partial<StoredOp> & Pick<StoredOp, "hash">): StoredOp {
  return {
    entity: "notes",
    device: "device-a",
    seq: 1,
    backlink: null,
    timestamp: 1_700_000_000_000,
    signature: "sig",
    payloadJson: '{"kind":"upsert"}',
    applied: false,
    published: false,
    quarantined: false,
    quarantineReason: null,
    ...partial,
  };
}

export function makeHead(partial: Partial<HeadRow> & Pick<HeadRow, "hash">): HeadRow {
  const entity = partial.entity ?? "notes";
  const device = partial.device ?? "device-a";
  return {
    id: headRowId(entity, device),
    entity,
    device,
    seq: 1,
    ...partial,
  };
}

export type PersistenceFactory = () => {
  persistence: OpLogPersistence;
  cleanup?: () => void | Promise<void>;
};

export function describeOpLogPersistenceContract(name: string, create: PersistenceFactory): void {
  describe(`OpLogPersistence contract: ${name}`, () => {
    /** Runs `body` against a fresh store and always releases its resources. */
    async function withStore(body: (p: OpLogPersistence) => Promise<void>): Promise<void> {
      const { persistence, cleanup } = create();
      try {
        await body(persistence);
      } finally {
        await cleanup?.();
      }
    }

    it("stores an op and reads it back by hash", async () => {
      await withStore(async (p) => {
        await p.putOp(makeOp({ hash: "h1", seq: 1 }));
        const stored = await eventually(() => p.getOp("h1"));
        expect(stored.seq).toBe(1);
        expect(stored.entity).toBe("notes");
      });
    });

    it("returns undefined for an unknown hash", async () => {
      await withStore(async (p) => {
        expect(p.getOp("missing")).toBeUndefined();
      });
    });

    it("getOpAt finds an op by (entity, device, seq) and ignores other logs", async () => {
      await withStore(async (p) => {
        await p.putOp(makeOp({ hash: "h1", device: "a", seq: 1 }));
        await p.putOp(makeOp({ hash: "h2", device: "b", seq: 1 }));
        await eventually(() => p.getOp("h2"));

        expect(p.getOpAt("notes", "a", 1)?.hash).toBe("h1");
        expect(p.getOpAt("notes", "b", 1)?.hash).toBe("h2");
        expect(p.getOpAt("notes", "a", 2)).toBeUndefined();
        expect(p.getOpAt("other", "a", 1)).toBeUndefined();
      });
    });

    it("putOp on an existing hash updates in place instead of duplicating", async () => {
      await withStore(async (p) => {
        await p.putOp(makeOp({ hash: "h1", seq: 1, applied: false }));
        await eventually(() => p.getOp("h1"));
        await p.putOp(makeOp({ hash: "h1", seq: 1, applied: true }));

        await eventually(() => (p.getOp("h1")?.applied ? p.getOp("h1") : undefined));
        expect(p.listOps({ entity: "notes" })).toHaveLength(1);
      });
    });

    it("listOps filters by device, fromSeq and every flag", async () => {
      await withStore(async (p) => {
        await p.putOp(makeOp({ hash: "a1", device: "a", seq: 1, applied: true }));
        await p.putOp(makeOp({ hash: "a2", device: "a", seq: 2, published: true }));
        await p.putOp(makeOp({ hash: "b1", device: "b", seq: 1, quarantined: true }));
        await p.putOp(makeOp({ hash: "x1", entity: "other", device: "a", seq: 1 }));
        await eventually(() => p.getOp("x1"));

        const hashes = (rows: StoredOp[]) => rows.map((r) => r.hash);

        expect(hashes(p.listOps({ entity: "notes" }))).toEqual(["a1", "a2", "b1"]);
        expect(hashes(p.listOps({ entity: "notes", device: "a" }))).toEqual(["a1", "a2"]);
        expect(hashes(p.listOps({ entity: "notes", device: "a", fromSeq: 2 }))).toEqual(["a2"]);
        expect(hashes(p.listOps({ entity: "notes", applied: true }))).toEqual(["a1"]);
        expect(hashes(p.listOps({ entity: "notes", published: true }))).toEqual(["a2"]);
        expect(hashes(p.listOps({ entity: "notes", quarantined: true }))).toEqual(["b1"]);
        expect(hashes(p.listOps({ entity: "notes", quarantined: false }))).toEqual(["a1", "a2"]);
        expect(hashes(p.listOps({ entity: "other" }))).toEqual(["x1"]);
      });
    });

    it("listOps returns ops grouped by device and ascending by seq", async () => {
      // The engine walks these in order to rebuild a chain, so ordering is
      // part of the contract, not an incidental property of the backing store.
      await withStore(async (p) => {
        await p.putOp(makeOp({ hash: "b2", device: "b", seq: 2 }));
        await p.putOp(makeOp({ hash: "a2", device: "a", seq: 2 }));
        await p.putOp(makeOp({ hash: "b1", device: "b", seq: 1 }));
        await p.putOp(makeOp({ hash: "a1", device: "a", seq: 1 }));
        await eventually(() => p.getOp("a1"));

        expect(p.listOps({ entity: "notes" }).map((r) => r.hash)).toEqual(["a1", "a2", "b1", "b2"]);
      });
    });

    it("patchOp updates only the given flags", async () => {
      await withStore(async (p) => {
        await p.putOp(makeOp({ hash: "h1", seq: 7, applied: false, published: false }));
        await eventually(() => p.getOp("h1"));

        await p.patchOp("h1", { published: true, quarantineReason: "why" });
        const patched = await eventually(() =>
          p.getOp("h1")?.published ? p.getOp("h1") : undefined,
        );

        expect(patched.published).toBe(true);
        expect(patched.quarantineReason).toBe("why");
        expect(patched.applied).toBe(false);
        expect(patched.seq).toBe(7);
      });
    });

    it("patchOp on an unknown hash is a no-op, not an insert", async () => {
      await withStore(async (p) => {
        await p.patchOp("nope", { applied: true });
        expect(p.getOp("nope")).toBeUndefined();
        expect(p.listOps({ entity: "notes" })).toEqual([]);
      });
    });

    it("stores a head, reads it back, and overwrites it on the next put", async () => {
      await withStore(async (p) => {
        await p.putHead(makeHead({ hash: "h1", device: "a", seq: 1 }));
        await eventually(() => p.getHead("notes", "a"));

        await p.putHead(makeHead({ hash: "h2", device: "a", seq: 2 }));
        const head = await eventually(() =>
          p.getHead("notes", "a")?.seq === 2 ? p.getHead("notes", "a") : undefined,
        );

        expect(head.hash).toBe("h2");
        expect(p.listHeads("notes")).toHaveLength(1);
      });
    });

    it("getHead returns undefined for an unknown (entity, device)", async () => {
      await withStore(async (p) => {
        expect(p.getHead("notes", "nobody")).toBeUndefined();
      });
    });

    it("listHeads filters by entity, and returns every head when unfiltered", async () => {
      await withStore(async (p) => {
        await p.putHead(makeHead({ hash: "h1", device: "a" }));
        await p.putHead(makeHead({ hash: "h2", device: "b" }));
        await p.putHead(makeHead({ hash: "h3", entity: "other", device: "a" }));
        await eventually(() => p.getHead("other", "a"));

        expect(
          p
            .listHeads("notes")
            .map((h) => h.device)
            .sort(),
        ).toEqual(["a", "b"]);
        expect(p.listHeads("other").map((h) => h.device)).toEqual(["a"]);
        expect(p.listHeads()).toHaveLength(3);
      });
    });
  });
}
