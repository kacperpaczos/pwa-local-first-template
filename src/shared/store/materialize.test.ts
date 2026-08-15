import { describe, expect, it } from "vitest";
import { createBodyDoc, updateBodyDoc } from "@/shared/db/crdt";
import { nextLamport, peekLamport, resetLamportForTests } from "@/shared/db/lamport";
import type { Note } from "@/shared/db/schemas";
import { generateDeviceKey } from "@/shared/identity/device";
import { MemoryOpLogPersistence } from "./oplog-persistence";
import { OpLogStore, memoryHeadCounter } from "./oplog-store";
import { materializeNoteOps, type MaterializeTarget } from "./materialize";
import { createOperation } from "@/shared/oplog/header";
import { encodeOpPayload } from "@/shared/oplog/payload";

const ENTITY = "notes";

function note(partial: Partial<Note> & Pick<Note, "id">): Note {
  const body = createBodyDoc(partial.body ?? "");
  return {
    title: "t",
    title_lamport: 1,
    body: body.text,
    deleted_at: null,
    deleted_lamport: 0,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
    body_doc: partial.body_doc ?? body.doc,
  };
}

function makeTarget(seed: Note[] = []) {
  const map = new Map(seed.map((n) => [n.id, n]));
  const target: MaterializeTarget = {
    getNote: (id) => map.get(id),
    upsertNote: async (n) => void map.set(n.id, n),
  };
  return { map, target };
}

function makeStore() {
  const persistence = new MemoryOpLogPersistence();
  const device = generateDeviceKey();
  return new OpLogStore({ persistence, device, headCounter: memoryHeadCounter() });
}

/** Ingest a remote device's op chain into the store. */
async function ingestChain(store: OpLogStore, payloads: unknown[]) {
  const device = generateDeviceKey();
  let backlink: string | null = null;
  for (const [index, payload] of payloads.entries()) {
    const bytes = encodeOpPayload(payload);
    const op = createOperation({
      entity: ENTITY,
      seq: index + 1,
      backlink,
      payloadBytes: bytes,
      publicKey: device.publicKey,
      secretKey: device.secretKey,
      timestamp: index + 1,
    });
    const verdict = await store.ingest(op, bytes);
    if (verdict !== "stored") throw new Error(`ingest failed: ${verdict}`);
    backlink = op.hash;
  }
  return device;
}

describe("materializeNoteOps", () => {
  it("inserts a new note and merges into an existing one", async () => {
    resetLamportForTests();
    const store = makeStore();
    const local = note({ id: "n1", title: "local", title_lamport: 5 });
    const { map, target } = makeTarget([local]);

    await ingestChain(store, [
      { kind: "upsert", note: note({ id: "n1", title: "remote", title_lamport: 9 }) },
      { kind: "upsert", note: note({ id: "n2", title: "fresh" }) },
    ]);

    const result = await materializeNoteOps(store, target);
    expect(result.applied).toHaveLength(2);
    expect(result.quarantined).toEqual([]);
    expect(map.get("n1")?.title).toBe("remote");
    expect(map.get("n2")?.title).toBe("fresh");
    expect(store.unapplied(ENTITY)).toEqual([]);
  });

  it("is idempotent — re-running applies nothing new", async () => {
    resetLamportForTests();
    const store = makeStore();
    const { target } = makeTarget();
    await ingestChain(store, [{ kind: "upsert", note: note({ id: "n1" }) }]);

    await materializeNoteOps(store, target);
    const second = await materializeNoteOps(store, target);
    expect(second.applied).toEqual([]);
    expect(second.quarantined).toEqual([]);
  });

  it("quarantines a poison op and still applies later ops (old bug 3)", async () => {
    resetLamportForTests();
    const store = makeStore();
    const existing = note({ id: "poisoned" });
    const { map, target } = makeTarget([existing]);

    await ingestChain(store, [
      // Valid schema, corrupt Loro snapshot — mergeBodyDocs throws on it.
      { kind: "upsert", note: note({ id: "poisoned", body_doc: "!!!not-a-snapshot!!!" }) },
      { kind: "upsert", note: note({ id: "healthy", title: "survivor" }) },
    ]);

    const result = await materializeNoteOps(store, target);
    expect(result.quarantined).toHaveLength(1);
    expect(result.applied).toHaveLength(1);
    expect(map.get("healthy")?.title).toBe("survivor");
    expect(map.get("poisoned")?.body_doc).toBe(existing.body_doc);
    expect(store.quarantined(ENTITY)).toHaveLength(1);
    // The quarantined op never comes back as unapplied — sync can't wedge.
    expect(store.unapplied(ENTITY)).toEqual([]);
  });

  it("applies a delete via lamport LWW and keeps a pending delete for an unknown note", async () => {
    resetLamportForTests();
    const store = makeStore();
    const { map, target } = makeTarget([note({ id: "n1", deleted_lamport: 1 })]);

    await ingestChain(store, [
      { kind: "delete", id: "n1", deleted_at: "2026-02-01T00:00:00.000Z", deleted_lamport: 4 },
      { kind: "delete", id: "ghost", deleted_at: "2026-02-01T00:00:00.000Z", deleted_lamport: 2 },
    ]);

    const result = await materializeNoteOps(store, target);
    expect(map.get("n1")?.deleted_at).toBe("2026-02-01T00:00:00.000Z");
    expect(map.get("n1")?.deleted_lamport).toBe(4);
    expect(result.pending).toHaveLength(1);

    // Once the ghost's upsert arrives (another device's log), the delete folds.
    await ingestChain(store, [{ kind: "upsert", note: note({ id: "ghost" }) }]);
    await materializeNoteOps(store, target);
    const final = await materializeNoteOps(store, target);
    expect(final.pending).toEqual([]);
    expect(map.get("ghost")?.deleted_at).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rejects an out-of-range lamport instead of freezing the clock (poisoned counter)", async () => {
    resetLamportForTests();
    const store = makeStore();
    const { map, target } = makeTarget();

    await ingestChain(store, [
      // Above 2^53 `Math.max(clock, hint) + 1 === clock` — the clock would
      // stop advancing and every later local edit would collide.
      { kind: "upsert", note: { ...note({ id: "poison" }), title_lamport: 1e300 } },
      { kind: "upsert", note: note({ id: "healthy", title: "survivor" }) },
    ]);

    const result = await materializeNoteOps(store, target);
    expect(result.quarantined).toHaveLength(1);
    expect(map.get("poison")).toBeUndefined();
    expect(map.get("healthy")?.title).toBe("survivor");

    // The clock still moves for ordinary edits.
    const before = peekLamport();
    expect(nextLamport()).toBe(before + 1);
  });

  it("does not quarantine a valid op when the WRITE fails — it retries next cycle", async () => {
    resetLamportForTests();
    const store = makeStore();
    const { map, target } = makeTarget();
    let failNext = true;
    const flaky: MaterializeTarget = {
      getNote: target.getNote,
      upsertNote: async (n) => {
        if (failNext) {
          failNext = false;
          throw new Error("QuotaExceededError");
        }
        await target.upsertNote(n);
      },
    };

    await ingestChain(store, [{ kind: "upsert", note: note({ id: "n1", title: "keep me" }) }]);

    // A storage failure says nothing about the op's validity, and quarantine
    // is permanent — so it must propagate, not silently discard the op.
    await expect(materializeNoteOps(store, flaky)).rejects.toThrow(/Quota/);
    expect(store.quarantined(ENTITY)).toEqual([]);
    expect(store.unapplied(ENTITY)).toHaveLength(1);

    const retry = await materializeNoteOps(store, flaky);
    expect(retry.applied).toHaveLength(1);
    expect(map.get("n1")?.title).toBe("keep me");
  });

  it("converges independently of cross-device op arrival order", async () => {
    resetLamportForTests();
    const base = createBodyDoc("Hello world");
    const editA = updateBodyDoc(base.doc, "Hello brave world");
    const editB = updateBodyDoc(base.doc, "Hello world!");
    const noteA = note({ id: "n1", body: editA.text, body_doc: editA.doc, title_lamport: 2 });
    const noteB = note({ id: "n1", body: editB.text, body_doc: editB.doc, title_lamport: 2 });

    const run = async (first: Note, second: Note) => {
      const store = makeStore();
      const { map, target } = makeTarget();
      await ingestChain(store, [{ kind: "upsert", note: first }]);
      await ingestChain(store, [{ kind: "upsert", note: second }]);
      await materializeNoteOps(store, target);
      return map.get("n1");
    };

    const ab = await run(noteA, noteB);
    const ba = await run(noteB, noteA);
    expect(ab?.body).toBe("Hello brave world!");
    expect(ba?.body).toBe(ab?.body);
    expect(ba?.title).toBe(ab?.title);
  });
});
