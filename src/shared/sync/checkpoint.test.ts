import { beforeEach, describe, expect, it } from "vitest";
import { createBodyDoc } from "../db/crdt";
import type { Note } from "../db/schemas";
import { generateSpaceKey } from "@/shared/crypto/envelope";
import {
  CHECKPOINT_MAX_STORED,
  CHECKPOINT_STORAGE_KEY,
  buildCheckpoint,
  listLocalCheckpoints,
  openCheckpoint,
  publishCheckpointToGun,
  sealCheckpoint,
  storeCheckpointLocal,
} from "./checkpoint";

function note(partial: Partial<Note> & Pick<Note, "id">): Note {
  const body = createBodyDoc("body");
  return {
    title: "t",
    title_lamport: 1,
    body: body.text,
    body_doc: body.doc,
    updated_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    deleted_lamport: 0,
    ...partial,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("buildCheckpoint", () => {
  it("sets seqCovered from max note lamports", () => {
    const cp = buildCheckpoint(
      [
        note({ id: "a", title_lamport: 3, deleted_lamport: 1 }),
        note({ id: "b", title_lamport: 2, deleted_lamport: 9 }),
      ],
      { now: new Date("2026-08-03T12:00:00.000Z") },
    );
    expect(cp.seqCovered).toBe(9);
    expect(cp.exportedAt).toBe("2026-08-03T12:00:00.000Z");
    expect(cp.notes).toHaveLength(2);
  });

  it("is 0 for an empty note set", () => {
    expect(buildCheckpoint([]).seqCovered).toBe(0);
  });
});

describe("sealCheckpoint / openCheckpoint", () => {
  it("round-trips through envelope crypto", async () => {
    const key = await generateSpaceKey();
    const checkpoint = buildCheckpoint([note({ id: "n1", title: "hello", title_lamport: 5 })]);
    const sealed = await sealCheckpoint(checkpoint, key);
    expect(sealed.nonce.length).toBeGreaterThan(0);
    expect(sealed.ciphertext.length).toBeGreaterThan(0);

    const opened = await openCheckpoint(sealed, key);
    expect(opened).toEqual(checkpoint);
  });

  it("rejects the wrong space key", async () => {
    const a = await generateSpaceKey();
    const b = await generateSpaceKey();
    const sealed = await sealCheckpoint(buildCheckpoint([]), a);
    await expect(openCheckpoint(sealed, b)).rejects.toThrow();
  });
});

describe("local checkpoint storage", () => {
  beforeEach(() => {
    // no-op — tests inject memory storage
  });

  it("keeps at most two sealed checkpoints", async () => {
    const storage = memoryStorage();
    const key = await generateSpaceKey();
    for (let i = 0; i < 3; i++) {
      const cp = buildCheckpoint([], {
        now: new Date(`2026-08-0${i + 1}T00:00:00.000Z`),
      });
      const sealed = await sealCheckpoint(cp, key);
      storeCheckpointLocal(sealed, cp, storage);
    }
    const listed = listLocalCheckpoints(storage);
    expect(listed).toHaveLength(CHECKPOINT_MAX_STORED);
    expect(listed[0]!.exportedAt).toBe("2026-08-03T00:00:00.000Z");
    expect(JSON.parse(storage.getItem(CHECKPOINT_STORAGE_KEY)!)).toHaveLength(2);
  });
});

describe("publishCheckpointToGun", () => {
  it("uses publishCheckpoint when available", async () => {
    const calls: unknown[] = [];
    const key = await generateSpaceKey();
    const cp = buildCheckpoint([]);
    const sealed = await sealCheckpoint(cp, key);
    const ok = await publishCheckpointToGun(sealed, cp, {
      publishCheckpoint: async (payload) => {
        calls.push(payload);
      },
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("falls back to user.get('checkpoints').put", async () => {
    const puts: unknown[] = [];
    const key = await generateSpaceKey();
    const cp = buildCheckpoint([]);
    const sealed = await sealCheckpoint(cp, key);
    const ok = await publishCheckpointToGun(sealed, cp, {
      user: {
        get: (k: string) => {
          expect(k).toBe("checkpoints");
          return {
            put: (data: unknown, cb?: (ack: unknown) => void) => {
              puts.push(data);
              cb?.({});
            },
          };
        },
      },
    });
    expect(ok).toBe(true);
    expect(puts).toHaveLength(1);
  });

  it("returns false when no transport", async () => {
    const key = await generateSpaceKey();
    const cp = buildCheckpoint([]);
    const sealed = await sealCheckpoint(cp, key);
    expect(await publishCheckpointToGun(sealed, cp, null)).toBe(false);
  });
});
