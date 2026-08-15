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
import { loadSpaceId, saveSpaceExported } from "./space";

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
  it("builds a v3 payload with matching SAS digits and an inviter device id", async () => {
    const storage = memoryStorage();
    const payload = await buildPairingPayload(storage);
    expect(payload.v).toBe(3);
    expect(payload.pair.pub).toBeTruthy();
    expect(payload.spaceId).toBeTruthy();
    expect(payload.spaceKey.length).toBeGreaterThan(0);
    expect(payload.sasDigits).toMatch(/^\d{6}$/);
    expect(payload.inviterDevice.id).toBeTruthy();

    const again = await deriveSasDigits(payload.spaceId, [payload.pair.pub]);
    expect(again).toBe(payload.sasDigits);
    expect(verifySas(payload.sasDigits, again)).toBe(true);
  });

  it("loudly rejects a v2 (or earlier) payload instead of silently downgrading", async () => {
    const storage = memoryStorage();
    const payload = await buildPairingPayload(storage);
    const { inviterDevice, ...v2Shaped } = payload;
    void inviterDevice;
    const legacy = { ...v2Shaped, v: 2 };
    expect(() => parsePairingJson(JSON.stringify(legacy))).toThrow(/older app version/);
  });

  it("rejects a payload missing the inviter device id", async () => {
    const payload = await buildPairingPayload(memoryStorage());
    const { inviterDevice, ...rest } = payload;
    void inviterDevice;
    expect(() => parsePairingJson(JSON.stringify(rest))).toThrow(/inviter device/);
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

  it("a forged payload is caught only when its SAS happens to differ — the check is not a real gate", async () => {
    // Models the MITM vector: the attacker mints a fresh, self-consistent
    // payload (own pair, own spaceId). preview() cannot detect it, and the
    // SAS confirmation only rejects it because these particular random
    // values produced different digits.
    const genuinePayload = await buildPairingPayload(memoryStorage());
    const genuineSas = genuinePayload.sasDigits;

    const forgedPayload = await buildPairingPayload(memoryStorage());
    expect(forgedPayload.pair.pub).not.toBe(genuinePayload.pair.pub);

    const previewed = await previewPairingPayload(forgedPayload as PairingPayload);
    expect(previewed.sasDigits).toBe(forgedPayload.sasDigits);

    if (forgedPayload.sasDigits === genuineSas) {
      // ~1e-6 by chance here, but see the next test: an ATTACKER does not
      // rely on chance, and this branch is the one they always reach.
      return;
    }
    await expect(commitPairingPayload(previewed, genuineSas, memoryStorage())).rejects.toThrow(
      /SAS/,
    );
  });

  it("KNOWN WEAKNESS: a ground SAS collision passes the confirmation gate", async () => {
    // Documents the limitation stated on deriveSasDigits: the digits are 10^6
    // wide over inputs the payload's author picks, so an attacker who reads a
    // genuine code's SAS can search for their own spaceId that derives the
    // same six digits. The victim then compares digits, sees a match, and
    // imports the attacker's keys. This test asserts the CURRENT (insecure)
    // behavior so that fixing it — an interactive SAS, tracked for v0.2 —
    // fails here loudly instead of silently leaving this test green.
    const genuineStorage = memoryStorage();
    const genuine = await buildPairingPayload(genuineStorage);
    const attacker = await buildPairingPayload(memoryStorage());

    // The grind is ~10^6 digests for one fixed target. Amortized here over
    // many possible genuine spaceIds so the test costs ~10^4 instead — the
    // attacker's real cost against ONE target is still trivially small
    // (sub-second offline), this only keeps the test fast and non-flaky.
    const targets = new Map<string, string>();
    for (let i = 0; i < 200; i++) {
      const candidateSpaceId = `genuine-space-${i}`;
      targets.set(await deriveSasDigits(candidateSpaceId, [genuine.pair.pub]), candidateSpaceId);
    }

    let collision: { attackerSpaceId: string; genuineSpaceId: string } | null = null;
    for (let i = 0; i < 1_000_000 && collision === null; i++) {
      const candidate = `attacker-space-${i}`;
      const digits = await deriveSasDigits(candidate, [attacker.pair.pub]);
      const genuineSpaceId = targets.get(digits);
      if (genuineSpaceId) {
        collision = { attackerSpaceId: candidate, genuineSpaceId };
      }
    }
    expect(collision).not.toBeNull();

    // The genuine device is the one holding the colliding spaceId, so the
    // SAS its screen shows is exactly what the attacker ground for.
    saveSpaceExported(collision!.genuineSpaceId, genuine.spaceKey, genuineStorage);
    const genuinePayload = await buildPairingPayload(genuineStorage);
    expect(genuinePayload.spaceId).toBe(collision!.genuineSpaceId);

    const forged: PairingPayload = {
      ...attacker,
      spaceId: collision!.attackerSpaceId,
      sasDigits: genuinePayload.sasDigits,
    };

    // Both gates pass, and the victim ends up holding the ATTACKER's keys.
    const previewed = await previewPairingPayload(forged);
    const victim = memoryStorage();
    await commitPairingPayload(previewed, genuinePayload.sasDigits, victim);
    expect(loadStoredPair(victim)).toEqual(attacker.pair);
    expect(loadStoredPair(victim)).not.toEqual(genuinePayload.pair);
  });

  it("round-trips via JSON", async () => {
    const payload = await buildPairingPayload(memoryStorage());
    const parsed = parsePairingJson(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });
});
