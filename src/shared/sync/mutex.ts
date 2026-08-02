import type { PullResult, PushResult, SyncTransport } from "./transport";

/**
 * Ensures only one sync loop runs at a time (avoids sync storms / duplicates).
 */
export class SyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

export async function runSyncCycle(
  transport: SyncTransport,
  mutex: SyncMutex,
  options: {
    cursor: string | null;
    outbox: Parameters<SyncTransport["push"]>[0];
  },
): Promise<{ push: PushResult; pull: PullResult }> {
  return mutex.runExclusive(async () => {
    const push = await transport.push(options.outbox);
    const pull = await transport.pull(options.cursor);
    return { push, pull };
  });
}
