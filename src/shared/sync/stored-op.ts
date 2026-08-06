import { hashPayload, OPLOG_VERSION, type Operation } from "@/shared/oplog/header";
import type { StoredOp } from "@/shared/store/oplog-persistence";

/**
 * Rebuild the signed Operation from its persisted row. `payloadJson` is the
 * exact plaintext the header was signed over (append and ingest both store
 * it verbatim), so payloadHash/payloadSize are recomputed, not persisted.
 */
export function opFromStored(row: StoredOp): Operation {
  const payloadBytes = new TextEncoder().encode(row.payloadJson);
  return {
    hash: row.hash,
    header: {
      v: OPLOG_VERSION,
      publicKey: row.device,
      entity: row.entity,
      seq: row.seq,
      backlink: row.backlink,
      timestamp: row.timestamp,
      payloadHash: hashPayload(payloadBytes),
      payloadSize: payloadBytes.byteLength,
    },
    signature: row.signature,
  };
}
