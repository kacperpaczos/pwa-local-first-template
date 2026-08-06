import type { OpLogStore } from "@/shared/store/oplog-store";
import { materializeNoteOps, type MaterializeTarget } from "@/shared/store/materialize";
import { opFromStored } from "./stored-op";
import { SpaceUnavailableError, type LogSyncTransport } from "./transport";
import { setSyncStatus, syncQuarantineCountStore, type SyncStatus } from "./status";

const ENGINE_LOCK = "pwa-sync-engine";
const FLUSH_INTERVAL_MS = 30_000;
const FETCH_RETRIES = 3;

/**
 * The engine's cross-tab critical section. Also taken by writers that fold
 * external data into the same collections (backup import) so they never
 * interleave with a running sync cycle.
 */
export function withSyncEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return fn();
  return locks.request(ENGINE_LOCK, { mode: "exclusive" }, () => fn()) as Promise<T>;
}

export type SyncEngineOptions = {
  store: OpLogStore;
  transport: () => LogSyncTransport;
  target: MaterializeTarget;
  entity?: string;
  /** Injected for tests: skip the periodic flush timer. */
  disableInterval?: boolean;
  /**
   * Auto-trigger a sync cycle when a remote device's head advances (near-
   * instant propagation instead of waiting for the interval). Default true;
   * tests that want full control over when cycles run set this false.
   */
  reactive?: boolean;
};

/**
 * Orchestrates log-height sync over a LogSyncTransport:
 * observe heads → fetch missing ranges → ingest → materialize → publish acks;
 * `flush()` publishes locally appended (unpublished) ops. Each cycle runs
 * under a cross-tab Web Lock so two tabs never sync concurrently, and the
 * sync status is recomputed from real state at the end of every cycle.
 */
export class SyncEngine {
  private readonly store: OpLogStore;
  private readonly makeTransport: () => LogSyncTransport;
  private readonly target: MaterializeTarget;
  private readonly entity: string;

  private transport: LogSyncTransport;
  private unsubscribers: Array<() => void> = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly reactive: boolean;
  private closed = false;
  private locked = false;
  private sawUnsupported = false;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  /** Latest announced remote heads (device → seq). */
  private readonly remoteHeads = new Map<string, number>();
  /** Latest acks per device (device → {otherDevice → seq}). */
  private readonly acksByDevice = new Map<string, Record<string, number>>();

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.makeTransport = options.transport;
    this.target = options.target;
    this.entity = options.entity ?? "notes";
    this.reactive = options.reactive ?? true;
    this.transport = this.makeTransport();

    this.subscribe();
    if (!options.disableInterval) {
      this.interval = setInterval(() => {
        void this.syncNow().catch(() => undefined);
      }, FLUSH_INTERVAL_MS);
      // Node/Vitest: don't keep the process alive.
      (this.interval as unknown as { unref?: () => void }).unref?.();
    }
  }

  private subscribe(): void {
    this.unsubscribers.push(
      this.transport.subscribeHeads(this.entity, (head) => {
        const known = this.remoteHeads.get(head.device) ?? 0;
        if (head.seq > known) {
          this.remoteHeads.set(head.device, head.seq);
          if (this.reactive && head.device !== this.store.deviceId) {
            void this.syncNow().catch(() => undefined);
          }
        }
      }),
      this.transport.subscribeAcks(this.entity, (device, acks) => {
        this.acksByDevice.set(device, acks);
      }),
    );
  }

  /** Devices known to this space: seen heads ∪ seen acks ∪ self. */
  roster(): string[] {
    const set = new Set<string>([this.store.deviceId]);
    for (const device of this.remoteHeads.keys()) set.add(device);
    for (const device of this.acksByDevice.keys()) set.add(device);
    return [...set];
  }

  /**
   * Coverage gate for tombstone GC: the op at (device, seq) is covered when
   * every OTHER device in the roster has acked that device's log to ≥ seq.
   */
  isOpCovered(device: string, seq: number): boolean {
    for (const other of this.roster()) {
      if (other === device) continue;
      const acked = this.acksByDevice.get(other)?.[device] ?? 0;
      if (acked < seq) return false;
    }
    return true;
  }

  /**
   * One full sync cycle. Concurrent callers share runs instead of stacking:
   * a call during a running cycle awaits that cycle plus ONE follow-up
   * (which picks up whatever the running cycle missed).
   */
  syncNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.queued ??= this.running
        .catch(() => undefined)
        .then(() => {
          this.queued = null;
          return this.syncNow();
        });
      return this.queued;
    }
    const run = this.runCycle().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async runCycle(): Promise<void> {
    setSyncStatus("syncing");
    try {
      await this.underLock(async () => {
        await this.flushLocked();
        await this.pullLocked();
      });
    } catch (error) {
      if (error instanceof SpaceUnavailableError) {
        this.locked = true;
      }
      throw error;
    } finally {
      this.recomputeStatus();
    }
  }

  /** Publish locally appended ops. Runs inside syncNow, or standalone after a write. */
  async flush(): Promise<void> {
    if (this.closed) return;
    try {
      await this.underLock(() => this.flushLocked());
      this.locked = false;
    } catch (error) {
      if (error instanceof SpaceUnavailableError) {
        this.locked = true;
      }
      throw error;
    } finally {
      this.recomputeStatus();
    }
  }

  private async flushLocked(): Promise<void> {
    await this.transport.ready();
    this.locked = false;
    const pending = this.store.unpublished(this.entity);
    if (pending.length === 0) return;
    await this.transport.publish(
      this.entity,
      pending.map((row) => ({ op: opFromStored(row), payloadJson: row.payloadJson })),
    );
    await this.store.markPublished(pending.map((row) => row.hash));
  }

  private async pullLocked(): Promise<void> {
    await this.transport.ready();

    for (const [device, announcedSeq] of this.remoteHeads) {
      if (device === this.store.deviceId) continue;
      await this.pullDevice(device, announcedSeq);
    }

    const result = await materializeNoteOps(this.store, this.target);
    void result;

    await this.publishAcks();
  }

  private async pullDevice(device: string, announcedSeq: number): Promise<void> {
    for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
      const localSeq = this.store.head(this.entity, device)?.seq ?? 0;
      if (localSeq >= announcedSeq) return;

      const { ops, sawUnsupportedVersion } = await this.transport.fetchOps(
        this.entity,
        device,
        localSeq + 1,
        announcedSeq,
      );
      if (sawUnsupportedVersion) {
        this.sawUnsupported = true;
      }

      let progressed = false;
      for (const fetched of ops.sort((a, b) => a.op.header.seq - b.op.header.seq)) {
        const verdict = await this.store.ingest(fetched.op, fetched.payloadBytes);
        if (verdict === "stored") progressed = true;
        // "gap": an earlier row hasn't reached the relay yet — retry loop
        // refetches from the new local head. "fork"/"invalid": quarantined
        // by policy at ingest (head untouched); surfaced via degraded status.
      }
      if (!progressed) return;
    }
  }

  private async publishAcks(): Promise<void> {
    const acks: Record<string, number> = {};
    for (const head of this.store.heads(this.entity)) {
      if (head.device === this.store.deviceId) continue;
      acks[head.device] = head.seq;
    }
    if (Object.keys(acks).length === 0) return;
    await this.transport.publishAcks(this.entity, this.store.deviceId, acks);
  }

  private recomputeStatus(): void {
    syncQuarantineCountStore.set(this.store.quarantined(this.entity).length);
    setSyncStatus(this.computeStatus());
  }

  private computeStatus(): SyncStatus {
    if (this.locked) return "locked";
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
    if (this.sawUnsupported) return "outdated";
    if (this.store.quarantined(this.entity).length > 0) return "degraded";
    return "idle";
  }

  private underLock<T>(fn: () => Promise<T>): Promise<T> {
    return withSyncEngineLock(fn);
  }

  /** Tear down and rebuild the transport (post-pairing / recovery import). */
  async restart(): Promise<void> {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    await this.transport.close();
    this.remoteHeads.clear();
    this.acksByDevice.clear();
    this.sawUnsupported = false;
    this.locked = false;
    this.transport = this.makeTransport();
    this.subscribe();
    await this.syncNow().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    await this.transport.close();
  }
}
