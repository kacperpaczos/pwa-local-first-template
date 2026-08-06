import type { Note } from "@/shared/db/schemas";
import type { StoredOp } from "@/shared/store/oplog-persistence";
import type { SyncEngine } from "./engine";

/**
 * GC coverage predicate: a tombstone may be hard-deleted only when the op
 * that recorded it is acked by every other device in the roster. Conservative
 * by construction — a tombstone whose op cannot be found (e.g. predating the
 * v3 log) is NOT covered and stays until someone re-records it or the
 * retention backstop is reconsidered by hand.
 */
export function makeTombstoneCoverage(
  ops: () => StoredOp[],
  engine: SyncEngine,
): (note: Note) => boolean {
  return (note) => {
    let found: StoredOp | null = null;
    for (const row of ops()) {
      if (row.quarantined || row.entity !== "notes") continue;
      try {
        const payload = JSON.parse(row.payloadJson) as {
          kind?: string;
          id?: string;
          deleted_at?: string | null;
          note?: { id?: string; deleted_at?: string | null };
        };
        const matches =
          payload.kind === "delete"
            ? payload.id === note.id && payload.deleted_at === note.deleted_at
            : payload.kind === "upsert" &&
              payload.note?.id === note.id &&
              payload.note?.deleted_at === note.deleted_at;
        if (matches && (!found || row.seq > found.seq)) {
          found = row;
        }
      } catch {
        /* unparsable rows can't prove coverage */
      }
    }
    if (!found) return false;
    return engine.isOpCovered(found.device, found.seq);
  };
}
