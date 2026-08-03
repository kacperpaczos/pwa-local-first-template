import { describe, expect, it } from "vitest";
import {
  exportIdentityJson,
  generatePair,
  importIdentityJson,
  loadStoredPair,
  parseIdentityJson,
  savePair,
} from "./pair";
import { IDENTITY_STORAGE_KEY } from "./types";

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

describe("identity pair", () => {
  it("generates a SEA pair and round-trips via JSON", async () => {
    const pair = await generatePair();
    expect(pair.pub).toBeTruthy();
    expect(pair.priv).toBeTruthy();

    const json = exportIdentityJson(pair);
    const parsed = parseIdentityJson(json);
    expect(parsed.v).toBe(1);
    expect(parsed.pair).toEqual(pair);
  });

  it("persists and loads from storage", async () => {
    const storage = memoryStorage();
    const pair = await generatePair();
    savePair(pair, storage);
    expect(storage.getItem(IDENTITY_STORAGE_KEY)).toContain(pair.pub);
    expect(loadStoredPair(storage)).toEqual(pair);
  });

  it("importIdentityJson overwrites storage", async () => {
    const storage = memoryStorage();
    const a = await generatePair();
    const b = await generatePair();
    savePair(a, storage);
    importIdentityJson(exportIdentityJson(b), storage);
    expect(loadStoredPair(storage)).toEqual(b);
  });

  it("rejects invalid JSON payloads", () => {
    expect(() => parseIdentityJson("{}")).toThrow(/invalid/i);
    expect(() => parseIdentityJson("not-json")).toThrow(/not valid/i);
  });
});
