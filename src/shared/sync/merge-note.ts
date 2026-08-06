import type { Note } from "../db/schemas";
import { mergeBodyDocs } from "../db/crdt";
import { recordConflict } from "./conflict-log";

/**
 * Resolve one LWW field between two replicas, in three descending levels:
 * 1. Higher Lamport clock wins outright.
 * 2. On a Lamport tie, the later `updated_at` wins.
 * 3. On a full tie (same Lamport AND same `updated_at`, different values —
 *    only realistically hit with closely-synced clocks or in tests), fall
 *    back to a value comparison. This step must be a pure, symmetric
 *    function of the two values being compared, not favor either side by
 *    role — an asymmetric "remote wins ties" rule makes two peers merging
 *    the same pair pick opposite winners (each calls the *other* side
 *    "remote"), so their state permanently diverges instead of converging.
 */
function resolveLww<T>(
  local: { value: T; lamport: number },
  remote: { value: T; lamport: number },
  localUpdatedAt: string,
  remoteUpdatedAt: string,
  compareValue: (a: T, b: T) => number,
): T {
  if (remote.lamport !== local.lamport) {
    return remote.lamport > local.lamport ? remote.value : local.value;
  }
  if (remoteUpdatedAt !== localUpdatedAt) {
    return remoteUpdatedAt > localUpdatedAt ? remote.value : local.value;
  }
  return compareValue(remote.value, local.value) > 0 ? remote.value : local.value;
}

function compareStrings(a: string, b: string): number {
  return a > b ? 1 : a < b ? -1 : 0;
}

function compareNullableStrings(a: string | null, b: string | null): number {
  return compareStrings(a ?? "", b ?? "");
}

/**
 * Per-field conflict resolution for notes (hybrid LWW + CRDT strategy):
 * - `title` and `deleted_at` use LWW on their own Lamport clock, so an edit
 *   to one field never clobbers a concurrent edit to the other.
 * - `body` is a Loro CRDT text doc, merged via causal history instead of a
 *   local/remote "winner" — this is the escalation path from LWW to CRDT
 *   for free-text content.
 *
 * When LWW rejects a local title / deleted_at that differs from the winner,
 * a conflict_log entry is recorded (no-op without localStorage).
 */
export function mergeNote(local: Note, remote: Note): Note {
  const title = resolveLww(
    { value: local.title, lamport: local.title_lamport },
    { value: remote.title, lamport: remote.title_lamport },
    local.updated_at,
    remote.updated_at,
    compareStrings,
  );

  const deleted_at = resolveLww(
    { value: local.deleted_at, lamport: local.deleted_lamport },
    { value: remote.deleted_at, lamport: remote.deleted_lamport },
    local.updated_at,
    remote.updated_at,
    compareNullableStrings,
  );

  if (title === remote.title && local.title !== remote.title) {
    recordConflict({
      noteId: local.id,
      field: "title",
      lostValue: local.title,
      lostLamport: local.title_lamport,
      wonValue: remote.title,
    });
  }

  if (deleted_at === remote.deleted_at && local.deleted_at !== remote.deleted_at) {
    recordConflict({
      noteId: local.id,
      field: "deleted_at",
      lostValue: local.deleted_at,
      lostLamport: local.deleted_lamport,
      wonValue: remote.deleted_at,
    });
  }

  const body = mergeBodyDocs(local.body_doc, remote.body_doc);

  return {
    id: local.id,
    title,
    title_lamport: Math.max(local.title_lamport, remote.title_lamport),
    body: body.text,
    body_doc: body.doc,
    deleted_at,
    deleted_lamport: Math.max(local.deleted_lamport, remote.deleted_lamport),
    updated_at: remote.updated_at > local.updated_at ? remote.updated_at : local.updated_at,
  };
}
