import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { asBufferSource } from "@/shared/crypto/bytes";
import { open, seal, type SealedBlob } from "@/shared/crypto/envelope";
import { saveSpace } from "./space";

const WRAP_AAD = "pwa-lf-space-key-wrap-v1";
const HKDF_SALT = new TextEncoder().encode("pwa-lf-recovery-v1");
const HKDF_INFO = new TextEncoder().encode("space-wrapping-key");

export type WrappedSpaceKey = SealedBlob;

export type RecoveryBundle = {
  v: 1;
  spaceId: string;
  wrapped: WrappedSpaceKey;
};

export function normalizeMnemonic(phrase: string): string {
  return phrase
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(" ");
}

/** BIP39 12-word English mnemonic. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  try {
    return validateMnemonic(normalizeMnemonic(phrase), wordlist);
  } catch {
    return false;
  }
}

/**
 * Derive an AES-256 wrapping key from a BIP39 mnemonic.
 * mnemonic → seed (PBKDF2 via bip39, sync) → HKDF-SHA256 → CryptoKey.
 */
export async function phraseToWrappingKey(mnemonic: string): Promise<CryptoKey> {
  const normalized = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid recovery phrase");
  }
  const seed = mnemonicToSeedSync(normalized);
  const raw = asBufferSource(hkdf(sha256, seed, HKDF_SALT, HKDF_INFO, 32));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function wrapSpaceKey(
  spaceKey: CryptoKey,
  mnemonic: string,
): Promise<WrappedSpaceKey> {
  const wrappingKey = await phraseToWrappingKey(mnemonic);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", spaceKey));
  return seal(raw, wrappingKey, WRAP_AAD);
}

export async function unwrapSpaceKey(
  wrapped: WrappedSpaceKey,
  mnemonic: string,
): Promise<CryptoKey> {
  const wrappingKey = await phraseToWrappingKey(mnemonic);
  const raw = asBufferSource(await open(wrapped, wrappingKey, WRAP_AAD));
  if (raw.byteLength !== 32) {
    throw new Error("Unwrapped key has invalid length");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function createRecoveryBundle(
  spaceId: string,
  spaceKey: CryptoKey,
  mnemonic: string,
): Promise<RecoveryBundle> {
  return {
    v: 1,
    spaceId,
    wrapped: await wrapSpaceKey(spaceKey, mnemonic),
  };
}

export async function restoreFromRecovery(
  mnemonic: string,
  bundle: RecoveryBundle,
  storage: Pick<Storage, "setItem"> = localStorage,
): Promise<CryptoKey> {
  if (bundle.v !== 1 || !bundle.spaceId || !bundle.wrapped) {
    throw new Error("Invalid recovery bundle");
  }
  const key = await unwrapSpaceKey(bundle.wrapped, mnemonic);
  await saveSpace(bundle.spaceId, key, storage);
  return key;
}

export function parseRecoveryBundle(raw: unknown): RecoveryBundle {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid recovery bundle");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1 || typeof obj.spaceId !== "string") {
    throw new Error("Unsupported or invalid recovery bundle");
  }
  const wrapped = obj.wrapped;
  if (
    !wrapped ||
    typeof wrapped !== "object" ||
    typeof (wrapped as SealedBlob).nonce !== "string" ||
    typeof (wrapped as SealedBlob).ciphertext !== "string"
  ) {
    throw new Error("Recovery bundle missing wrapped key");
  }
  return {
    v: 1,
    spaceId: obj.spaceId,
    wrapped: wrapped as SealedBlob,
  };
}

/** Pick `count` distinct random word indices for confirmation UI. */
export function pickConfirmationIndices(
  wordCount: number,
  count = 3,
  random: () => number = Math.random,
): number[] {
  if (count > wordCount) {
    throw new Error("Cannot pick more indices than words");
  }
  const indices = new Set<number>();
  let guard = 0;
  while (indices.size < count) {
    indices.add(Math.floor(random() * wordCount) % wordCount);
    if (++guard > wordCount * 32) {
      // Degenerate RNG (e.g. constant) — fill deterministically.
      for (let i = 0; i < wordCount && indices.size < count; i++) {
        indices.add(i);
      }
      break;
    }
  }
  return [...indices].sort((a, b) => a - b);
}

export function verifyConfirmationWords(
  mnemonic: string,
  answers: ReadonlyArray<{ index: number; word: string }>,
): boolean {
  const words = normalizeMnemonic(mnemonic).split(" ");
  return answers.every(({ index, word }) => {
    const expected = words[index];
    return typeof expected === "string" && expected === word.trim().toLowerCase();
  });
}
