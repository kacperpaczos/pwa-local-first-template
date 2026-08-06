import { describe, expect, it } from "vitest";
import {
  DEVICE_KEY_STORAGE_KEY,
  clearDeviceKey,
  ensureDeviceKey,
  generateDeviceKey,
  loadDeviceKey,
} from "./device";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("device key", () => {
  it("generates a 32-byte ed25519 key with a base64url device id", () => {
    const key = generateDeviceKey();
    expect(key.publicKey).toHaveLength(32);
    expect(key.secretKey).toHaveLength(32);
    expect(key.deviceId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("ensureDeviceKey persists once and returns the same key afterwards", () => {
    const storage = memoryStorage();
    const first = ensureDeviceKey(storage);
    const second = ensureDeviceKey(storage);
    expect(second.deviceId).toBe(first.deviceId);
    expect(loadDeviceKey(storage)?.deviceId).toBe(first.deviceId);
  });

  it("returns null on a corrupt stored key instead of throwing", () => {
    const storage = memoryStorage();
    storage.setItem(DEVICE_KEY_STORAGE_KEY, "not json");
    expect(loadDeviceKey(storage)).toBeNull();
    storage.setItem(DEVICE_KEY_STORAGE_KEY, JSON.stringify({ v: 99 }));
    expect(loadDeviceKey(storage)).toBeNull();
  });

  it("clearDeviceKey makes the next ensure mint a NEW device identity", () => {
    const storage = memoryStorage();
    const first = ensureDeviceKey(storage);
    clearDeviceKey(storage);
    const second = ensureDeviceKey(storage);
    expect(second.deviceId).not.toBe(first.deviceId);
  });
});
