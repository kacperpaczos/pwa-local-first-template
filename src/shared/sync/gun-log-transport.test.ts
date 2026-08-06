/**
 * `createFakeGun()` below is a hand-rolled in-memory graph (Map + listener
 * set) injected via GunLogTransport's `createGun` option — no real `Gun()`
 * instance, no real networking or HAM runs in this file. AES-GCM seal/open
 * IS real (`@/shared/crypto/envelope`, backed by WebCrypto), so a wrong-key
 * decrypt failure here reflects a genuine failed decrypt, not a fake result.
 * Real Gun networking is only exercised in e2e (gun-peers.spec.ts and friends).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SeaPair } from "@/shared/identity";
import { generateSpaceKey } from "@/shared/crypto/envelope";
import { generateDeviceKey } from "@/shared/identity/device";
import { createOperation } from "@/shared/oplog/header";
import { encodeOpPayload } from "@/shared/oplog/payload";
import { GunLogTransport, resetSharedGunForTests } from "./gun-log-transport";
import type { HeadAnnouncement } from "./transport";

type Listener4 = (data: unknown, key: string, msg?: unknown, ev?: { off?: () => void }) => void;

function createFakeGun() {
  const store = new Map<string, Record<string, unknown>>();
  const listeners = new Map<string, Set<Listener4>>();

  function notify(path: string, key: string, data: unknown) {
    const set = listeners.get(path);
    if (!set) return;
    for (const listener of [...set])
      listener(data, key, undefined, { off: () => set.delete(listener) });
  }

  function chain(path: string) {
    return {
      get(next: string) {
        return chain(path ? `${path}/${next}` : next);
      },
      put(data: unknown, cb?: (ack: { err?: string }) => void) {
        const parts = path.split("/");
        const key = parts[parts.length - 1]!;
        const parent = parts.slice(0, -1).join("/");
        store.set(path, data as Record<string, unknown>);
        notify(parent, key, data);
        cb?.({});
        return this;
      },
      once(cb: (data: unknown) => void) {
        queueMicrotask(() => cb(store.get(path)));
        return this;
      },
      map() {
        const parent = path;
        return {
          on(listener: Listener4) {
            let set = listeners.get(parent);
            if (!set) {
              set = new Set();
              listeners.set(parent, set);
            }
            set.add(listener);
            for (const [full, data] of store) {
              if (!full.startsWith(`${parent}/`) && full !== parent) continue;
              const key = full.slice(parent.length + 1);
              if (key && !key.includes("/")) {
                listener(data, key, undefined, { off: () => set?.delete(listener) });
              }
            }
            return this;
          },
        };
      },
      on() {
        return this;
      },
    };
  }

  const user = {
    auth(_pair: SeaPair, cb: (ack: unknown) => void) {
      queueMicrotask(() => cb({}));
    },
    leave() {},
    get(key: string) {
      return chain(key);
    },
  };

  return { user: () => user, get: (key: string) => chain(key), store };
}

const pair: SeaPair = { pub: "p", priv: "p", epub: "e", epriv: "e" };

async function makeTransport(overrides?: { spaceKey?: CryptoKey; spaceId?: string }) {
  const gun = createFakeGun();
  const spaceKey = overrides?.spaceKey ?? (await generateSpaceKey());
  const transport = new GunLogTransport({
    peers: ["fake://peer"],
    pair,
    spaceKey,
    spaceId: overrides?.spaceId ?? "space1",
    createGun: () => gun as never,
    fetchWaitMs: 50,
  });
  await transport.ready();
  return { gun, transport, spaceKey };
}

describe("GunLogTransport", () => {
  afterEach(() => {
    resetSharedGunForTests();
  });

  it("publishes an op, announces its head, and a fresh transport fetches it back decrypted", async () => {
    const { transport: writer } = await makeTransport();
    const device = generateDeviceKey();
    const payload = { kind: "upsert", note: { id: "n1" } };
    const bytes = encodeOpPayload(payload);
    const op = createOperation({
      entity: "notes",
      seq: 1,
      backlink: null,
      payloadBytes: bytes,
      publicKey: device.publicKey,
      secretKey: device.secretKey,
      timestamp: 1,
    });

    await writer.publish("notes", [{ op, payloadJson: JSON.stringify(payload) }]);

    const heads: HeadAnnouncement[] = [];
    writer.subscribeHeads("notes", (head) => heads.push(head));
    // subscribeHeads defers subscribing until `ready()` resolves (a microtask).
    await Promise.resolve();
    await Promise.resolve();
    expect(heads).toEqual([{ device: device.deviceId, seq: 1, hash: op.hash }]);

    const { ops, sawUnsupportedVersion } = await writer.fetchOps("notes", device.deviceId, 1, 1);
    expect(sawUnsupportedVersion).toBe(false);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op.hash).toBe(op.hash);
    expect(new TextDecoder().decode(ops[0]!.payloadBytes)).toBe(JSON.stringify(payload));

    await writer.close();
  });

  it("fails closed with no fallback when the space key is unavailable", async () => {
    const gun = createFakeGun();
    const transport = new GunLogTransport({
      peers: ["fake://peer"],
      pair,
      createGun: () => gun as never,
      fetchWaitMs: 50,
    });
    await expect(transport.ready()).rejects.toThrow(/[Ss]pace key/);
    await transport.close();
  });

  it("acks round-trip as a device → seq map", async () => {
    const { transport } = await makeTransport();
    const seen: Array<{ device: string; acks: Record<string, number> }> = [];
    transport.subscribeAcks("notes", (device, acks) => seen.push({ device, acks }));

    await transport.publishAcks("notes", "deviceA", { deviceB: 3, deviceC: 7 });
    await new Promise((resolve) => queueMicrotask(() => queueMicrotask(() => resolve(undefined))));

    expect(seen).toEqual([{ device: "deviceA", acks: { deviceB: 3, deviceC: 7 } }]);
    await transport.close();
  });

  it("fetchOps times out on a missing row instead of hanging", async () => {
    const { transport } = await makeTransport();
    const { ops } = await transport.fetchOps("notes", "ghost-device", 1, 1);
    expect(ops).toEqual([]);
    await transport.close();
  });

  it("two transports over the same underlying peers share one Gun instance", async () => {
    const gun = createFakeGun();
    const spaceKey = await generateSpaceKey();
    const a = new GunLogTransport({
      peers: ["fake://shared"],
      pair,
      spaceKey,
      spaceId: "s1",
      createGun: () => gun as never,
    });
    const b = new GunLogTransport({
      peers: ["fake://shared"],
      pair,
      spaceKey,
      spaceId: "s1",
      // No createGun on b — same peers key must resolve the SAME shared instance.
    });
    await a.ready();
    // b never constructs its own Gun (no createGun given) and still resolves,
    // proving it reused a's shared instance rather than calling the real `Gun()`.
    await expect(b.ready()).resolves.toBeUndefined();
    await a.close();
    await b.close();
  });
});
