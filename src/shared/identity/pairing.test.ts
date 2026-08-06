import { describe, expect, it } from "vitest";
import {
  buildPairingPayload,
  commitPairingPayload,
  deriveSasDigits,
  parsePairingJson,
  previewPairingPayload,
  verifySas,
  type PairingPayload,
} from "./pairing";
import { loadStoredPair } from "./pair";
import { loadSpaceId } from "./space";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key() {
      return null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("pairing", () => {
  it("builds a v2 payload with matching SAS digits", async () => {
    const storage = memoryStorage();
    const payload = await buildPairingPayload(storage);
    expect(payload.v).toBe(2);
    expect(payload.pair.pub).toBeTruthy();
    expect(payload.spaceId).toBeTruthy();
    expect(payload.spaceKey.length).toBeGreaterThan(0);
    expect(payload.sasDigits).toMatch(/^\d{6}$/);

    const again = await deriveSasDigits(payload.spaceId, [payload.pair.pub]);
    expect(again).toBe(payload.sasDigits);
    expect(verifySas(payload.sasDigits, again)).toBe(true);
  });

  it("verifySas requires exact 6-digit match", () => {
    expect(verifySas("123456", "123456")).toBe(true);
    expect(verifySas("123456", "654321")).toBe(false);
    expect(verifySas("12345", "12345")).toBe(false);
  });

  it("two devices with same payload share SAS, and commit requires the confirmed SAS", async () => {
    const deviceA = memoryStorage();
    const payload = await buildPairingPayload(deviceA);

    const deviceB = memoryStorage();
    const previewed = await previewPairingPayload(payload);
    expect(previewed.sasDigits).toBe(payload.sasDigits);
    expect(verifySas(payload.sasDigits, previewed.sasDigits)).toBe(true);

    // Preview alone must not persist anything.
    expect(loadStoredPair(deviceB)).toBeNull();
    expect(loadSpaceId(deviceB)).toBeNull();

    const committed = await commitPairingPayload(previewed, previewed.sasDigits, deviceB);
    expect(committed.sasDigits).toBe(payload.sasDigits);
    expect(loadStoredPair(deviceB)).toEqual(payload.pair);
    expect(loadSpaceId(deviceB)).toBe(payload.spaceId);
  });

  it("rejects tampered SAS in payload at preview time", async () => {
    const storage = memoryStorage();
    const payload = await buildPairingPayload(storage);
    const bad = { ...payload, sasDigits: "000000" };
    await expect(previewPairingPayload(bad)).rejects.toThrow(/SAS/);
  });

  it("commit refuses to persist without a matching expectedSas", async () => {
    const payload = await buildPairingPayload(memoryStorage());
    const previewed = await previewPairingPayload(payload);
    const deviceB = memoryStorage();

    await expect(commitPairingPayload(previewed, "000000", deviceB)).rejects.toThrow(/SAS/);
    expect(loadStoredPair(deviceB)).toBeNull();
  });

  it("a forged payload with its own consistent SAS still fails the real attack check", async () => {
    // This models the actual MITM vector: an attacker doesn't tamper with a
    // genuine payload's `sasDigits` field (that's the weaker, already-caught
    // case above) — they mint an entirely fresh, self-consistent fake
    // payload (own pair, own spaceId) whose sasDigits legitimately matches
    // itself. previewPairingPayload alone CANNOT catch this — only a human
    // comparing against the SAS the genuine sender's device shows can, via
    // commitPairingPayload's required expectedSas.
    const genuineDeviceA = memoryStorage();
    const genuinePayload = await buildPairingPayload(genuineDeviceA);
    const genuineSas = genuinePayload.sasDigits;

    const forgedDeviceX = memoryStorage();
    const forgedPayload = await buildPairingPayload(forgedDeviceX);
    expect(forgedPayload.pair.pub).not.toBe(genuinePayload.pair.pub);
    expect(forgedPayload.spaceId).not.toBe(genuinePayload.spaceId);

    // The forged payload is internally self-consistent — preview succeeds.
    const previewed = await previewPairingPayload(forgedPayload as PairingPayload);
    expect(previewed.sasDigits).toBe(forgedPayload.sasDigits);

    // But the victim was told the GENUINE device's SAS out-of-band, so
    // commit must reject the forged payload (unless the attacker also
    // brute-forces a collision, which is a separate, tracked hardening item).
    if (forgedPayload.sasDigits === genuineSas) {
      // Astronomically unlikely (~1e-6) — treat as a non-flaky skip.
      return;
    }
    await expect(commitPairingPayload(previewed, genuineSas, memoryStorage())).rejects.toThrow(
      /SAS/,
    );
  });

  it("round-trips via JSON", async () => {
    const payload = await buildPairingPayload(memoryStorage());
    const parsed = parsePairingJson(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });
});
