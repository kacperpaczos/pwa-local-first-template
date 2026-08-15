import type { AppDatabase } from "@/shared/db/client";
import { createPersistenceFacade, type PersistenceFacade } from "@/shared/db/facade";
import { COUNTER_ID, emptyCounter, type Counter } from "@/shared/db/schemas";
import { generateDeviceKey, type DeviceKey } from "@/shared/identity/device";
import { materializeCounterOps, type MaterializeTarget } from "@/shared/store/materialize";
import { MemoryOpLogPersistence } from "@/shared/store/oplog-persistence";
import { memoryHeadCounter, OpLogStore, type HeadCounter } from "@/shared/store/oplog-store";
import { SyncEngine } from "@/shared/sync/engine";
import type { LogSyncTransport } from "@/shared/sync/transport";
import { type FakeHub, FakeHubTransport } from "./fake-hub";

/** Mirrors `SYNC_ENTITY` in db/client.ts, which cannot be imported here (OPFS). */
export const ENTITY = "counter";

export type VirtualDevice = {
  device: DeviceKey;
  persistence: MemoryOpLogPersistence;
  counter: HeadCounter;
  store: OpLogStore;
  engine: SyncEngine;
  facade: PersistenceFacade;
  /** Materialized state — the stand-in for the OPFS `counter` table. */
  state: Map<string, Counter>;
  read: () => Counter;
};

/**
 * One device's full local stack, wired from real production code:
 * `PersistenceFacade` → `OpLogStore.append` → materializer → `SyncEngine` →
 * transport. The facade talks to the same `AppDatabase` surface the real app
 * wires in `db/client.ts` (store + engine + materializeLocal), so a write
 * that never reaches the log fails this layer instead of passing it.
 *
 * Only two things are stand-ins, and each is covered elsewhere:
 * - the transport is a `FakeHubTransport` (real Gun wire: gun-log-transport.test.ts + e2e),
 * - persistence is `MemoryOpLogPersistence` (the TanStack/SQLite implementation
 *   is held to the same contract in oplog-persistence.contract.ts).
 */
export function createVirtualDevice(
  hub: FakeHub,
  options: { transport?: () => LogSyncTransport } = {},
): VirtualDevice {
  const device = generateDeviceKey();
  const persistence = new MemoryOpLogPersistence();
  const counter = memoryHeadCounter();
  const store = new OpLogStore({ persistence, device, headCounter: counter });
  const state = new Map<string, Counter>();

  const target: MaterializeTarget = {
    getCounter: () => state.get(COUNTER_ID),
    upsertCounter: async (row) => void state.set(COUNTER_ID, row),
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

  const db = {
    store,
    engine,
    entity: ENTITY,
    materializeLocal: async () => {
      await materializeCounterOps(store, target);
      return state.get(COUNTER_ID) ?? emptyCounter();
    },
  } as unknown as AppDatabase;

  const facade = createPersistenceFacade(db);

  return {
    device,
    persistence,
    counter,
    store,
    engine,
    facade,
    state,
    read: () => state.get(COUNTER_ID) ?? emptyCounter(),
  };
}

/** Runs one sync cycle on every device until nothing new lands. */
export async function settle(devices: readonly VirtualDevice[], rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    for (const d of devices) {
      await d.engine.syncNow();
    }
  }
}
