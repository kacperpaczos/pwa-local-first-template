import type {
  FetchResult,
  HeadAnnouncement,
  LogSyncTransport,
  PublishableOp,
  PublishResult,
  Unsubscribe,
} from "./transport";

/**
 * Local-only transport (no peers configured) — observes nothing and,
 * critically, reports that it published nothing. Ops stay queued in the log
 * so that configuring a relay later ships the full history instead of
 * announcing a head above a hole every peer would see as an eternal gap.
 */
export class NoopLogTransport implements LogSyncTransport {
  async ready(): Promise<void> {}

  async publish(_entity: string, _ops: readonly PublishableOp[]): Promise<PublishResult> {
    return { publishedHashes: [] };
  }

  async publishAcks(
    _entity: string,
    _device: string,
    _acks: Record<string, number>,
  ): Promise<void> {}

  subscribeHeads(_entity: string, _cb: (head: HeadAnnouncement) => void): Unsubscribe {
    return () => {};
  }

  subscribeAcks(
    _entity: string,
    _cb: (device: string, acks: Record<string, number>) => void,
  ): Unsubscribe {
    return () => {};
  }

  async fetchOps(): Promise<FetchResult> {
    return { ops: [], sawUnsupportedVersion: false };
  }

  async close(): Promise<void> {}
}
