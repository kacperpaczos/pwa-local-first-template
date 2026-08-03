import { describe, expect, it } from "vitest";
import {
  exportSpaceKey,
  generateSpaceKey,
  importSpaceKey,
  open,
  seal,
} from "./envelope";

describe("envelope", () => {
  it("generates and round-trips a space key via base64 raw export", async () => {
    const key = await generateSpaceKey();
    const b64 = await exportSpaceKey(key);
    expect(b64.length).toBeGreaterThan(0);

    const imported = await importSpaceKey(b64);
    const plaintext = new TextEncoder().encode("hello space");
    const sealed = await seal(plaintext, imported, "aad-1");
    const opened = await open(sealed, key, "aad-1");
    expect(new TextDecoder().decode(opened)).toBe("hello space");
  });

  it("seal/open round-trips with AAD", async () => {
    const key = await generateSpaceKey();
    const plaintext = crypto.getRandomValues(new Uint8Array(64));
    const sealed = await seal(plaintext, key, "notes:v1");
    expect(sealed.nonce.length).toBeGreaterThan(0);
    expect(sealed.ciphertext.length).toBeGreaterThan(0);

    const opened = await open(sealed, key, "notes:v1");
    expect(opened).toEqual(plaintext);
  });

  it("rejects wrong AAD", async () => {
    const key = await generateSpaceKey();
    const sealed = await seal(new TextEncoder().encode("x"), key, "correct");
    await expect(open(sealed, key, "wrong")).rejects.toThrow();
  });

  it("rejects wrong key", async () => {
    const a = await generateSpaceKey();
    const b = await generateSpaceKey();
    const sealed = await seal(new TextEncoder().encode("secret"), a, "aad");
    await expect(open(sealed, b, "aad")).rejects.toThrow();
  });
});
