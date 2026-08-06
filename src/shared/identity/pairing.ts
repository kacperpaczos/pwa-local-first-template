import { exportSpaceKey, importSpaceKey } from "@/shared/crypto/envelope";
import { parseJsonOrThrow } from "@/shared/lib/json";
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

export async function deriveSasDigits(spaceId: string, pubs: readonly string[]): Promise<string> {
  const material = [spaceId, ...[...pubs].sort()].join("|");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)),
  );
  const n = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
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
  return parsePairingPayload(parseJsonOrThrow(text, "Pairing JSON is not valid"));
}

/**
 * Parse + structurally validate a pairing payload and compute its SAS,
 * WITHOUT touching storage. `payload.sasDigits` is self-derived from data
 * inside the same payload (spaceId + pub), so this only catches corruption
 * / typos in transit — it does NOT authenticate the sender. Callers must
 * show the returned SAS to the user and get an out-of-band confirmation
 * (the code read from the other device) before calling
 * {@link commitPairingPayload} — see its doc comment for why that step is
 * the one that actually matters.
 */
export async function previewPairingPayload(raw: string | PairingPayload): Promise<PairingPayload> {
  const payload = typeof raw === "string" ? parsePairingJson(raw) : parsePairingPayload(raw);

  // Validate key material shape without persisting it.
  await importSpaceKey(payload.spaceKey);

  const expectedDigits = await deriveSasDigits(payload.spaceId, [payload.pair.pub]);
  if (payload.sasDigits !== expectedDigits) {
    throw new Error("SAS digits do not match space identity");
  }

  return payload;
}

/**
 * Persist a previewed pairing payload's SEA pair + space key locally.
 *
 * `expectedSas` is required and MUST come from the user manually reading it
 * off the other, genuine device (voice, in person, etc — any channel an
 * attacker substituting the QR/JSON in transit doesn't also control). This
 * is the actual security boundary: `payload.sasDigits` is computed purely
 * from data the sender of the payload controls, so an attacker crafting a
 * whole fake payload (fake pair + fake spaceId) trivially produces one that
 * is internally self-consistent — {@link previewPairingPayload} alone
 * cannot detect that. Only a human confirming the SAS out-of-band can.
 */
export async function commitPairingPayload(
  payload: PairingPayload,
  expectedSas: string,
  storage: Pick<Storage, "setItem"> = localStorage,
): Promise<PairingPayload> {
  if (!verifySas(payload.sasDigits, expectedSas)) {
    throw new Error("SAS verification failed");
  }

  savePair(payload.pair, storage);
  saveSpaceExported(payload.spaceId, payload.spaceKey, storage);
  return payload;
}
