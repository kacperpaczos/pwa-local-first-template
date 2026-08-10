import { exportSpaceKey, importSpaceKey } from "@/shared/crypto/envelope";
import { parseJsonOrThrow } from "@/shared/lib/json";
import { ensureDeviceKey } from "./device";
import { ensurePair, savePair } from "./pair";
import { ensureSpace, saveSpaceExported } from "./space";
import type { SeaPair } from "./types";

export type InviterDevice = {
  /** The inviting device's op-log id (base64url ed25519 public key). Informational only. */
  id: string;
};

/**
 * v3 (op-log era): adds `inviterDevice`, purely informational — it tells the
 * importing UI which device's log to expect entries from first. Device
 * SIGNING keys are never part of this payload and never transferred: every
 * device mints and keeps its own (see shared/identity/device.ts). What IS
 * still shared here (same as v2) is the SEA pair (Gun write-ACL) and the
 * raw space key (content encryption) — every paired device holds identical
 * copies of both. See README "Known caveats" for what that does and doesn't
 * buy you.
 */
export type PairingPayload = {
  v: 3;
  pair: SeaPair;
  spaceId: string;
  /** Raw AES-256 space key (base64). Treated as secret — QR is the seal. */
  spaceKey: string;
  sasDigits: string;
  inviterDevice: InviterDevice;
};

/**
 * 6 digits derived from the space identity.
 *
 * KNOWN LIMITATION — this is a transfer checksum, NOT an authentication of
 * the sender, and it does not stop an attacker who controls the pairing
 * channel. Every input (`spaceId`, `pubs`) is chosen by whoever authored the
 * payload, and the digest is only 10^6 wide: an attacker who intercepts a
 * genuine code reads its `sasDigits`, then grinds candidate `spaceId` values
 * against their own keys until their forged payload derives the SAME six
 * digits — well under a second offline. The victim compares digits with the
 * genuine device, they match, and the forged payload is accepted.
 *
 * A SAS that actually resists this has to bind an interactive exchange
 * (commitment to both sides' fresh ephemeral values), which the current
 * one-way QR/JSON flow has no room for. Tracked as a v0.2 item alongside
 * p2panda-auth; until then treat the pairing channel itself as the trust
 * boundary — only pair over a channel an attacker cannot rewrite.
 */
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
  const device = ensureDeviceKey(storage);
  return {
    v: 3,
    pair,
    spaceId,
    spaceKey,
    sasDigits,
    inviterDevice: { id: device.deviceId },
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
  if (obj.v !== 3) {
    throw new Error(
      obj.v === 1 || obj.v === 2
        ? `Pairing code is from an older app version (v${String(obj.v)}) — ask the other device to generate a new one`
        : "Unsupported pairing payload version",
    );
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
  const inviterDevice = obj.inviterDevice as InviterDevice | undefined;
  if (!inviterDevice || typeof inviterDevice.id !== "string" || inviterDevice.id.length === 0) {
    throw new Error("Pairing payload missing inviter device id");
  }
  return {
    v: 3,
    pair,
    spaceId: obj.spaceId,
    spaceKey: obj.spaceKey,
    sasDigits: obj.sasDigits,
    inviterDevice: { id: inviterDevice.id },
  };
}

export function parsePairingJson(text: string): PairingPayload {
  return parsePairingPayload(parseJsonOrThrow(text, "Pairing JSON is not valid"));
}

/**
 * Parse + structurally validate a pairing payload and compute its SAS,
 * WITHOUT touching storage. `payload.sasDigits` is self-derived from data
 * inside the same payload (spaceId + pub), so this only catches corruption
 * / typos in transit — it does NOT authenticate the sender, and neither
 * does the confirmation step that follows it (see {@link deriveSasDigits}
 * for the grinding attack that defeats it). Callers still show the SAS and
 * require confirmation before {@link commitPairingPayload}, because it
 * catches the common non-adversarial mistakes.
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
 * `expectedSas` is required and should come from the user reading it off the
 * other, genuine device. That catches the easy cases — a payload pasted from
 * the wrong device, a truncated or corrupted transfer, a stale code.
 *
 * It does NOT stop an attacker who can rewrite the pairing channel: the SAS
 * is only 10^6 wide over sender-chosen inputs, so a forged payload can be
 * ground to match the genuine digits (see {@link deriveSasDigits}). Do not
 * treat this check as the security boundary — the channel is.
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
