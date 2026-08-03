import { exportSpaceKey, importSpaceKey } from "@/shared/crypto/envelope";
import { ensurePair, savePair } from "./pair";
import { ensureSpace, saveSpaceExported } from "./space";
import type { SeaPair } from "./types";

export type PairingPayload = {
  v: 2;
  pair: SeaPair;
  spaceId: string;
  /** Raw AES-256 space key (base64). Treated as secret — QR is the seal. */
  spaceKey: string;
  sasDigits: string;
};

export async function deriveSasDigits(
  spaceId: string,
  pubs: readonly string[],
): Promise<string> {
  const material = [spaceId, ...[...pubs].sort()].join("|");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)),
  );
  const n =
    ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>>
    0;
  return String(n % 1_000_000).padStart(6, "0");
}

export function verifySas(local: string, remote: string): boolean {
  const a = local.trim();
  const b = remote.trim();
  return a.length === 6 && b.length === 6 && /^\d{6}$/.test(a) && a === b;
}

export async function buildPairingPayload(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): Promise<PairingPayload> {
  const pair = await ensurePair(storage);
  const { spaceId, key } = await ensureSpace(storage);
  const spaceKey = await exportSpaceKey(key);
  const sasDigits = await deriveSasDigits(spaceId, [pair.pub]);
  return {
    v: 2,
    pair,
    spaceId,
    spaceKey,
    sasDigits,
  };
}

export function exportPairingJson(payload: PairingPayload): string {
  return JSON.stringify(payload);
}

export function parsePairingPayload(raw: unknown): PairingPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid pairing payload");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 2) {
    throw new Error("Unsupported pairing payload version");
  }
  const pair = obj.pair as SeaPair | undefined;
  if (
    !pair ||
    typeof pair.pub !== "string" ||
    typeof pair.priv !== "string" ||
    typeof pair.epub !== "string" ||
    typeof pair.epriv !== "string"
  ) {
    throw new Error("Pairing payload missing SEA pair");
  }
  if (typeof obj.spaceId !== "string" || typeof obj.spaceKey !== "string") {
    throw new Error("Pairing payload missing space key material");
  }
  if (typeof obj.sasDigits !== "string" || !/^\d{6}$/.test(obj.sasDigits)) {
    throw new Error("Pairing payload missing SAS digits");
  }
  return {
    v: 2,
    pair,
    spaceId: obj.spaceId,
    spaceKey: obj.spaceKey,
    sasDigits: obj.sasDigits,
  };
}

export function parsePairingJson(text: string): PairingPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Pairing JSON is not valid");
  }
  return parsePairingPayload(parsed);
}

/**
 * Import SEA pair + space key from a pairing payload.
 * Verifies SAS when `expectedSas` is provided (optional remote check).
 */
export async function importPairingPayload(
  raw: string | PairingPayload,
  storage: Pick<Storage, "setItem"> = localStorage,
  expectedSas?: string,
): Promise<PairingPayload> {
  const payload = typeof raw === "string" ? parsePairingJson(raw) : parsePairingPayload(raw);

  // Validate key material before persisting.
  await importSpaceKey(payload.spaceKey);

  const expectedDigits = await deriveSasDigits(payload.spaceId, [payload.pair.pub]);
  if (payload.sasDigits !== expectedDigits) {
    throw new Error("SAS digits do not match space identity");
  }
  if (expectedSas !== undefined && !verifySas(expectedDigits, expectedSas)) {
    throw new Error("SAS verification failed");
  }

  savePair(payload.pair, storage);
  saveSpaceExported(payload.spaceId, payload.spaceKey, storage);
  return payload;
}
