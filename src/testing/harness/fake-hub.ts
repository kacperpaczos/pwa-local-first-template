import type {
  FetchResult,
  HeadAnnouncement,
  LogSyncTransport,
  PublishableOp,
  PublishResult,
  Unsubscribe,
} from "@/shared/sync/transport";

/**
 * In-memory hub shared by every FakeHubTransport — the "mesh". No crypto:
 * payloads travel as plaintext bytes; encryption is the Gun transport's
 * concern and is covered in gun-log-transport.test.ts.
 *
 * Test-only: nothing under `src/testing/` is imported by app code, and it is
 * excluded from coverage. Two FakeHub instances model two disjoint spaces
 * (see the pairing/restart case in engine.test.ts).
 */
export class FakeHub {
  rows = new Map<string, { op: PublishableOp["op"]; payloadJson: string }>();
  heads = new Map<string, HeadAnnouncement>();
  acks = new Map<string, Record<string, number>>();
  headListeners = new Set<(head: HeadAnnouncement) => void>();
  ackListeners = new Set<(device: string, acks: Record<string, number>) => void>();
  /** Rows temporarily invisible to fetch — simulates relay propagation lag. */
  hidden = new Set<string>();

  key(entity: string, device: string, seq: number): string {
    return `${entity}/${device}/${seq}`;
  }
}

export class FakeHubTransport implements LogSyncTransport {
  constructor(private readonly hub: FakeHub) {}

  async ready(): Promise<void> {}

  async publish(entity: string, ops: readonly PublishableOp[]): Promise<PublishResult> {
    let head: HeadAnnouncement | null = null;
    const publishedHashes: string[] = [];
    for (const { op, payloadJson } of ops) {
      this.hub.rows.set(this.hub.key(entity, op.header.publicKey, op.header.seq), {
        op,
        payloadJson,
      });
      publishedHashes.push(op.hash);
      if (!head || op.header.seq > head.seq) {
        head = { device: op.header.publicKey, seq: op.header.seq, hash: op.hash };
      }
    }
    if (head) {
      this.hub.heads.set(`${entity}/${head.device}`, head);
      for (const listener of this.hub.headListeners) listener(head);
    }
    return { publishedHashes };
  }

  async publishAcks(_entity: string, device: string, acks: Record<string, number>): Promise<void> {
    this.hub.acks.set(device, acks);
    for (const listener of this.hub.ackListeners) listener(device, acks);
  }

  subscribeHeads(entity: string, cb: (head: HeadAnnouncement) => void): Unsubscribe {
    this.hub.headListeners.add(cb);
    for (const [key, head] of this.hub.heads) {
      if (key.startsWith(`${entity}/`)) cb(head);
    }
    return () => this.hub.headListeners.delete(cb);
  }

  subscribeAcks(
    _entity: string,
    cb: (device: string, acks: Record<string, number>) => void,
  ): Unsubscribe {
    this.hub.ackListeners.add(cb);
    for (const [device, acks] of this.hub.acks) cb(device, acks);
    return () => this.hub.ackListeners.delete(cb);
  }

  async fetchOps(
    entity: string,
    device: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<FetchResult> {
    const ops: FetchResult["ops"] = [];
    for (let seq = fromSeq; seq <= toSeq; seq++) {
      const key = this.hub.key(entity, device, seq);
      if (this.hub.hidden.has(key)) continue;
      const row = this.hub.rows.get(key);
      if (!row) continue;
      ops.push({ op: row.op, payloadBytes: new TextEncoder().encode(row.payloadJson) });
    }
    return { ops, sawUnsupportedVersion: false };
  }

  async close(): Promise<void> {}
}
