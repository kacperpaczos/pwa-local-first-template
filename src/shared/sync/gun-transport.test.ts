import { afterEach, describe, expect, it, vi } from "vitest";
import { GunSyncTransport, parseGunPeers } from "./gun-transport";
import type { SeaPair } from "@/shared/identity";
import { generatePair } from "@/shared/identity";

type Listener = (data: unknown, key: string) => void;

function createFakeGun() {
  const store = new Map<string, Record<string, unknown>>();
  const listeners = new Map<string, Set<Listener>>();

  function notify(path: string, key: string, data: unknown) {
    const set = listeners.get(path);
    if (!set) return;
    for (const listener of set) {
      listener(data, key);
    }
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
        const row = data as Record<string, unknown>;
        store.set(path, row);
        notify(parent, key, row);
        cb?.({});
        return this;
      },
      map() {
        const parent = path;
        return {
          on(listener: Listener) {
            let set = listeners.get(parent);
            if (!set) {
              set = new Set();
              listeners.set(parent, set);
            }
            set.add(listener);
            for (const [full, data] of store) {
              if (!full.startsWith(parent + "/") && full !== parent) continue;
              const key = full.slice(parent.length + 1);
              if (key && !key.includes("/")) {
                listener(data, key);
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

  return {
    user: () => user,
    get: (key: string) => chain(key),
  };
}

const sampleNote = {
  id: "note-1",
  title: "Hello",
  title_lamport: 1,
  body: "body",
  body_doc: "doc",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at: null,
  deleted_lamport: 0,
};

describe("parseGunPeers", () => {
  it("splits and trims peer URLs", () => {
    expect(parseGunPeers(" http://a/gun ,http://b/gun ")).toEqual([
      "http://a/gun",
      "http://b/gun",
    ]);
    expect(parseGunPeers("")).toEqual([]);
    expect(parseGunPeers(undefined)).toEqual([]);
  });
});

describe("GunSyncTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes mutations and pulls them back after cursor", async () => {
    const pair = await generatePair();
    const fake = createFakeGun();
    const transport = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      createGun: () => fake as never,
    });

    const push = await transport.push([
      {
        idempotencyKey: "k1",
        entity: "notes",
        op: "upsert",
        payload: sampleNote,
      },
    ]);
    expect(push.accepted).toEqual(["k1"]);
    expect(push.rejected).toEqual([]);

    const pull = await transport.pull(null);
    expect(pull.mutations).toHaveLength(1);
    expect(pull.mutations[0]?.idempotencyKey).toBe("k1");
    expect(pull.cursor).toBe("1");

    const pullAgain = await transport.pull(pull.cursor);
    expect(pullAgain.mutations).toHaveLength(0);
    expect(pullAgain.cursor).toBe("1");

    await transport.close();
  });

  it("rejects invalid outbox payloads", async () => {
    const pair = await generatePair();
    const fake = createFakeGun();
    const transport = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      createGun: () => fake as never,
    });

    const push = await transport.push([
      {
        idempotencyKey: "bad",
        entity: "notes",
        op: "upsert",
        payload: { not: "a note" },
      },
    ]);
    expect(push.accepted).toEqual([]);
    expect(push.rejected[0]?.idempotencyKey).toBe("bad");
    await transport.close();
  });
});
