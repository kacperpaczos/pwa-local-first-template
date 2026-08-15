import type { AppDatabase } from "@/shared/db/client";
import { createPersistenceFacade, type PersistenceFacade } from "@/shared/db/facade";
import { parseNote, type Note } from "@/shared/db/schemas";
import { generateDeviceKey, type DeviceKey } from "@/shared/identity/device";
import type { NoteOpPayload } from "@/shared/oplog/payload";
import type { MaterializeTarget } from "@/shared/store/materialize";
import { MemoryOpLogPersistence } from "@/shared/store/oplog-persistence";
import { memoryHeadCounter, OpLogStore, type HeadCounter } from "@/shared/store/oplog-store";
import { SyncEngine } from "@/shared/sync/engine";
import type { LogSyncTransport } from "@/shared/sync/transport";
import { type FakeHub, FakeHubTransport } from "./fake-hub";

/** Mirrors `SYNC_ENTITY` in db/client.ts, which cannot be imported here (OPFS). */
export const ENTITY = "notes";

export type VirtualDevice = {
  device: DeviceKey;
  persistence: MemoryOpLogPersistence;
  counter: HeadCounter;
  store: OpLogStore;
  engine: SyncEngine;
  facade: PersistenceFacade;
  /** Materialized note state — the stand-in for the OPFS `notes` table. */
  notes: Map<string, Note>;
};

/**
 * One device's full local stack, wired from real production code:
 * `PersistenceFacade` → outbox → `OpLogStore` → `SyncEngine` → transport →
 * `materializeNoteOps` → note state.
 *
 * Only three things are stand-ins, and each is covered elsewhere:
 * - the transport is a `FakeHubTransport` (real Gun wire: gun-log-transport.test.ts + e2e),
 * - persistence is `MemoryOpLogPersistence` (the TanStack/SQLite implementation
 *   is held to the same contract in oplog-persistence.contract.ts),
 * - the notes collection + outbox executor are Map-backed (real TanStack DB and
 *   OPFS: e2e only).
 *
 * The outbox stand-in deliberately reproduces `mutationFns.syncNotes` from
 * db/client.ts — append every mutated row to this device's log, then flush.
 * A stub that merely applied the mutation would make every test here pass
 * without the log ever being written, which is the gap this harness exists
 * to close.
 */
export function createVirtualDevice(
  hub: FakeHub,
  options: { transport?: () => LogSyncTransport } = {},
): VirtualDevice {
  const device = generateDeviceKey();
  const persistence = new MemoryOpLogPersistence();
  const counter = memoryHeadCounter();
  const store = new OpLogStore({ persistence, device, headCounter: counter });
  const notes = new Map<string, Note>();

  // Ids touched by the current outbox transaction, in mutation order — the
  // stand-in for `transaction.mutations`.
  let touched: string[] = [];

  const collection = {
    get: (id: string) => notes.get(id),
    insert: (note: Note) => {
      notes.set(note.id, structuredClone(note));
      touched.push(note.id);
    },
    update: (id: string, cb: (draft: Note) => void) => {
      const current = notes.get(id);
      if (!current) return;
      const draft = structuredClone(current);
      cb(draft);
      notes.set(id, draft);
      touched.push(id);
    },
    get toArray() {
      return [...notes.values()];
    },
  };

  const offline = {
    createOfflineTransaction: () => {
      let mutateFn: (() => void) | null = null;
      return {
        mutate: (fn: () => void) => {
          mutateFn = fn;
        },
        commit: async () => {
          touched = [];
          mutateFn?.();
          const ids = touched;
          touched = [];
          for (const id of ids) {
            const raw = notes.get(id);
            if (!raw) continue;
            const note = parseNote(raw);
            await store.append(ENTITY, { kind: "upsert", note } satisfies NoteOpPayload);
          }
          await engine.flush();
        },
      };
    },
  };

  const target: MaterializeTarget = {
    getNote: (id) => notes.get(id),
    upsertNote: async (note) => void notes.set(note.id, note),
  };

  const engine = new SyncEngine({
    store,
    transport: options.transport ?? (() => new FakeHubTransport(hub)),
    target,
    entity: ENTITY,
    disableInterval: true,
    // Deterministic control in tests: only the syncNow() calls we make run —
    // no background cycle kicked off by a remote head announcement.
    reactive: false,
  });

  const facade = createPersistenceFacade({ notes: collection, offline } as unknown as AppDatabase);

  return { device, persistence, counter, store, engine, facade, notes };
}

/** Runs one sync cycle on every device until nothing new lands. */
export async function settle(devices: readonly VirtualDevice[], rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    for (const d of devices) {
      await d.engine.syncNow();
    }
  }
}
