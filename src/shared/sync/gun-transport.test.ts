/**
 * `createFakeGun()` below is a hand-rolled in-memory graph (Map + listener
 * set) injected via GunSyncTransport's `createGun` option — no real `Gun()`
 * instance, no real networking or HAM conflict resolution runs in this file.
 * SEA encrypt/decrypt IS real (`import SEA from "gun/sea"`), so failures like
 * "Could not decrypt" reflect a genuine failed decrypt, not a fake result.
 * Real Gun networking is only exercised in e2e: `e2e/gun-peers.spec.ts`,
 * `e2e/offline-sync.spec.ts`, `e2e/multi-tab.spec.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import SEA from "gun/sea";
import { GunSyncTransport, parseGunPeers } from "./gun-transport";
import type { SeaPair } from "@/shared/identity";
import { generatePair } from "@/shared/identity";
import { PROTOCOL_VERSION, SUPPORTED_MAX_V } from "./protocol";
import { setSyncStatus, syncStatusStore } from "./status";

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
    store,
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
    setSyncStatus("idle");
  });

  it("pushes mutations and pulls them back after cursor", async () => {
    const pair = await generatePair();
    const fake = createFakeGun();
    const transport = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      origin: "device-a",
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
    expect(JSON.parse(pull.cursor ?? "{}")).toEqual({ "device-a": 1 });

    const pullAgain = await transport.pull(pull.cursor);
    expect(pullAgain.mutations).toHaveLength(0);
    expect(pullAgain.cursor).toBe(pull.cursor);

    await transport.close();
  });

  it("does not drop mutations when two origins independently number their own seq from 1", async () => {
    // Regression test: the pull cursor used to be a single global numeric
    // watermark, so two devices offline-writing independently (both
    // starting their local seq counter at 1) could collide — whichever
    // origin's mutation the puller saw last would push the cursor past the
    // other origin's colliding seq, permanently hiding it from future
    // pulls even though it was sitting right there in the buffer.
    // Paired devices share the same SEA pair (see GunSyncTransport's
    // bootstrap comment) — only `origin` differs between them.
    const sharedPair = await generatePair();
    const fake = createFakeGun();

    const writerA = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair: sharedPair,
      origin: "device-a",
      createGun: () => fake as never,
    });

    // device-a pushes two mutations while device-b hasn't shown up yet —
    // both origins independently number their own pushes starting at seq=1.
    await writerA.push([
      { idempotencyKey: "a1", entity: "notes", op: "upsert", payload: { ...sampleNote, id: "a1" } },
      { idempotencyKey: "a2", entity: "notes", op: "upsert", payload: { ...sampleNote, id: "a2" } },
    ]);

    const reader = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair: sharedPair,
      origin: "device-c",
      createGun: () => fake as never,
    });

    const first = await reader.pull(null);
    expect(first.mutations.map((m) => m.idempotencyKey).sort()).toEqual(["a1", "a2"]);
    // Cursor only advances device-a's watermark — under the old single
    // global-number cursor this would have been the bare string "2".
    expect(JSON.parse(first.cursor ?? "{}")).toEqual({ "device-a": 2 });

    // device-b now comes online and pushes its own seq=1, seq=2 — colliding
    // numerically with device-a's already-consumed seq=1, seq=2.
    const writerB = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair: sharedPair,
      origin: "device-b",
      createGun: () => fake as never,
    });
    await writerB.push([
      { idempotencyKey: "b1", entity: "notes", op: "upsert", payload: { ...sampleNote, id: "b1" } },
      { idempotencyKey: "b2", entity: "notes", op: "upsert", payload: { ...sampleNote, id: "b2" } },
    ]);

    // Bug reproduction: with a single global numeric cursor of "2", these
    // would be filtered out forever (seq 1 and 2 are not > 2). The
    // per-origin cursor must still surface them.
    const second = await reader.pull(first.cursor);
    expect(second.mutations.map((m) => m.idempotencyKey).sort()).toEqual(["b1", "b2"]);

    await writerA.close();
    await writerB.close();
    await reader.close();
  });

  it("puts PROTOCOL_VERSION on the wire and never plaintext note content", async () => {
    const pair = await generatePair();
    const fake = createFakeGun();
    const transport = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      origin: "device-a",
      createGun: () => fake as never,
    });

    await transport.push([
      {
        idempotencyKey: "k1",
        entity: "notes",
        op: "upsert",
        payload: sampleNote,
      },
    ]);

    const rows = [...fake.store.values()] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.v).toBe(PROTOCOL_VERSION);
    expect(row.origin).toBe("device-a");
    expect(row).not.toHaveProperty("payloadJson");
    expect(typeof row.ciphertext).toBe("string");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(sampleNote.title);
    expect(serialized).not.toContain(sampleNote.body);

    await transport.close();
  });

  it("skips unsupported protocol versions and sets outdated status", async () => {
    const pair = await generatePair();
    const fake = createFakeGun();
    const transport = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      origin: "device-a",
      createGun: () => fake as never,
    });

    // Wait for auth + subscribe before injecting a foreign wire row.
    await transport.pull(null);

    const ciphertext = await SEA.encrypt(sampleNote, pair);
    expect(typeof ciphertext).toBe("string");

    fake
      .user()
      .get("app_sync")
      .get("notes")
      .get("future-v")
      .put({
        v: SUPPORTED_MAX_V + 1,
        idempotencyKey: "future-v",
        entity: "notes",
        op: "upsert",
        ciphertext,
        seq: 42,
        origin: "device-b",
      });

    // Allow any async follow-up; unsupported v should short-circuit before decrypt.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(syncStatusStore.get()).toBe("outdated");
    const pull = await transport.pull(null);
    expect(pull.mutations).toHaveLength(0);

    await transport.close();
  });

  it("cannot decrypt mutations pushed under a different pair", async () => {
    const writerPair = await generatePair();
    const readerPair = await generatePair();
    const fake = createFakeGun();

    const writer = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair: writerPair,
      origin: "device-a",
      createGun: () => fake as never,
    });
    await writer.push([
      {
        idempotencyKey: "k1",
        entity: "notes",
        op: "upsert",
        payload: sampleNote,
      },
    ]);
    await writer.close();

    const reader = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair: readerPair,
      origin: "device-b",
      createGun: () => fake as never,
    });
    const pull = await reader.pull(null);
    expect(pull.mutations).toHaveLength(0);
    await reader.close();
  });

  it("rejects invalid outbox payloads", async () => {
    const pair = await generatePair();
    const fake = createFakeGun();
    const transport = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      origin: "device-a",
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

  it("encrypts with space key and still decrypts legacy SEA rows", async () => {
    const pair = await generatePair();
    const { generateSpaceKey } = await import("@/shared/crypto/envelope");
    const spaceKey = await generateSpaceKey();
    const spaceId = "space-test-1";
    const fake = createFakeGun();

    const writer = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      spaceKey,
      spaceId,
      origin: "device-a",
      createGun: () => fake as never,
    });
    await writer.push([
      {
        idempotencyKey: "space-k1",
        entity: "notes",
        op: "upsert",
        payload: sampleNote,
      },
    ]);

    const rows = [...fake.store.values()] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const wireCt = String(rows[0]!.ciphertext);
    expect(wireCt).toContain('"k":"space"');
    expect(wireCt).not.toContain(sampleNote.title);

    // Inject a legacy SEA-encrypted row alongside space-sealed traffic.
    const legacyCt = await SEA.encrypt(sampleNote, pair);
    fake
      .user()
      .get("app_sync")
      .get("notes")
      .get("legacy-k")
      .put({
        v: PROTOCOL_VERSION,
        idempotencyKey: "legacy-k",
        entity: "notes",
        op: "upsert",
        ciphertext: legacyCt,
        seq: 99,
        origin: "device-b",
      });

    const reader = new GunSyncTransport({
      peers: ["http://fake/gun"],
      pair,
      origin: "device-c",
      spaceKey,
      spaceId,
      createGun: () => fake as never,
    });
    const pull = await reader.pull(null);
    const keys = pull.mutations.map((m) => m.idempotencyKey).sort();
    expect(keys).toEqual(["legacy-k", "space-k1"]);

    await writer.close();
    await reader.close();
  });
});
