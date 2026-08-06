import Gun from "gun/gun";
import "gun/lib/webrtc";
import type { IGunInstance, IGunUserInstance } from "gun";
import { open, seal } from "@/shared/crypto/envelope";
import { ensurePair, ensureSpace, type SeaPair } from "@/shared/identity";
import {
  isSupportedProtocolVersion,
  opFromWireRow,
  parseWireOpRow,
  wireRowFromOp,
  type WireOpRow,
} from "./protocol";
import {
  SpaceUnavailableError,
  type FetchResult,
  type HeadAnnouncement,
  type LogSyncTransport,
  type PublishableOp,
  type Unsubscribe,
} from "./transport";

const ROOT = "app_oplog";
const FETCH_WAIT_MS = 1500;

/** AES-GCM AAD binds the ciphertext to the signed header it travels with. */
function opAad(spaceId: string, opHash: string): string {
  return `oplog:${spaceId}:${opHash}`;
}

type SealedWire = { n: string; c: string };

function gunPut(
  chain: { put: (data: unknown, cb?: (ack: unknown) => void) => unknown },
  data: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    chain.put(data, (ack) => {
      const err = (ack as { err?: string } | null)?.err;
      if (err) {
        reject(new Error(String(err)));
        return;
      }
      resolve();
    });
  });
}

function authWithPair(user: IGunUserInstance, pair: SeaPair): Promise<void> {
  return new Promise((resolve, reject) => {
    user.auth(pair, (ack) => {
      const err = (ack as { err?: string })?.err;
      if (err) {
        reject(new Error(String(err)));
        return;
      }
      resolve();
    });
  });
}

/**
 * One Gun instance per page, shared across transport reinits — constructing
 * a new Gun per reinit leaked the previous instance's WS connection and
 * webrtc listeners (there is no supported way to fully dispose a Gun node).
 */
const sharedGunInstances = new Map<string, IGunInstance>();

function getSharedGun(
  peers: string[],
  createGun?: (peers: string[]) => IGunInstance,
): IGunInstance {
  const key = peers.join(",");
  const existing = sharedGunInstances.get(key);
  if (existing) return existing;
  const instance = createGun
    ? createGun(peers)
    : (Gun({ peers, localStorage: false }) as unknown as IGunInstance);
  sharedGunInstances.set(key, instance);
  return instance;
}

/** Test hook: drop cached instances so fakes don't leak between tests. */
export function resetSharedGunForTests(): void {
  sharedGunInstances.clear();
}

export type GunLogTransportOptions = {
  peers: string[];
  /** Injected for tests. */
  pair?: SeaPair;
  spaceKey?: CryptoKey;
  spaceId?: string;
  createGun?: (peers: string[]) => IGunInstance;
  fetchWaitMs?: number;
};

/**
 * Gun-backed LogSyncTransport. Layout under the SEA user graph:
 *
 *   app_oplog/<entity>/logs/<device>/<seq> → wire op row (opaque ciphertext)
 *   app_oplog/<entity>/heads/<device>      → { seq, hash }   (monotone — HAM LWW safe)
 *   app_oplog/<entity>/acks/<device>       → { json }        (deviceId → acked seq)
 *
 * Subscriptions cover only `heads`/`acks` — op rows are range-fetched on
 * demand, so boot cost no longer grows with lifetime edit count (the old
 * transport replayed and buffered every op ever written).
 *
 * Fails closed: without the space key the transport never falls back to a
 * weaker cipher — construction rejects with SpaceUnavailableError and the
 * engine surfaces a "locked" status.
 */
export class GunLogTransport implements LogSyncTransport {
  private readonly gun: IGunInstance;
  private readonly user: IGunUserInstance;
  private readonly readyPromise: Promise<void>;
  private readonly fetchWaitMs: number;
  private readonly unsubscribers = new Set<() => void>();
  private spaceKey!: CryptoKey;
  private spaceId!: string;
  private closed = false;

  constructor(private readonly options: GunLogTransportOptions) {
    if (options.peers.length === 0) {
      throw new Error("GunLogTransport requires at least one peer");
    }
    this.gun = getSharedGun(options.peers, options.createGun);
    this.user = this.gun.user();
    this.fetchWaitMs = options.fetchWaitMs ?? FETCH_WAIT_MS;
    this.readyPromise = this.bootstrap();
    // Surfaced via ready() at every call site; avoid unhandled-rejection noise.
    this.readyPromise.catch(() => undefined);
  }

  private async bootstrap(): Promise<void> {
    const pair = this.options.pair ?? (await ensurePair());

    if (this.options.spaceKey && this.options.spaceId) {
      this.spaceKey = this.options.spaceKey;
      this.spaceId = this.options.spaceId;
    } else {
      try {
        const space = await ensureSpace();
        this.spaceKey = space.key;
        this.spaceId = space.spaceId;
      } catch {
        throw new SpaceUnavailableError();
      }
    }

    await authWithPair(this.user, pair);
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  private entityRoot(entity: string) {
    return this.user.get(ROOT).get(entity);
  }

  private async sealPayload(opHash: string, payloadJson: string): Promise<string> {
    const sealed = await seal(
      new TextEncoder().encode(payloadJson),
      this.spaceKey,
      opAad(this.spaceId, opHash),
    );
    const wire: SealedWire = { n: sealed.nonce, c: sealed.ciphertext };
    return JSON.stringify(wire);
  }

  private async openPayload(opHash: string, ciphertext: string): Promise<Uint8Array | null> {
    try {
      const wire = JSON.parse(ciphertext) as Partial<SealedWire>;
      if (typeof wire?.n !== "string" || typeof wire?.c !== "string") return null;
      return await open(
        { nonce: wire.n, ciphertext: wire.c },
        this.spaceKey,
        opAad(this.spaceId, opHash),
      );
    } catch {
      return null;
    }
  }

  async publish(entity: string, ops: readonly PublishableOp[]): Promise<void> {
    await this.readyPromise;
    if (this.closed || ops.length === 0) return;

    const root = this.entityRoot(entity);
    let head: { device: string; seq: number; hash: string } | null = null;

    for (const { op, payloadJson } of ops) {
      const ciphertext = await this.sealPayload(op.hash, payloadJson);
      const row = wireRowFromOp(op, ciphertext);
      await gunPut(root.get("logs").get(op.header.publicKey).get(String(op.header.seq)), row);
      if (!head || op.header.seq > head.seq) {
        head = { device: op.header.publicKey, seq: op.header.seq, hash: op.hash };
      }
    }

    if (head) {
      // Announced only AFTER all rows are durably put — a peer that sees the
      // head can fetch every row at or below it.
      await gunPut(root.get("heads").get(head.device), { seq: head.seq, hash: head.hash });
    }
  }

  async publishAcks(entity: string, device: string, acks: Record<string, number>): Promise<void> {
    await this.readyPromise;
    if (this.closed) return;
    await gunPut(this.entityRoot(entity).get("acks").get(device), { json: JSON.stringify(acks) });
  }

  subscribeHeads(entity: string, cb: (head: HeadAnnouncement) => void): Unsubscribe {
    let active = true;
    let off: (() => void) | null = null;

    void this.readyPromise.then(() => {
      if (!active || this.closed) return;
      const chain = this.entityRoot(entity)
        .get("heads")
        .map()
        .on((raw: unknown, device: string, _msg: unknown, ev?: { off?: () => void }) => {
          if (ev?.off && !off) {
            off = () => ev.off?.();
            if (!active) off();
          }
          if (!raw || typeof raw !== "object" || device === "_") return;
          const row = raw as { seq?: unknown; hash?: unknown };
          const seq = Number(row.seq);
          if (!Number.isInteger(seq) || seq < 1 || typeof row.hash !== "string") return;
          cb({ device, seq, hash: row.hash });
        });
      void chain;
    });

    const unsubscribe = () => {
      active = false;
      off?.();
      this.unsubscribers.delete(unsubscribe);
    };
    this.unsubscribers.add(unsubscribe);
    return unsubscribe;
  }

  subscribeAcks(
    entity: string,
    cb: (device: string, acks: Record<string, number>) => void,
  ): Unsubscribe {
    let active = true;
    let off: (() => void) | null = null;

    void this.readyPromise.then(() => {
      if (!active || this.closed) return;
      this.entityRoot(entity)
        .get("acks")
        .map()
        .on((raw: unknown, device: string, _msg: unknown, ev?: { off?: () => void }) => {
          if (ev?.off && !off) {
            off = () => ev.off?.();
            if (!active) off();
          }
          if (!raw || typeof raw !== "object" || device === "_") return;
          const json = (raw as { json?: unknown }).json;
          if (typeof json !== "string") return;
          try {
            const parsed = JSON.parse(json) as Record<string, unknown>;
            const acks: Record<string, number> = {};
            for (const [key, value] of Object.entries(parsed)) {
              if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
                acks[key] = value;
              }
            }
            cb(device, acks);
          } catch {
            /* corrupt ack row — ignore */
          }
        });
    });

    const unsubscribe = () => {
      active = false;
      off?.();
      this.unsubscribers.delete(unsubscribe);
    };
    this.unsubscribers.add(unsubscribe);
    return unsubscribe;
  }

  async fetchOps(
    entity: string,
    device: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<FetchResult> {
    await this.readyPromise;
    const result: FetchResult = { ops: [], sawUnsupportedVersion: false };
    if (this.closed || toSeq < fromSeq) return result;

    const log = this.entityRoot(entity).get("logs").get(device);

    for (let seq = fromSeq; seq <= toSeq; seq++) {
      const raw = await this.onceWithTimeout(log.get(String(seq)));
      if (!raw || typeof raw !== "object") continue;

      let row: WireOpRow;
      try {
        row = parseWireOpRow(raw);
      } catch {
        continue;
      }
      if (!isSupportedProtocolVersion(row.v)) {
        result.sawUnsupportedVersion = true;
        continue;
      }

      const payloadBytes = await this.openPayload(row.hash, row.ciphertext);
      if (!payloadBytes) continue;
      result.ops.push({ op: opFromWireRow(row), payloadBytes });
    }

    return result;
  }

  private onceWithTimeout(chain: {
    once: (cb: (data: unknown) => void, opts?: { wait?: number }) => unknown;
  }): Promise<unknown> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
      }, this.fetchWaitMs);
      chain.once(
        (data) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(data);
          }
        },
        { wait: Math.min(this.fetchWaitMs, 500) },
      );
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const unsubscribe of [...this.unsubscribers]) {
      unsubscribe();
    }
    try {
      this.user.leave();
    } catch {
      /* ignore */
    }
  }
}

export function parseGunPeers(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
