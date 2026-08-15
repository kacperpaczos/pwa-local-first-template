import type { OpLogStore } from "@/shared/store/oplog-store";
import { materializeCounterOps, type MaterializeTarget } from "@/shared/store/materialize";
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
  /** Set while restart() swaps the transport, so no cycle races the swap. */
  private paused = false;
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
    this.entity = options.entity ?? "counter";
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

  /**
   * Devices known to this space: every device with a PERSISTED log head
   * (i.e. one we have ever synced from) ∪ heads/acks seen this session ∪ self.
   *
   * The persisted part is what makes this safe at boot. `remoteHeads` and
   * `acksByDevice` are in-memory and start empty, and they only fill after
   * the transport authenticates and Gun delivers — strictly later than the
   * fire-and-forget GC pass on startup. A roster built from those alone
   * would be `[self]` at exactly the moment GC runs, making the coverage
   * gate below vacuously true for every op this device authored — the same
   * no-op gate the op-log rewrite set out to replace.
   */
  roster(): string[] {
    const set = new Set<string>([this.store.deviceId]);
    for (const head of this.store.heads(this.entity)) set.add(head.device);
    for (const device of this.remoteHeads.keys()) set.add(device);
    for (const device of this.acksByDevice.keys()) set.add(device);
    return [...set];
  }

  /**
   * Coverage gate for tombstone GC: the op at (device, seq) is covered when
   * every OTHER device in the roster has acked that device's log to ≥ seq.
   *
   * Acks are session state, so a known peer whose ack hasn't arrived yet
   * counts as NOT covering — conservative by design: a delayed GC pass costs
   * nothing, while a premature one resurrects notes when the unacked peer
   * eventually syncs its pre-delete copy. A device with no known peers is
   * vacuously covered, which is correct for a standalone/unpaired device.
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
    if (this.closed || this.paused) return Promise.resolve();
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
    // Recomputed from THIS cycle's fetches — "outdated" must clear once the
    // offending peer stops publishing rows we can't read, rather than
    // latching until reload (the exact defect ADR-007/010 called out).
    this.sawUnsupported = false;
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
    // Only ops the transport reports as actually sent are flagged published.
    // A Noop transport (no peers configured) and a transport closed mid-run
    // both report none, so their ops stay queued — flagging them would leave
    // a permanent hole under a future head announcement that no peer could
    // ever fetch past.
    const { publishedHashes } = await this.transport.publish(
      this.entity,
      pending.map((row) => ({ op: opFromStored(row), payloadJson: row.payloadJson })),
    );
    if (publishedHashes.length > 0) {
      await this.store.markPublished(publishedHashes);
    }
  }

  private async pullLocked(): Promise<void> {
    await this.transport.ready();

    for (const [device, announcedSeq] of this.remoteHeads) {
      if (device === this.store.deviceId) continue;
      await this.pullDevice(device, announcedSeq);
    }

    await materializeCounterOps(this.store, this.target);

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
        // The fetch is entity-scoped; a row claiming a different entity is a
        // protocol violation, and storing it would file the op under a log
        // this engine never materializes or hydrates.
        if (fetched.op.header.entity !== this.entity) continue;
        const verdict = await this.store.ingest(fetched.op, fetched.payloadBytes);
        if (verdict === "stored") progressed = true;
        // "gap": an earlier row hasn't reached the relay yet — the retry loop
        // refetches from the new local head. "fork"/"invalid": rejected
        // without touching the head, so the chain can't be corrupted; they
        // are dropped rather than stored (only a stored op whose PAYLOAD
        // fails to fold becomes a visible quarantine entry — see materialize).
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

  /**
   * Tear down and rebuild the transport after the identity or space changed
   * (pairing import, recovery restore).
   *
   * The new transport authenticates a DIFFERENT Gun user graph, so anything
   * this device published before is unreachable there: its own ops are
   * re-queued for publication. Without that, a device with pre-pairing
   * history would announce a head above ops the new peers can never fetch,
   * and its whole log would be permanently un-ingestable by them.
   */
  async restart(): Promise<void> {
    this.paused = true;
    try {
      // Let an in-flight cycle finish rather than cutting its publish run
      // partway and immediately re-publishing the same range.
      await this.running?.catch(() => undefined);
      for (const unsubscribe of this.unsubscribers) unsubscribe();
      this.unsubscribers = [];
      await this.transport.close();
      this.remoteHeads.clear();
      this.acksByDevice.clear();
      this.sawUnsupported = false;
      this.locked = false;
      await this.store.resetOwnPublished(this.entity);
      this.transport = this.makeTransport();
      this.subscribe();
    } finally {
      this.paused = false;
    }
    await this.syncNow().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    await this.running?.catch(() => undefined);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    await this.transport.close();
  }
}
