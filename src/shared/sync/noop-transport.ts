import type { Conflict, PullResult, PushResult, SyncMutation, SyncTransport } from "./transport";

/** Local-only transport — accepts everything, returns empty pulls. */
export class NoopSyncTransport implements SyncTransport {
  async push(outbox: readonly SyncMutation[]): Promise<PushResult> {
    return {
      accepted: outbox.map((m) => m.idempotencyKey),
      rejected: [],
    };
  }

  async pull(_cursor: string | null): Promise<PullResult> {
    return { cursor: null, mutations: [] };
  }

  async resolve(_conflicts: readonly Conflict[]): Promise<void> {
    // No conflicts in noop mode.
  }
}
