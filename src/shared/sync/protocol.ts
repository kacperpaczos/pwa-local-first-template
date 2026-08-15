import * as z from "zod/mini";
import { OPLOG_VERSION, type OpHeader, type Operation } from "@/shared/oplog/header";

/**
 * Wire protocol v3: per-device append-only op logs (clean break from the
 * retired v2 snapshot-mutation rows — old `app_sync` graph data is ignored).
 * One wire row carries one signed op header plus the sealed payload.
 */
export const PROTOCOL_VERSION = OPLOG_VERSION;

/** Inclusive bounds of versions this client can ingest. */
export const SUPPORTED_MIN_V = 3;
export const SUPPORTED_MAX_V = 3;

export function isSupportedProtocolVersion(v: number): boolean {
  return Number.isInteger(v) && v >= SUPPORTED_MIN_V && v <= SUPPORTED_MAX_V;
}

/**
 * Flat primitives only — Gun cannot store nested objects without turning
 * them into sub-node references. `backlink: ""` encodes null (Gun treats a
 * null field value as a key tombstone).
 */
export const wireOpRowSchema = z.object({
  v: z.number(),
  hash: z.string().check(z.minLength(1)),
  pub: z.string().check(z.minLength(1)),
  entity: z.string().check(z.minLength(1)),
  seq: z.number(),
  backlink: z.string(),
  ts: z.number(),
  phash: z.string().check(z.minLength(1)),
  psize: z.number(),
  sig: z.string().check(z.minLength(1)),
  /** Space-key AES-GCM ciphertext of the plaintext payload (JSON envelope). */
  ciphertext: z.string().check(z.minLength(1)),
});

export type WireOpRow = z.infer<typeof wireOpRowSchema>;

export function parseWireOpRow(data: unknown): WireOpRow {
  return wireOpRowSchema.parse(data);
}

export function wireRowFromOp(op: Operation, ciphertext: string): WireOpRow {
  return {
    v: op.header.v,
    hash: op.hash,
    pub: op.header.publicKey,
    entity: op.header.entity,
    seq: op.header.seq,
    backlink: op.header.backlink ?? "",
    ts: op.header.timestamp,
    phash: op.header.payloadHash,
    psize: op.header.payloadSize,
    sig: op.signature,
    ciphertext,
  };
}

/**
 * Rebuild the signed Operation from a validated wire row (v already checked).
 *
 * Stamping `OPLOG_VERSION` rather than `row.v` is only safe while the
 * supported range is a single version: the version is part of the signed,
 * hashed header, so widening `[SUPPORTED_MIN_V, SUPPORTED_MAX_V]` without
 * carrying `row.v` through here would make every non-current row fail hash
 * verification at ingest.
 */
export function opFromWireRow(row: WireOpRow): Operation {
  const header: OpHeader = {
    v: OPLOG_VERSION,
    publicKey: row.pub,
    entity: row.entity,
    seq: row.seq,
    backlink: row.backlink === "" ? null : row.backlink,
    timestamp: row.ts,
    payloadHash: row.phash,
    payloadSize: row.psize,
  };
  return { hash: row.hash, header, signature: row.sig };
}
