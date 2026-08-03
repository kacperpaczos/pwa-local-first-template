import Gun from "gun/gun";
import "gun/sea";
import "gun/lib/webrtc";
import type { IGunInstance, IGunUserInstance } from "gun";
import { ensurePair, type SeaPair } from "@/shared/identity";
import {
  parseSyncMutation,
  type ValidatedSyncMutation,
} from "./protocol";
import { NoopSyncTransport } from "./noop-transport";
import type {
  Conflict,
  PullResult,
  PushResult,
  SyncMutation,
  SyncTransport,
} from "./transport";

export type GunWireMutation = ValidatedSyncMutation & {
  seq: number;
};

type BufferedEntry = {
  seq: number;
  mutation: SyncMutation;
};

export type GunSyncTransportOptions = {
  peers: string[];
  /** Injected pair (tests). Default: ensurePair() from localStorage. */
  pair?: SeaPair;
  /** Injected Gun factory (tests). */
  createGun?: (peers: string[]) => IGunInstance;
};

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

function defaultCreateGun(peers: string[]): IGunInstance {
  return Gun({
    peers,
    localStorage: false,
  }) as unknown as IGunInstance;
}

/**
 * Gun-backed SyncTransport. OPFS remains source of truth; Gun only carries
 * signed mutations under the SEA user graph.
 */
export class GunSyncTransport implements SyncTransport {
  private readonly gun: IGunInstance;
  private readonly user: IGunUserInstance;
  private readonly buffer = new Map<string, BufferedEntry>();
  private ready: Promise<void>;
  private nextSeq = 1;
  private subscribed = false;
  private closed = false;

  constructor(private readonly options: GunSyncTransportOptions) {
    if (options.peers.length === 0) {
      throw new Error("GunSyncTransport requires at least one peer");
    }
    const createGun = options.createGun ?? defaultCreateGun;
    this.gun = createGun(options.peers);
    this.user = this.gun.user();
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const pair = this.options.pair ?? (await ensurePair());
    await authWithPair(this.user, pair);
    this.subscribe();
  }

  private notesRoot() {
    return this.user.get("app_sync").get("notes");
  }

  private subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    this.notesRoot()
      .map()
      .on((raw: unknown, key: string) => {
        if (this.closed || !raw || typeof raw !== "object" || key === "_") {
          return;
        }
        const row = raw as Record<string, unknown>;
        if (typeof row.payloadJson !== "string") {
          return;
        }
        const seq = Number(row.seq);
        if (!Number.isFinite(seq)) {
          return;
        }
        if (typeof row.idempotencyKey !== "string") {
          return;
        }

        let mutation: SyncMutation;
        try {
          mutation = parseSyncMutation({
            idempotencyKey: row.idempotencyKey,
            entity: row.entity,
            op: row.op,
            payload: JSON.parse(row.payloadJson) as unknown,
          });
        } catch {
          return;
        }

        const existing = this.buffer.get(mutation.idempotencyKey);
        if (existing && existing.seq >= seq) {
          return;
        }
        this.buffer.set(mutation.idempotencyKey, { seq, mutation });
        if (seq >= this.nextSeq) {
          this.nextSeq = seq + 1;
        }
      });
  }

  async push(outbox: readonly SyncMutation[]): Promise<PushResult> {
    await this.ready;
    if (this.closed) {
      return {
        accepted: [],
        rejected: outbox.map((m) => ({
          idempotencyKey: m.idempotencyKey,
          reason: "transport closed",
        })),
      };
    }

    const accepted: string[] = [];
    const rejected: { idempotencyKey: string; reason: string }[] = [];

    for (const item of outbox) {
      let validated: ValidatedSyncMutation;
      try {
        validated = parseSyncMutation(item);
      } catch (error) {
        rejected.push({
          idempotencyKey: item.idempotencyKey,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const seq = this.nextSeq++;
      const wire = {
        idempotencyKey: validated.idempotencyKey,
        entity: validated.entity,
        op: validated.op,
        payloadJson: JSON.stringify(validated.payload),
        seq,
      };

      try {
        await gunPut(this.notesRoot().get(validated.idempotencyKey), wire);
        this.buffer.set(validated.idempotencyKey, {
          seq,
          mutation: validated,
        });
        accepted.push(validated.idempotencyKey);
      } catch (error) {
        rejected.push({
          idempotencyKey: validated.idempotencyKey,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { accepted, rejected };
  }

  async pull(cursor: string | null): Promise<PullResult> {
    await this.ready;
    // Give the mesh a brief moment to deliver pending graph updates.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const after = cursor ? Number(cursor) : 0;
    const cursorNum = Number.isFinite(after) ? after : 0;

    const entries = [...this.buffer.values()]
      .filter((entry) => entry.seq > cursorNum)
      .sort((a, b) => a.seq - b.seq);

    const mutations = entries.map((e) => e.mutation);
    const nextCursor =
      entries.length > 0 ? String(entries[entries.length - 1]!.seq) : cursor;

    return { cursor: nextCursor, mutations };
  }

  async resolve(_conflicts: readonly Conflict[]): Promise<void> {
    // Merge happens in applyRemoteMutations / mergeNote.
  }

  async close(): Promise<void> {
    this.closed = true;
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

export function createSyncTransport(): SyncTransport {
  const peers = parseGunPeers(import.meta.env.VITE_GUN_PEERS as string | undefined);
  const fallbackPeers =
    peers.length === 0 && import.meta.env.DEV
      ? ["http://127.0.0.1:8765/gun"]
      : peers;

  if (fallbackPeers.length === 0) {
    return new NoopSyncTransport();
  }

  return new GunSyncTransport({ peers: fallbackPeers });
}
