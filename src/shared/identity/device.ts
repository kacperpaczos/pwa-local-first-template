import { ed25519 } from "@noble/curves/ed25519.js";
import { base64UrlToBytes, bytesToBase64Url } from "@/shared/crypto/bytes";
import { parseJsonOrThrow } from "@/shared/lib/json";

export const DEVICE_KEY_STORAGE_KEY = "pwa-device-key";

/**
 * Per-device ed25519 signing key. Unlike the SEA pair and the space key
 * (which every paired device shares), this key NEVER leaves the device —
 * it is what makes op-log entries attributable to a specific device.
 * Mirrors p2panda's `PrivateKey`/`PublicKey` (also ed25519), so a v0.2
 * migration to `p2panda-core` keeps the same key material semantics.
 *
 * At-rest trust model is the same as the existing SEA pair: plaintext in
 * localStorage (see README "Known caveats").
 */
export type DeviceKey = {
  /** base64url(publicKey) — doubles as the device's log id ("author"). */
  deviceId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

type StoredDeviceKey = { v: 1; sk: string };

function fromSecretKey(secretKey: Uint8Array): DeviceKey {
  const publicKey = ed25519.getPublicKey(secretKey);
  return { deviceId: bytesToBase64Url(publicKey), publicKey, secretKey };
}

export function generateDeviceKey(): DeviceKey {
  return fromSecretKey(ed25519.utils.randomSecretKey());
}

export function loadDeviceKey(storage: Pick<Storage, "getItem"> = localStorage): DeviceKey | null {
  const raw = storage.getItem(DEVICE_KEY_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = parseJsonOrThrow(raw, "Invalid device key JSON") as Partial<StoredDeviceKey>;
    if (parsed.v !== 1 || typeof parsed.sk !== "string") return null;
    return fromSecretKey(base64UrlToBytes(parsed.sk));
  } catch {
    return null;
  }
}

export function saveDeviceKey(
  key: DeviceKey,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  const payload: StoredDeviceKey = { v: 1, sk: bytesToBase64Url(key.secretKey) };
  storage.setItem(DEVICE_KEY_STORAGE_KEY, JSON.stringify(payload));
}

/** Load the device key or create + persist a fresh one. */
export function ensureDeviceKey(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): DeviceKey {
  const existing = loadDeviceKey(storage);
  if (existing) return existing;
  const key = generateDeviceKey();
  saveDeviceKey(key, storage);
  return key;
}

/**
 * Drop the stored key so the next boot mints a new device identity.
 * Used by recovery: a restored device is a NEW writer with an empty log —
 * reusing the old device id would fork the old device's log.
 */
export function clearDeviceKey(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(DEVICE_KEY_STORAGE_KEY);
}
