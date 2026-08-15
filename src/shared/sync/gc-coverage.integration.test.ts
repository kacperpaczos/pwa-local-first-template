import { beforeEach, describe, expect, it } from "vitest";
import { resetLamportForTests } from "@/shared/db/lamport";
import type { Note } from "@/shared/db/schemas";
import { persistLocal } from "@/shared/store/collection-oplog-persistence";
import { eventually } from "@/shared/store/oplog-persistence.contract";
import { FakeHub } from "@/testing/harness/fake-hub";
import {
  createNodeSqliteCollections,
  nodeSqliteAvailable,
} from "@/testing/harness/node-sqlite-collections";
import { createVirtualDevice, ENTITY, settle } from "@/testing/harness/virtual-device";
import { gcTombstones } from "./gc";

/**
 * Tombstone GC gated on real acknowledgement state.
 *
 * `gc.test.ts` covers the retention arithmetic with a hand-written
 * `isCovered` predicate. Here the predicate is the engine's own
 * `isOpCovered`, fed by acks that three devices actually exchanged — the
 * part that decides whether a deleted note can resurrect (BACKLOG §4).
 */
describe("tombstone GC over a real peer roster", () => {
  beforeEach(() => {
    resetLamportForTests();
  });

  it("a delete is not covered until every known peer has acked it", async () => {
    const hub = new FakeHub();
    const a = createVirtualDevice(hub);
    const b = createVirtualDevice(hub);
    const c = createVirtualDevice(hub);

    const created = await a.facade.createNote({ title: "doomed" });
    await settle([a, b, c]);
    expect(b.notes.get(created.id)).toBeDefined();
    expect(c.notes.get(created.id)).toBeDefined();

    await a.facade.softDeleteNote(created.id);
    const deleteSeq = a.store.head(ENTITY, a.device.deviceId)?.seq;
    expect(deleteSeq).toBe(2);

    // A published the delete, but neither peer has confirmed ingesting it.
    await a.engine.syncNow();
    expect(a.engine.roster()).toHaveLength(3);
    expect(a.engine.isOpCovered(a.device.deviceId, 2)).toBe(false);

    // Only B catches up: C is still behind, so coverage must stay false.
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(a.engine.isOpCovered(a.device.deviceId, 2)).toBe(false);

    await settle([a, b, c]);
    expect(a.engine.isOpCovered(a.device.deviceId, 2)).toBe(true);

    await a.engine.close();
    await b.engine.close();
    await c.engine.close();
  });

  it.skipIf(!nodeSqliteAvailable)(
    "gcTombstones hard-deletes only once the engine reports coverage",
    async () => {
      const hub = new FakeHub();
      const a = createVirtualDevice(hub);
      const b = createVirtualDevice(hub);

      const created = await a.facade.createNote({ title: "doomed" });
      await settle([a, b]);
      await a.facade.softDeleteNote(created.id);
      await a.engine.syncNow();

      // The notes table GC runs against is a real persisted collection.
      const sqlite = createNodeSqliteCollections();
      const notes = sqlite.collection<Note, string>("notes", (note) => note.id);
      const tombstone = a.notes.get(created.id);
      expect(tombstone?.deleted_at).toBeTruthy();
      await persistLocal(notes, () => {
        notes.insert(tombstone as Note);
      });
      await eventually(() => notes.get(created.id));

      const isCovered = () => a.engine.isOpCovered(a.device.deviceId, 2);

      // B has not acked the delete yet — the retention window has passed, but
      // hard-deleting now is exactly how a note resurrects.
      expect(isCovered()).toBe(false);
      expect(await gcTombstones(notes, { retentionMs: 0, isCovered })).toBe(0);
      expect(notes.get(created.id)).toBeDefined();

      await settle([a, b]);
      expect(isCovered()).toBe(true);
      expect(await gcTombstones(notes, { retentionMs: 0, isCovered })).toBe(1);
      await eventually(() => (notes.get(created.id) === undefined ? "gone" : undefined));

      sqlite.close();
      await a.engine.close();
      await b.engine.close();
    },
  );
});
