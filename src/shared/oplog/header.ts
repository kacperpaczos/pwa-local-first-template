import { ed25519 } from "@noble/curves/ed25519.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { base64UrlToBytes, bytesToBase64Url } from "@/shared/crypto/bytes";

/**
 * p2panda-shaped operation header (see docs/adr/010-per-device-op-log.md).
 *
 * Deliberate deltas from p2panda-core v0.7, closed in v0.2:
 * - canonical sorted-key JSON instead of CBOR/Postcard,
 * - `timestamp` in milliseconds instead of seconds,
 * - no `previous` (cross-log causal deps) — single-entity logs don't need it.
 */
export const OPLOG_VERSION = 3 as const;

export type OpHeader = {
  v: typeof OPLOG_VERSION;
  /** base64url ed25519 public key of the authoring DEVICE (= deviceId). */
  publicKey: string;
  /** Log partition, e.g. "notes". One append-only log per (entity, device). */
  entity: string;
  /** 1-based position in this device's log for this entity. */
  seq: number;
  /** Hash of the previous op in this log; null only at seq 1. */
  backlink: string | null;
  /** ms since epoch — advisory only, never used for conflict resolution. */
  timestamp: number;
  /** base64url blake3 of the PLAINTEXT payload bytes. */
  payloadHash: string;
  payloadSize: number;
};

export type Operation = {
  /** base64url blake3 of the canonical header bytes — the op's identity. */
  hash: string;
  header: OpHeader;
  /** base64url ed25519 signature over the canonical header bytes. */
  signature: string;
};

/**
 * Canonical encoding: JSON with keys sorted lexicographically. The header is
 * flat, so one level of sorting is enough for byte-stable output across
 * replicas. (v0.2: CBOR via p2panda-core.)
 */
export function encodeHeader(header: OpHeader): Uint8Array {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(header).sort()) {
    sorted[key] = header[key as keyof OpHeader];
  }
  return new TextEncoder().encode(JSON.stringify(sorted));
}

export function hashBytes(bytes: Uint8Array): string {
  return bytesToBase64Url(blake3(bytes));
}

export function hashPayload(payloadBytes: Uint8Array): string {
  return hashBytes(payloadBytes);
}

export type CreateOperationArgs = {
  entity: string;
  seq: number;
  backlink: string | null;
  payloadBytes: Uint8Array;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  timestamp?: number;
};

export function createOperation(args: CreateOperationArgs): Operation {
  if (!Number.isInteger(args.seq) || args.seq < 1) {
    throw new Error(`Op seq must be a positive integer, got ${args.seq}`);
  }
  if ((args.seq === 1) !== (args.backlink === null)) {
    throw new Error("backlink must be null exactly at seq 1");
  }
  const header: OpHeader = {
    v: OPLOG_VERSION,
    publicKey: bytesToBase64Url(args.publicKey),
    entity: args.entity,
    seq: args.seq,
    backlink: args.backlink,
    timestamp: args.timestamp ?? Date.now(),
    payloadHash: hashPayload(args.payloadBytes),
    payloadSize: args.payloadBytes.byteLength,
  };
  const headerBytes = encodeHeader(header);
  return {
    hash: hashBytes(headerBytes),
    header,
    signature: bytesToBase64Url(ed25519.sign(headerBytes, args.secretKey)),
  };
}

/**
 * Full structural verification: header hash matches, signature verifies
 * against the embedded public key, and (when the payload is at hand) the
 * payload hash and size match. Returns false instead of throwing — callers
 * quarantine, they don't crash.
 */
export function verifyOperation(op: Operation, payloadBytes?: Uint8Array): boolean {
  try {
    if (op.header.v !== OPLOG_VERSION) return false;
    const headerBytes = encodeHeader(op.header);
    if (hashBytes(headerBytes) !== op.hash) return false;
    const ok = ed25519.verify(
      base64UrlToBytes(op.signature),
      headerBytes,
      base64UrlToBytes(op.header.publicKey),
    );
    if (!ok) return false;
    if (payloadBytes !== undefined) {
      if (payloadBytes.byteLength !== op.header.payloadSize) return false;
      if (hashPayload(payloadBytes) !== op.header.payloadHash) return false;
    }
    return true;
  } catch {
    return false;
  }
}
