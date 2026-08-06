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

function notesEqual(a: Note, b: Note): boolean {
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

/**
 * Fold every unapplied "notes" op into the entity table. Ops are processed
 * per device in seq order; a payload that fails to decode or fold is
 * QUARANTINED (with the head already advanced at ingest), so one poison op
 * skips itself instead of wedging sync — the structural fix for the retired
 * pipeline's cursor-never-advances failure mode.
 */
export async function materializeNoteOps(
  store: OpLogStore,
  target: MaterializeTarget,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { applied: [], quarantined: [], pending: [] };

  for (const op of store.unapplied("notes")) {
    try {
      const outcome = await foldOne(op, target);
      if (outcome === "pending") {
        result.pending.push(op.hash);
        continue;
      }
      await store.markApplied([op.hash]);
      result.applied.push(op.hash);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await store.quarantine(op.hash, reason);
      result.quarantined.push({ hash: op.hash, reason });
    }
  }

  return result;
}

async function foldOne(op: StoredOp, target: MaterializeTarget): Promise<"applied" | "pending"> {
  const payload = decodeNoteOpPayload(new TextEncoder().encode(op.payloadJson));

  if (payload.kind === "upsert") {
    const remote = parseNote(payload.note);
    nextLamport(Math.max(remote.title_lamport, remote.deleted_lamport));
    const local = target.getNote(remote.id);
    if (!local) {
      await target.upsertNote(remote);
      return "applied";
    }
    // mergeBodyDocs throws on a corrupt Loro snapshot — caught above → quarantine.
    const merged = mergeNote(local, remote);
    if (!notesEqual(merged, local)) {
      await target.upsertNote(merged);
    }
    return "applied";
  }

  nextLamport(payload.deleted_lamport);
  const local = target.getNote(payload.id);
  if (!local) {
    // The creating device's upsert hasn't arrived yet; retry next cycle.
    return "pending";
  }
  const folded = foldDelete(local, payload);
  if (!notesEqual(folded, local)) {
    await target.upsertNote(folded);
  }
  return "applied";
}
