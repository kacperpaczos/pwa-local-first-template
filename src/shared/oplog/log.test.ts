import { describe, expect, it } from "vitest";
import { generateDeviceKey } from "@/shared/identity/device";
import { createOperation, type Operation } from "./header";
import { validateAgainstHead } from "./log";

const device = generateDeviceKey();
const payload = new TextEncoder().encode("{}");

function op(seq: number, backlink: string | null, timestamp = seq): Operation {
  return createOperation({
    entity: "notes",
    seq,
    backlink,
    payloadBytes: payload,
    publicKey: device.publicKey,
    secretKey: device.secretKey,
    timestamp,
  });
}

describe("validateAgainstHead", () => {
  const first = op(1, null);
  const second = op(2, first.hash);
  const stored = new Map([
    [1, first.hash],
    [2, second.hash],
  ]);
  const hashAt = (seq: number) => stored.get(seq);
  const head = { seq: 2, hash: second.hash };

  it("accepts the next op extending the chain", () => {
    const third = op(3, second.hash);
    expect(validateAgainstHead(third, head, hashAt)).toBe("ok");
    expect(validateAgainstHead(first, null, () => undefined)).toBe("ok");
  });

  it("flags a gap when seq jumps past head+1", () => {
    const fifth = op(5, second.hash);
    expect(validateAgainstHead(fifth, head, hashAt)).toBe("gap");
  });

  it("flags a re-delivered known op as duplicate", () => {
    expect(validateAgainstHead(second, head, hashAt)).toBe("duplicate");
    expect(validateAgainstHead(first, head, hashAt)).toBe("duplicate");
  });

  it("flags a different op at an occupied seq as fork", () => {
    // Same position, same backlink, different timestamp → different hash.
    const forked = op(2, first.hash, 999);
    expect(forked.hash).not.toBe(second.hash);
    expect(validateAgainstHead(forked, head, hashAt)).toBe("fork");
  });

  it("flags a wrong backlink at head+1 as fork", () => {
    const bad = op(3, first.hash);
    expect(validateAgainstHead(bad, head, hashAt)).toBe("fork");
    const badGenesis = op(1, null);
    expect(validateAgainstHead(badGenesis, head, hashAt)).toBe("duplicate");
  });

  it("flags an op below head with no stored hash (pruned/quarantined) as fork", () => {
    expect(validateAgainstHead(first, head, () => undefined)).toBe("fork");
  });
});
