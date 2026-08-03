import { describe, expect, it } from "vitest";
import { generateSpaceKey } from "@/shared/crypto/envelope";
import {
  createRecoveryBundle,
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  parseRecoveryBundle,
  phraseToWrappingKey,
  pickConfirmationIndices,
  restoreFromRecovery,
  unwrapSpaceKey,
  verifyConfirmationWords,
  wrapSpaceKey,
} from "./recovery";

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

describe("recovery", () => {
  it("generates a valid 12-word BIP39 phrase", () => {
    const phrase = generateRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(isValidRecoveryPhrase(phrase)).toBe(true);
    expect(isValidRecoveryPhrase("not a real phrase")).toBe(false);
  });

  it("wraps and unwraps a space key with the mnemonic", async () => {
    const phrase = generateRecoveryPhrase();
    const spaceKey = await generateSpaceKey();
    const wrapped = await wrapSpaceKey(spaceKey, phrase);
    const unwrapped = await unwrapSpaceKey(wrapped, phrase);

    const a = new Uint8Array(await crypto.subtle.exportKey("raw", spaceKey));
    const b = new Uint8Array(await crypto.subtle.exportKey("raw", unwrapped));
    expect(b).toEqual(a);
  });

  it("rejects wrong mnemonic on unwrap", async () => {
    const phrase = generateRecoveryPhrase();
    const other = generateRecoveryPhrase();
    const wrapped = await wrapSpaceKey(await generateSpaceKey(), phrase);
    await expect(unwrapSpaceKey(wrapped, other)).rejects.toThrow();
  });

  it("phraseToWrappingKey is deterministic across normalization", async () => {
    const phrase = generateRecoveryPhrase();
    const spaceKey = await generateSpaceKey();
    const wrapped = await wrapSpaceKey(spaceKey, phrase);
    const unwrapped = await unwrapSpaceKey(wrapped, `  ${phrase.toUpperCase()}  `);
    const a = new Uint8Array(await crypto.subtle.exportKey("raw", spaceKey));
    const b = new Uint8Array(await crypto.subtle.exportKey("raw", unwrapped));
    expect(b).toEqual(a);
    // Keep the named export exercised for API stability.
    await expect(phraseToWrappingKey(phrase)).resolves.toBeTruthy();
  });

  it("restores space from recovery bundle", async () => {
    const storage = memoryStorage();
    const phrase = generateRecoveryPhrase();
    const key = await generateSpaceKey();
    const bundle = await createRecoveryBundle("space-abc", key, phrase);
    const restored = await restoreFromRecovery(phrase, bundle, storage);
    const rawA = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const rawB = new Uint8Array(await crypto.subtle.exportKey("raw", restored));
    expect(rawB).toEqual(rawA);
    expect(storage.getItem("pwa-space-id")).toBe("space-abc");
  });

  it("parses recovery bundles and picks confirmation indices", () => {
    const bundle = parseRecoveryBundle({
      v: 1,
      spaceId: "s1",
      wrapped: { nonce: "n", ciphertext: "c" },
    });
    expect(bundle.spaceId).toBe("s1");

    const indices = pickConfirmationIndices(12, 3, () => Math.random());
    expect(indices).toHaveLength(3);
    expect(new Set(indices).size).toBe(3);

    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(
      verifyConfirmationWords(phrase, [
        { index: 0, word: "abandon" },
        { index: 11, word: "about" },
      ]),
    ).toBe(true);
    expect(
      verifyConfirmationWords(phrase, [{ index: 0, word: "wrong" }]),
    ).toBe(false);
  });
});
