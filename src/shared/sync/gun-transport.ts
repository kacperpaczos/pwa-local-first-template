import Gun from "gun/gun";
import "gun/lib/webrtc";
import SEA from "gun/sea";
import type { IGunInstance, IGunUserInstance } from "gun";
import { ensureOriginId, ensurePair, ensureSpace, type SeaPair } from "@/shared/identity";
import { open, seal, type SealedBlob } from "@/shared/crypto/envelope";
import {
  isSupportedProtocolVersion,
  parseSyncMutation,
  PROTOCOL_VERSION,
  type ValidatedSyncMutation,
} from "./protocol";
import { setSyncStatus } from "./status";
import { NoopSyncTransport } from "./noop-transport";
import type { Conflict, PullResult, PushResult, SyncMutation, SyncTransport } from "./transport";

export type GunWireMutation = ValidatedSyncMutation & {
  seq: number;
  origin: string;
};

type BufferedEntry = {
  seq: number;
  origin: string;
  mutation: SyncMutation;
};

/** Pull cursor: per-origin high-water mark (a small vector clock), so that
 * two devices independently numbering their own `seq` from 1 can never
 * shadow each other's mutations — see docs/adr for the collision this
 * replaced (a single global numeric watermark silently dropped mutations
 * from whichever origin's counter lagged behind another's). */
type CursorMap = Record<string, number>;

function parseCursorMap(cursor: string | null): CursorMap {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: CursorMap = {};
    for (const [origin, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        out[origin] = value;
      }
    }
    return out;
  } catch {
    // Legacy (pre-v2) cursor was a plain numeric string, or the value is
    // otherwise unparsable — start from an empty map. Safe: mutations are
    // idempotent, so a one-time full re-pull just redoes already-applied
    // no-op merges instead of silently dropping anything.
    return {};
  }
}

export type GunSyncTransportOptions = {
  peers: string[];
  /** Injected pair (tests). Default: ensurePair() from localStorage. */
  pair?: SeaPair;
  /** Injected per-device origin id (tests). Default: ensureOriginId() from localStorage. */
  origin?: string;
  /**
   * Injected space key (tests). Default: ensureSpace() from localStorage.
   * When present, mutation payloads are AES-GCM sealed with this key.
   * Legacy rows remain SEA-encrypted; decrypt tries space open first, then SEA.decrypt.
   */
  spaceKey?: CryptoKey;
  spaceId?: string;
  /** Injected Gun factory (tests). */
  createGun?: (peers: string[]) => IGunInstance;
};

/** Wire marker for AES-GCM space-key ciphertext (JSON string in `ciphertext`). */
type SpaceWireCiphertext = {
  k: "space";
  n: string;
  c: string;
};

function encodeSpaceCiphertext(sealed: SealedBlob): string {
  const wire: SpaceWireCiphertext = {
    k: "space",
    n: sealed.nonce,
    c: sealed.ciphertext,
  };
  return JSON.stringify(wire);
}

function tryParseSpaceCiphertext(ciphertext: string): SealedBlob | null {
  if (!ciphertext.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(ciphertext) as Partial<SpaceWireCiphertext>;
    if (
      parsed &&
      parsed.k === "space" &&
      typeof parsed.n === "string" &&
      typeof parsed.c === "string"
    ) {
      return { nonce: parsed.n, ciphertext: parsed.c };
    }
  } catch {
    /* not space-wire JSON */
  }
  return null;
}

function spaceAad(spaceId: string): string {
  return `gun-sync:${spaceId}`;
}

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
 * encrypted mutations under the SEA user graph.
 *
 * Encryption (backward compatible):
 * - If a space key is available → AES-GCM seal (envelope) of JSON payload.
 * - Else → SEA.encrypt with the device pair (legacy).
 * Decryption tries space-key open first when the wire looks like space ciphertext,
 * then falls back to SEA.decrypt so older peers keep working.
 */
export class GunSyncTransport implements SyncTransport {
  private readonly gun: IGunInstance;
  private readonly user: IGunUserInstance;
  private readonly buffer = new Map<string, BufferedEntry>();
  private ready: Promise<void>;
  private nextSeq = 1;
  private subscribed = false;
  private closed = false;
  /** Set once bootstrap() resolves the pair; every paired device shares the
   * same pair, so pair.epriv doubles as the symmetric content-encryption key
   * for legacy SEA.encrypt/decrypt rows. */
  private pair!: SeaPair;
  private origin!: string;
  private spaceKey: CryptoKey | null = null;
  private spaceId: string | null = null;

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
    this.pair = pair;
    this.origin = this.options.origin ?? ensureOriginId();

    if (this.options.spaceKey && this.options.spaceId) {
      this.spaceKey = this.options.spaceKey;
      this.spaceId = this.options.spaceId;
    } else {
      try {
        const space = await ensureSpace();
        this.spaceKey = space.key;
        this.spaceId = space.spaceId;
      } catch {
        this.spaceKey = null;
        this.spaceId = null;
      }
    }

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
        if (typeof row.ciphertext !== "string") {
          return;
        }
        const seq = Number(row.seq);
        if (!Number.isFinite(seq)) {
          return;
        }
        if (typeof row.idempotencyKey !== "string") {
          return;
        }

        const v = Number(row.v);
        if (!isSupportedProtocolVersion(v)) {
          setSyncStatus("outdated");
          return;
        }

        if (typeof row.origin !== "string" || row.origin.length === 0) {
          return;
        }

        void this.decryptRow(row, seq, row.origin, v);
      });
  }

  private async decryptPayload(ciphertext: string): Promise<unknown | undefined> {
    const spaceSealed = tryParseSpaceCiphertext(ciphertext);
    if (spaceSealed && this.spaceKey && this.spaceId) {
      try {
        const pt = await open(spaceSealed, this.spaceKey, spaceAad(this.spaceId));
        return JSON.parse(new TextDecoder().decode(pt)) as unknown;
      } catch {
        /* wrong space key or corrupt — try SEA fallback */
      }
    }

    try {
      return await SEA.decrypt(ciphertext, this.pair);
    } catch {
      return undefined;
    }
  }

  private async decryptRow(
    row: Record<string, unknown>,
    seq: number,
    origin: string,
    v: number,
  ): Promise<void> {
    if (this.closed || typeof row.ciphertext !== "string") return;

    const payload = await this.decryptPayload(row.ciphertext);
    if (!payload || typeof payload !== "object") {
      return;
    }

    let mutation: SyncMutation;
    try {
      mutation = parseSyncMutation({
        v,
        idempotencyKey: row.idempotencyKey,
        entity: row.entity,
        op: row.op,
        payload,
      });
    } catch {
      return;
    }

    // Same idempotencyKey is always pushed by the same origin (one writer
    // per mutation) — a lower/equal seq here just means Gun re-delivered
    // the same row, not a new mutation.
    const existing = this.buffer.get(mutation.idempotencyKey);
    if (existing && existing.seq >= seq) {
      return;
    }
    this.buffer.set(mutation.idempotencyKey, { seq, origin, mutation });
  }

  private async encryptPayload(payload: unknown): Promise<string | null> {
    if (this.spaceKey && this.spaceId) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const sealed = await seal(bytes, this.spaceKey, spaceAad(this.spaceId));
      return encodeSpaceCiphertext(sealed);
    }

    // SEA.encrypt/decrypt already (de)serialize non-string data internally
    // (via Gun's S.parse), so the round trip yields the payload object
    // directly — no JSON.stringify/JSON.parse needed on our end.
    const ciphertext = await SEA.encrypt(payload, this.pair);
    return typeof ciphertext === "string" ? ciphertext : null;
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
      const ciphertext = await this.encryptPayload(validated.payload);
      if (typeof ciphertext !== "string") {
        rejected.push({
          idempotencyKey: validated.idempotencyKey,
          reason: "encryption failed",
        });
        continue;
      }
      const wire = {
        v: PROTOCOL_VERSION,
        idempotencyKey: validated.idempotencyKey,
        entity: validated.entity,
        op: validated.op,
        ciphertext,
        seq,
        origin: this.origin,
      };

      try {
        await gunPut(this.notesRoot().get(validated.idempotencyKey), wire);
        this.buffer.set(validated.idempotencyKey, {
          seq,
          origin: this.origin,
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

    const cursorMap = parseCursorMap(cursor);

    const entries = [...this.buffer.values()]
      .filter((entry) => entry.seq > (cursorMap[entry.origin] ?? 0))
      .sort((a, b) => (a.origin === b.origin ? a.seq - b.seq : a.origin < b.origin ? -1 : 1));

    const mutations = entries.map((e) => e.mutation);

    if (entries.length === 0) {
      return { cursor, mutations };
    }

    const nextCursorMap: CursorMap = { ...cursorMap };
    for (const entry of entries) {
      nextCursorMap[entry.origin] = Math.max(nextCursorMap[entry.origin] ?? 0, entry.seq);
    }

    return { cursor: JSON.stringify(nextCursorMap), mutations };
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
    peers.length === 0 && import.meta.env.DEV ? ["http://127.0.0.1:8765/gun"] : peers;

  if (fallbackPeers.length === 0) {
    return new NoopSyncTransport();
  }

  return new GunSyncTransport({ peers: fallbackPeers });
}
