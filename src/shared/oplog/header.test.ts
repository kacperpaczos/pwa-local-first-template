import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "@/shared/identity/device";
import {
  createOperation,
  encodeHeader,
  hashBytes,
  verifyOperation,
  type Operation,
} from "./header";

const device = generateDeviceKey();
const payload = new TextEncoder().encode(JSON.stringify({ kind: "upsert", note: { id: "n1" } }));

function makeOp(overrides?: { seq?: number; backlink?: string | null }): Operation {
  return createOperation({
    entity: "notes",
    seq: overrides?.seq ?? 1,
    backlink: overrides?.backlink !== undefined ? overrides.backlink : null,
    payloadBytes: payload,
    publicKey: device.publicKey,
    secretKey: device.secretKey,
    timestamp: 1_750_000_000_000,
  });
}

describe("oplog header", () => {
  it("canonical encoding is key-order independent", () => {
    const op = makeOp();
    const shuffled = Object.fromEntries(Object.entries(op.header).reverse()) as Operation["header"];
    expect(encodeHeader(shuffled)).toEqual(encodeHeader(op.header));
  });

  it("hash is deterministic and bound to the header bytes", () => {
    const a = makeOp();
    const b = makeOp();
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(hashBytes(encodeHeader(a.header)));
  });

  it("verifies a genuine op with and without payload bytes", () => {
    const op = makeOp();
    expect(verifyOperation(op)).toBe(true);
    expect(verifyOperation(op, payload)).toBe(true);
  });

  it("rejects a tampered header field", () => {
    const op = makeOp();
    const tampered: Operation = { ...op, header: { ...op.header, seq: 2, backlink: op.hash } };
    expect(verifyOperation(tampered)).toBe(false);
  });

  it("rejects a signature from a different device", () => {
    const op = makeOp();
    const other = createOperation({
      entity: "notes",
      seq: 1,
      backlink: null,
      payloadBytes: payload,
      publicKey: generateDeviceKey().publicKey,
      secretKey: generateDeviceKey().secretKey,
      timestamp: op.header.timestamp,
    });
    const franken: Operation = { ...op, signature: other.signature };
    expect(verifyOperation(franken)).toBe(false);
  });

  it("rejects payload bytes that do not match hash or size", () => {
    const op = makeOp();
    expect(verifyOperation(op, new TextEncoder().encode("{}"))).toBe(false);
    const padded = new Uint8Array(payload.byteLength);
    padded.set(payload.subarray(1));
    expect(verifyOperation(op, padded)).toBe(false);
  });

  it("rejects garbage without throwing", () => {
    const op = makeOp();
    expect(verifyOperation({ ...op, signature: "!!not-base64url!!" })).toBe(false);
    expect(verifyOperation({ ...op, header: { ...op.header, publicKey: "AAAA" } })).toBe(false);
  });

  it("enforces the seq/backlink invariant at creation", () => {
    expect(() => makeOp({ seq: 0 })).toThrow(/positive integer/);
    expect(() => makeOp({ seq: 2, backlink: null })).toThrow(/backlink/);
    expect(() => makeOp({ seq: 1, backlink: "abc" })).toThrow(/backlink/);
  });

  it("chains: seq 2 verifies with the hash of seq 1 as backlink", () => {
    const first = makeOp();
    const second = createOperation({
      entity: "notes",
      seq: 2,
      backlink: first.hash,
      payloadBytes: payload,
      publicKey: device.publicKey,
      secretKey: device.secretKey,
      timestamp: 1_750_000_000_001,
    });
    expect(verifyOperation(second)).toBe(true);
    expect(second.header.backlink).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });
});
