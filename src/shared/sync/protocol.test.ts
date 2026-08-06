import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "../identity/device";
import { createOperation, verifyOperation } from "../oplog/header";
import {
  isSupportedProtocolVersion,
  opFromWireRow,
  parseWireOpRow,
  PROTOCOL_VERSION,
  SUPPORTED_MAX_V,
  SUPPORTED_MIN_V,
  wireRowFromOp,
} from "./protocol";

const device = generateDeviceKey();
const payload = new TextEncoder().encode(JSON.stringify({ kind: "upsert", note: { id: "n1" } }));

function makeOp(seq = 1, backlink: string | null = null) {
  return createOperation({
    entity: "notes",
    seq,
    backlink,
    payloadBytes: payload,
    publicKey: device.publicKey,
    secretKey: device.secretKey,
    timestamp: 1_750_000_000_000,
  });
}

describe("wire protocol v3", () => {
  it("bounds are exactly v3", () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(isSupportedProtocolVersion(3)).toBe(true);
    expect(isSupportedProtocolVersion(SUPPORTED_MIN_V - 1)).toBe(false);
    expect(isSupportedProtocolVersion(SUPPORTED_MAX_V + 1)).toBe(false);
    expect(isSupportedProtocolVersion(2.5)).toBe(false);
  });

  it("round-trips an op through the wire row, signature intact", () => {
    const op = makeOp();
    const row = parseWireOpRow(wireRowFromOp(op, "ciphertext-blob"));
    const back = opFromWireRow(row);
    expect(back).toEqual(op);
    expect(verifyOperation(back, payload)).toBe(true);
  });

  it('encodes a null backlink as "" on the wire (Gun treats null as key deletion)', () => {
    const genesis = makeOp();
    expect(wireRowFromOp(genesis, "c").backlink).toBe("");
    expect(opFromWireRow(parseWireOpRow(wireRowFromOp(genesis, "c"))).header.backlink).toBeNull();

    const second = makeOp(2, genesis.hash);
    const row = parseWireOpRow(wireRowFromOp(second, "c"));
    expect(row.backlink).toBe(genesis.hash);
    expect(opFromWireRow(row).header.backlink).toBe(genesis.hash);
  });

  it("rejects rows missing required fields", () => {
    const row = wireRowFromOp(makeOp(), "c");
    expect(() => parseWireOpRow({ ...row, hash: "" })).toThrow();
    expect(() => parseWireOpRow({ ...row, ciphertext: "" })).toThrow();
    expect(() => parseWireOpRow({ ...row, sig: undefined })).toThrow();
  });
});
