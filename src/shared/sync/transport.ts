import type { Operation } from "@/shared/oplog/header";

/** An op ready to publish: signed header + PLAINTEXT payload (transport seals it). */
export type PublishableOp = {
  op: Operation;
  payloadJson: string;
};

/** An op fetched from the mesh: signed header + decrypted payload bytes. */
export type FetchedOp = {
  op: Operation;
  payloadBytes: Uint8Array;
};

export type HeadAnnouncement = {
  device: string;
  seq: number;
  hash: string;
};

export type FetchResult = {
  ops: FetchedOp[];
  /** A row in range carried a protocol version this client cannot ingest. */
  sawUnsupportedVersion: boolean;
};

export type Unsubscribe = () => void;

/**
 * Swappable log-sync adapter (the designated p2panda-net seam): announces
 * and observes per-device log heads, ships op ranges, and relays GC acks.
 * The transport owns payload encryption; everything above it sees plaintext.
 */
export interface LogSyncTransport {
  /** Resolves when the transport is authenticated and subscribable. */
  ready(): Promise<void>;
  /** Publish op rows, then bump this device's announced head (monotone). */
  publish(entity: string, ops: readonly PublishableOp[]): Promise<void>;
  /** Publish `device`'s ack map (other deviceId → acked seq of that device's log). */
  publishAcks(entity: string, device: string, acks: Record<string, number>): Promise<void>;
  subscribeHeads(entity: string, cb: (head: HeadAnnouncement) => void): Unsubscribe;
  subscribeAcks(
    entity: string,
    cb: (device: string, acks: Record<string, number>) => void,
  ): Unsubscribe;
  /** Fetch ops [fromSeq..toSeq] of one device's log. May be partial — the engine retries. */
  fetchOps(entity: string, device: string, fromSeq: number, toSeq: number): Promise<FetchResult>;
  close(): Promise<void>;
}

/** Thrown by transports that cannot decrypt/encrypt because the space key is missing. */
export class SpaceUnavailableError extends Error {
  readonly name = "SpaceUnavailableError";

  constructor() {
    super("Space key unavailable — pair this device or restore a recovery bundle");
  }
}
