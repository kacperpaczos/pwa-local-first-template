import type { Note } from "../db/schemas";
import { mergeBodyDocs } from "../db/crdt";
import { recordConflict } from "./conflict-log";

/**
 * Per-field conflict resolution for notes (Phase 2 hybrid strategy):
 * - `title` and `deleted_at` use LWW on their own Lamport clock, so an edit
 *   to one field never clobbers a concurrent edit to the other.
 * - `body` is a Loro CRDT text doc, merged via causal history instead of a
 *   local/remote "winner" — this is the escalation path from LWW to CRDT
 *   for free-text content described in the Phase 2 report.
 *
 * When LWW rejects a local title / deleted_at that differs from the winner,
 * a conflict_log entry is recorded (no-op without localStorage).
 */
export function mergeNote(local: Note, remote: Note): Note {
  const title =
    remote.title_lamport > local.title_lamport
      ? remote.title
      : remote.title_lamport < local.title_lamport
        ? local.title
        : remote.updated_at >= local.updated_at
          ? remote.title
          : local.title;

  const deleted_at =
    remote.deleted_lamport > local.deleted_lamport
      ? remote.deleted_at
      : remote.deleted_lamport < local.deleted_lamport
        ? local.deleted_at
        : remote.updated_at >= local.updated_at
          ? remote.deleted_at
          : local.deleted_at;

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
