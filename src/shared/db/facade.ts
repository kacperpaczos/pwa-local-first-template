import type { AppDatabase } from "./client";
import { ensureStoragePersisted } from "./storage-persist";
import { nextLamport } from "./lamport";
import type { CounterOpPayload } from "@/shared/oplog/payload";
import { OwnLogLagError } from "@/shared/store/oplog-store";
import type { Counter } from "./schemas";

/**
 * Single write API for the UI.
 *
 * Every write is one durable op appended to this device's log, then folded
 * into the state row by the materializer, then published in the background.
 * There is no separate optimistic write and no separate outbox: the log IS
 * the outbox (its `published` flag), and the state row is only ever derived
 * from the log. A write is "done" for the UI the moment the local fold
 * lands — publishing can lag or fail without affecting it (sync status
 * surfaces that separately).
 */
export type PersistenceFacade = {
  /** Append a +`amount` op (default 1) and fold it locally. */
  increment: (amount?: number) => Promise<Counter>;
  /** Append a label op stamped with the next Lamport value and fold it locally. */
  setLabel: (label: string) => Promise<Counter>;
};

export function createPersistenceFacade(db: AppDatabase): PersistenceFacade {
  /**
   * Append with a short bounded retry on `OwnLogLagError`: a sibling tab's
   * append can be ahead of what this tab's replicated view shows for a few
   * milliseconds, and refusing to fork the log is correct — but the UI write
   * should wait out that window rather than surface it. A persistent gap
   * (real corruption) still throws after the retries.
   */
  async function appendWithRetry(payload: CounterOpPayload): Promise<void> {
    const ATTEMPTS = 10;
    const DELAY_MS = 50;
    for (let attempt = 1; ; attempt++) {
      try {
        await db.store.append(db.entity, payload);
        return;
      } catch (error) {
        if (!(error instanceof OwnLogLagError) || attempt >= ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      }
    }
  }

  async function write(payload: CounterOpPayload): Promise<Counter> {
    void ensureStoragePersisted();
    await appendWithRetry(payload);
    // Fold the op we just appended (and anything else pending) into the
    // state row — this is the write the UI observes.
    const counter = await db.materializeLocal();
    // Publish in the background; a failed publish leaves the op queued in
    // the log and the engine retries on its own schedule.
    void db.engine.flush().catch(() => undefined);
    void db.engine.syncNow().catch(() => undefined);
    return counter;
  }

  return {
    increment(amount = 1) {
      if (!Number.isInteger(amount) || amount < 1) {
        throw new Error(`increment amount must be a positive integer, got ${amount}`);
      }
      return write({ kind: "increment", amount });
    },
    setLabel(label: string) {
      return write({ kind: "set_label", label, lamport: nextLamport() });
    },
  };
}
