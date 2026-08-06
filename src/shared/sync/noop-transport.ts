import type {
  FetchResult,
  HeadAnnouncement,
  LogSyncTransport,
  PublishableOp,
  Unsubscribe,
} from "./transport";

/** Local-only transport — accepts every publish, observes nothing. */
export class NoopLogTransport implements LogSyncTransport {
  async ready(): Promise<void> {}

  async publish(_entity: string, _ops: readonly PublishableOp[]): Promise<void> {}

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
