import type { Operation } from "./header";

/** Persisted high-water mark of one (entity, device) log. */
export type LogHead = {
  seq: number;
  hash: string;
};

export type ChainVerdict =
  /** Next expected op — extends the chain. */
  | "ok"
  /** seq beyond head+1 — an op in between is still missing; refetch first. */
  | "gap"
  /** seq at or below the head with a matching stored hash — already have it. */
  | "duplicate"
  /** Chain violation: wrong backlink, or a *different* op at an occupied seq. */
  | "fork";

/**
 * Validate an incoming op against the local head of its (entity, device) log.
 * `hashAt` resolves the stored hash for an already-ingested seq so that a
 * re-delivery ("duplicate") can be told apart from a conflicting rewrite
 * ("fork" — p2panda treats forks as protocol violations; we quarantine).
 */
export function validateAgainstHead(
  op: Operation,
  head: LogHead | null,
  hashAt: (seq: number) => string | undefined,
): ChainVerdict {
  const expectedSeq = (head?.seq ?? 0) + 1;

  if (op.header.seq === expectedSeq) {
    const expectedBacklink = head?.hash ?? null;
    return op.header.backlink === expectedBacklink ? "ok" : "fork";
  }

  if (op.header.seq > expectedSeq) {
    return "gap";
  }

  const stored = hashAt(op.header.seq);
  if (stored === undefined) {
    // Below the head but not stored — only possible if that seq was
    // quarantined or pruned; treat as a fork so it never silently applies.
    return "fork";
  }
  return stored === op.hash ? "duplicate" : "fork";
}
