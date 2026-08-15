import { nextLamport } from "@/shared/db/lamport";
import { emptyCounter, type Counter } from "@/shared/db/schemas";
import { recordConflict } from "@/shared/sync/conflict-log";
import { decodeCounterOpPayload, type CounterOpPayload } from "@/shared/oplog/payload";
import type { OpLogStore } from "./oplog-store";
import type { StoredOp } from "./oplog-persistence";

export type MaterializeTarget = {
  getCounter(): Counter | undefined;
  upsertCounter(counter: Counter): Promise<void>;
};

export type MaterializeResult = {
  applied: string[];
  quarantined: Array<{ hash: string; reason: string }>;
};

/**
 * Rebuild the counter state row from the log — a FULL recompute, not an
 * incremental fold, and that is deliberate:
 *
 * The state is a pure function of the set of ops. `value` is the sum of all
 * increment amounts (addition commutes — a grow-only counter), `label` is
 * the set_label with the highest (lamport, value) pair (a max — also order-
 * free). Recomputing from scratch makes materialization idempotent and
 * immune to the multi-tab hazards an incremental fold has: a sibling tab's
 * concurrent write, a stale read of the state row, or a re-delivered flag
 * can double-count or drop a delta, but they cannot change what the full
 * op set sums to. Two tabs may transiently write rows derived from
 * different op subsets; each cycle re-reads persistence (`hydrate`), so
 * both converge on the same total as soon as replication delivers.
 * O(ops) per cycle is an accepted cost at template scale — BACKLOG tracks
 * indexes and compaction.
 *
 * A payload that fails to DECODE is quarantined (with the head already
 * advanced at ingest) and excluded from every future recompute, so one
 * poison op skips itself instead of wedging sync. A failure to WRITE is
 * deliberately NOT quarantined: a full disk says nothing about the op's
 * validity, and quarantining is permanent — those errors propagate so the
 * cycle fails and retries with the ops still pending.
 */
export async function materializeCounterOps(
  store: OpLogStore,
  target: MaterializeTarget,
): Promise<MaterializeResult> {
  const entity = "counter";
  const result: MaterializeResult = { applied: [], quarantined: [] };

  // Sibling tabs append to the same persisted log but not to this tab's
  // in-memory index — re-reading persistence is what makes every tab's
  // recompute converge on the same op set.
  store.hydrate([entity]);

  const newlySeen = new Set(store.unapplied(entity).map((op) => op.hash));

  // Decode every non-quarantined op; quarantine the ones this device cannot
  // read and fold the rest.
  const decoded: Array<{ op: StoredOp; payload: CounterOpPayload }> = [];
  for (const head of store.heads(entity)) {
    for (const op of store.opsSince(entity, head.device, 1)) {
      if (op.quarantined) continue;
      try {
        decoded.push({
          op,
          payload: decodeCounterOpPayload(new TextEncoder().encode(op.payloadJson)),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await store.quarantine(op.hash, reason);
        result.quarantined.push({ hash: op.hash, reason });
        newlySeen.delete(op.hash);
      }
    }
  }

  let next = emptyCounter();
  let winner: { op: StoredOp; label: string; lamport: number } | null = null;
  for (const { op, payload } of decoded) {
    if (payload.kind === "increment") {
      next = { ...next, value: next.value + payload.amount };
      continue;
    }
    const beats =
      winner === null ||
      payload.lamport > winner.lamport ||
      (payload.lamport === winner.lamport && payload.label > winner.label);
    if (beats) {
      winner = { op, label: payload.label, lamport: payload.lamport };
    }
  }
  if (winner) {
    next = { ...next, label: winner.label, label_lamport: winner.lamport };
  }

  // Conflict history: a NEWLY seen set_label that lost to the winner is a
  // real concurrent edit someone typed and will never see again. Only newly
  // seen ops are recorded — a recompute must not re-log old losses.
  for (const { op, payload } of decoded) {
    if (payload.kind !== "set_label" || !newlySeen.has(op.hash)) continue;
    if (winner && op.hash !== winner.op.hash && payload.label !== winner.label) {
      recordConflict({
        entityId: next.id,
        field: "label",
        lostValue: payload.label,
        lostLamport: payload.lamport,
        wonValue: winner.label,
      });
    }
  }

  // Write only on change — every throw past decode is an infrastructure
  // failure and propagates untouched.
  const current = target.getCounter();
  if (
    !current ||
    current.value !== next.value ||
    current.label !== next.label ||
    current.label_lamport !== next.label_lamport
  ) {
    await target.upsertCounter(next);
  }

  // The clock advances only for REMOTE ops that actually landed: quarantined
  // ops must never move it (a poisoned counter is effectively irreversible),
  // and this device's own ops already advanced it when the facade stamped
  // them.
  let remoteHint = 0;
  for (const { op, payload } of decoded) {
    if (!newlySeen.has(op.hash) || op.device === store.deviceId) continue;
    if (payload.kind === "set_label" && payload.lamport > remoteHint) {
      remoteHint = payload.lamport;
    }
  }
  if (remoteHint > 0) {
    nextLamport(remoteHint);
  }

  const toMark = decoded.filter(({ op }) => newlySeen.has(op.hash)).map(({ op }) => op.hash);
  if (toMark.length > 0) {
    await store.markApplied(toMark);
  }
  result.applied = toMark;

  return result;
}
