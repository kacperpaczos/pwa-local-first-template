import { nextLamport } from "@/shared/db/lamport";
import { parseNote, type Note } from "@/shared/db/schemas";
import { recordConflict } from "@/shared/sync/conflict-log";
import { mergeNote } from "@/shared/sync/merge-note";
import { decodeNoteOpPayload } from "@/shared/oplog/payload";
import type { OpLogStore } from "./oplog-store";
import type { StoredOp } from "./oplog-persistence";

export type MaterializeTarget = {
  getNote(id: string): Note | undefined;
  upsertNote(note: Note): Promise<void>;
};

export type MaterializeResult = {
  applied: string[];
  quarantined: Array<{ hash: string; reason: string }>;
  /** Ops that cannot fold yet (e.g. a delete for a note whose upsert hasn't arrived). */
  pending: string[];
};

/** Symmetric LWW for the tombstone field of a delete op (no wall clocks). */
function foldDelete(local: Note, payload: { deleted_at: string; deleted_lamport: number }): Note {
  const localTs = { value: local.deleted_at, lamport: local.deleted_lamport };
  const remoteTs = { value: payload.deleted_at as string | null, lamport: payload.deleted_lamport };
  let winner = localTs;
  if (remoteTs.lamport > localTs.lamport) {
    winner = remoteTs;
  } else if (remoteTs.lamport === localTs.lamport) {
    winner = (remoteTs.value ?? "") > (localTs.value ?? "") ? remoteTs : localTs;
  }
  if (winner === remoteTs && local.deleted_at !== remoteTs.value) {
    recordConflict({
      noteId: local.id,
      field: "deleted_at",
      lostValue: local.deleted_at,
      lostLamport: local.deleted_lamport,
      wonValue: remoteTs.value,
    });
  }
  return {
    ...local,
    deleted_at: winner.value,
    deleted_lamport: Math.max(local.deleted_lamport, payload.deleted_lamport),
  };
}

export function notesEqual(a: Note, b: Note): boolean {
  return (
    a.title === b.title &&
    a.title_lamport === b.title_lamport &&
    a.body === b.body &&
    a.body_doc === b.body_doc &&
    a.deleted_at === b.deleted_at &&
    a.deleted_lamport === b.deleted_lamport &&
    a.updated_at === b.updated_at
  );
}

/** What folding an op resolves to, before anything is written. */
type FoldPlan =
  /** The upstream op for this note hasn't arrived yet; retry next cycle. */
  | { kind: "pending" }
  /** Already reflected locally — mark applied without a write. */
  | { kind: "noop"; lamportHint: number }
  | { kind: "write"; note: Note; lamportHint: number };

/**
 * Fold every unapplied "notes" op into the entity table. Ops are processed
 * per device in seq order.
 *
 * A payload that fails to DECODE OR MERGE is quarantined (with the head
 * already advanced at ingest), so one poison op skips itself instead of
 * wedging sync — the structural fix for the retired pipeline's
 * cursor-never-advances failure mode.
 *
 * A failure to WRITE is deliberately NOT quarantined: a full disk or a
 * failing storage layer says nothing about the op's validity, and
 * quarantining is permanent (nothing ever un-quarantines). Those propagate
 * so the cycle fails and retries with the op still pending.
 */
export async function materializeNoteOps(
  store: OpLogStore,
  target: MaterializeTarget,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { applied: [], quarantined: [], pending: [] };

  for (const op of store.unapplied("notes")) {
    let plan: FoldPlan;
    try {
      plan = planFold(op, target);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await store.quarantine(op.hash, reason);
      result.quarantined.push({ hash: op.hash, reason });
      continue;
    }

    if (plan.kind === "pending") {
      result.pending.push(op.hash);
      continue;
    }

    // Past this point every throw is an infrastructure failure, not a
    // verdict on the op — let it propagate untouched.
    if (plan.kind === "write") {
      await target.upsertNote(plan.note);
    }
    await store.markApplied([op.hash]);
    // The clock only advances for an op that actually landed: a quarantined
    // or still-pending op must never move it (a poisoned counter is
    // effectively irreversible — it re-seeds from note rows on every boot).
    nextLamport(plan.lamportHint);
    result.applied.push(op.hash);
  }

  return result;
}

/** Pure: decode + merge. Throws only on data this device cannot use. */
function planFold(op: StoredOp, target: MaterializeTarget): FoldPlan {
  const payload = decodeNoteOpPayload(new TextEncoder().encode(op.payloadJson));

  if (payload.kind === "upsert") {
    const remote = parseNote(payload.note);
    const lamportHint = Math.max(remote.title_lamport, remote.deleted_lamport);
    const local = target.getNote(remote.id);
    if (!local) {
      return { kind: "write", note: remote, lamportHint };
    }
    // mergeBodyDocs throws on a corrupt Loro snapshot → quarantine.
    const merged = mergeNote(local, remote);
    return notesEqual(merged, local)
      ? { kind: "noop", lamportHint }
      : { kind: "write", note: merged, lamportHint };
  }

  const local = target.getNote(payload.id);
  if (!local) {
    // The creating device's upsert hasn't arrived yet; retry next cycle.
    return { kind: "pending" };
  }
  const folded = foldDelete(local, payload);
  return notesEqual(folded, local)
    ? { kind: "noop", lamportHint: payload.deleted_lamport }
    : { kind: "write", note: folded, lamportHint: payload.deleted_lamport };
}
