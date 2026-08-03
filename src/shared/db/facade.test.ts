import { beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFacade } from "./facade";
import type { AppDatabase } from "./client";
import type { Note } from "./schemas";
import { resetLamportForTests } from "./lamport";

/**
 * `createFakeDb()` below hand-rolls a Map-backed collection + offline
 * executor stand-in — no real TanStack DB or OPFS SQLite runs in this file.
 * This verifies PersistenceFacade's own outbox/lamport wiring, not the real
 * persistence engine — that's only exercised for real in e2e.
 */
function createFakeDb(options: { syncThrows?: boolean } = {}) {
  const map = new Map<string, Note>();

  const notes = {
    get: (id: string) => map.get(id),
    insert: (note: Note) => {
      map.set(note.id, structuredClone(note));
    },
    update: (id: string, cb: (draft: Note) => void) => {
      const current = map.get(id);
      if (!current) return;
      const draft = structuredClone(current);
      cb(draft);
      map.set(id, draft);
    },
  };

  const offline = {
    createOfflineTransaction: () => {
      let mutateFn: (() => void) | null = null;
      return {
        mutate: (fn: () => void) => {
          mutateFn = fn;
        },
        commit: async () => {
          mutateFn?.();
          if (options.syncThrows) {
            throw new Error("relay down");
          }
        },
      };
    },
  };

  return {
    db: { notes, offline } as unknown as AppDatabase,
    map,
  };
}

describe("PersistenceFacade", () => {
  beforeEach(() => {
    resetLamportForTests(0);
  });

  it("createNote sets body_doc and bumps title_lamport", async () => {
    const { db, map } = createFakeDb();
    const facade = createPersistenceFacade(db);
    const note = await facade.createNote({ title: "Hello", body: "world" });
    expect(note.title).toBe("Hello");
    expect(note.body).toBe("world");
    expect(note.body_doc.length).toBeGreaterThan(0);
    expect(note.title_lamport).toBeGreaterThan(0);
    expect(map.get(note.id)?.body_doc).toBe(note.body_doc);
  });

  it("updateNote bumps title_lamport only when the title changes", async () => {
    const { db } = createFakeDb();
    const facade = createPersistenceFacade(db);
    const created = await facade.createNote({ title: "A", body: "x" });
    const bodyOnly = await facade.updateNote(created.id, { body: "y" });
    expect(bodyOnly.title_lamport).toBe(created.title_lamport);
    const titled = await facade.updateNote(created.id, { title: "B" });
    expect(titled.title_lamport).toBeGreaterThan(created.title_lamport);
  });

  it("softDeleteNote bumps deleted_lamport", async () => {
    const { db } = createFakeDb();
    const facade = createPersistenceFacade(db);
    const created = await facade.createNote({ title: "del" });
    const deleted = await facade.softDeleteNote(created.id);
    expect(deleted.deleted_at).not.toBeNull();
    expect(deleted.deleted_lamport).toBeGreaterThan(0);
  });

  it("keeps the local write when sync throws after mutate", async () => {
    const { db, map } = createFakeDb({ syncThrows: true });
    const facade = createPersistenceFacade(db);
    const note = await facade.createNote({ title: "offline-ok" });
    expect(map.has(note.id)).toBe(true);
    expect(note.title).toBe("offline-ok");
  });
});
