import { asBufferSource, base64ToBytes, bytesToBase64 } from "./bytes";

const AES_ALG = "AES-GCM";
const KEY_BITS = 256;
const IV_BYTES = 12;

export type SealedBlob = {
  nonce: string;
  ciphertext: string;
};

/** AES-256-GCM content key for a shared sync space. */
export async function generateSpaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: AES_ALG, length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportSpaceKey(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return bytesToBase64(raw);
}

export async function importSpaceKey(b64: string): Promise<CryptoKey> {
  const raw = asBufferSource(base64ToBytes(b64));
  if (raw.byteLength !== 32) {
    throw new Error("Invalid space key length");
  }
  return crypto.subtle.importKey("raw", raw, { name: AES_ALG, length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function seal(
  plaintext: Uint8Array,
  spaceKey: CryptoKey,
  aad: string,
): Promise<SealedBlob> {
  const nonce = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(aad);
  const ct = await crypto.subtle.encrypt(
    { name: AES_ALG, iv: nonce, additionalData },
    spaceKey,
    asBufferSource(plaintext),
  );
  return {
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ct)),
  };
}

export async function open(
  sealed: SealedBlob,
  spaceKey: CryptoKey,
  aad: string,
): Promise<Uint8Array> {
  const nonce = asBufferSource(base64ToBytes(sealed.nonce));
  const ciphertext = asBufferSource(base64ToBytes(sealed.ciphertext));
  const additionalData = new TextEncoder().encode(aad);
  const pt = await crypto.subtle.decrypt(
    { name: AES_ALG, iv: nonce, additionalData },
    spaceKey,
    ciphertext,
  );
  return new Uint8Array(pt);
}
