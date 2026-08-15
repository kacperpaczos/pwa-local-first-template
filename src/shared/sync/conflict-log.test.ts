import { beforeEach, describe, expect, it } from "vitest";
import {
  CONFLICT_LOG_MAX_ENTRIES,
  CONFLICT_LOG_RETENTION_MS,
  CONFLICT_LOG_STORAGE_KEY,
  clearOldConflicts,
  listConflicts,
  recordConflict,
} from "./conflict-log";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => map,
  };
}

describe("conflict-log", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("records and lists conflicts", () => {
    const entry = recordConflict(
      {
        entityId: "n1",
        field: "label",
        lostValue: "local",
        lostLamport: 2,
        wonValue: "remote",
        at: "2026-08-01T00:00:00.000Z",
      },
      storage,
    );
    expect(entry).not.toBeNull();
    expect(entry!.id).toBeTruthy();
    expect(listConflicts({ entityId: "n1" }, storage)).toHaveLength(1);
    expect(listConflicts({ entityId: "other" }, storage)).toHaveLength(0);
  });

  it("returns null without storage (no localStorage)", () => {
    expect(
      recordConflict(
        {
          entityId: "n1",
          field: "label",
          lostValue: "a",
          lostLamport: 1,
          wonValue: "b",
        },
        undefined,
      ),
    ).toBeNull();
  });

  it("caps at 200 entries", () => {
    for (let i = 0; i < CONFLICT_LOG_MAX_ENTRIES + 25; i++) {
      recordConflict(
        {
          entityId: "n",
          field: "label",
          lostValue: `lost-${i}`,
          lostLamport: i,
          wonValue: `won-${i}`,
          at: "2026-08-01T00:00:00.000Z",
        },
        storage,
      );
    }
    expect(listConflicts({}, storage)).toHaveLength(CONFLICT_LOG_MAX_ENTRIES);
  });

  it("clears entries older than 30 days", () => {
    const old = {
      id: "old-id",
      entityId: "old",
      field: "label" as const,
      lostValue: null,
      lostLamport: 1,
      wonValue: "2026-01-01T00:00:00.000Z",
      at: "2026-01-01T00:00:00.000Z",
    };
    const fresh = {
      id: "fresh-id",
      entityId: "fresh",
      field: "label" as const,
      lostValue: "a",
      lostLamport: 2,
      wonValue: "b",
      at: "2026-08-01T00:00:00.000Z",
    };
    storage.setItem(CONFLICT_LOG_STORAGE_KEY, JSON.stringify([old, fresh]));

    const now = Date.parse("2026-08-03T00:00:00.000Z");
    expect(CONFLICT_LOG_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const removed = clearOldConflicts(now, storage);
    expect(removed).toBe(1);
    const left = listConflicts({ now }, storage);
    expect(left).toHaveLength(1);
    expect(left[0]!.entityId).toBe("fresh");
    expect(storage.getItem(CONFLICT_LOG_STORAGE_KEY)).toBeTruthy();
  });
});
