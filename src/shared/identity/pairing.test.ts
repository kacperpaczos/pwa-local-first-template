import { describe, expect, it } from "vitest";
import {
  buildPairingPayload,
  deriveSasDigits,
  importPairingPayload,
  parsePairingJson,
  verifySas,
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

  it("two devices with same payload share SAS", async () => {
    const deviceA = memoryStorage();
    const payload = await buildPairingPayload(deviceA);

    const deviceB = memoryStorage();
    const imported = await importPairingPayload(payload, deviceB);
    expect(imported.sasDigits).toBe(payload.sasDigits);
    expect(verifySas(payload.sasDigits, imported.sasDigits)).toBe(true);

    expect(loadStoredPair(deviceB)).toEqual(payload.pair);
    expect(loadSpaceId(deviceB)).toBe(payload.spaceId);
  });

  it("rejects tampered SAS in payload", async () => {
    const storage = memoryStorage();
    const payload = await buildPairingPayload(storage);
    const bad = { ...payload, sasDigits: "000000" };
    await expect(importPairingPayload(bad, memoryStorage())).rejects.toThrow(
      /SAS/,
    );
  });

  it("round-trips via JSON", async () => {
    const payload = await buildPairingPayload(memoryStorage());
    const parsed = parsePairingJson(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });
});
