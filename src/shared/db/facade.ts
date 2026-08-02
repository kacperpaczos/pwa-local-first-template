import type { AppDatabase } from "./client";
import { createEntityId } from "./ids";
import { nextLamport } from "./lamport";
import {
  parseCreateNoteInput,
  type CreateNoteInput,
  type Note,
  type UpdateNoteInput,
  updateNoteInputSchema,
} from "./schemas";

/**
 * Single write API for the UI.
 * Keeps persistence + outbox swappable without touching features.
 */
export type PersistenceFacade = {
  createNote: (input: CreateNoteInput) => Promise<Note>;
  updateNote: (id: string, input: UpdateNoteInput) => Promise<Note>;
  softDeleteNote: (id: string) => Promise<Note>;
};

export function createPersistenceFacade(db: AppDatabase): PersistenceFacade {
  return {
    async createNote(rawInput) {
      const input = parseCreateNoteInput(rawInput);
      const now = new Date().toISOString();
      const note: Note = {
        id: createEntityId(),
        title: input.title.trim(),
        body: input.body?.trim() ?? "",
        updated_at: now,
        deleted_at: null,
        lamport: nextLamport(),
      };

      const tx = db.offline.createOfflineTransaction({
        mutationFnName: "syncNotes",
        autoCommit: false,
      });

      tx.mutate(() => {
        db.notes.insert(note);
      });
      await tx.commit();

      return note;
    },

    async updateNote(id, rawInput) {
      const input = updateNoteInputSchema.parse(rawInput);
      const existing = db.notes.get(id);
      if (!existing || existing.deleted_at) {
        throw new Error(`Note not found: ${id}`);
      }

      const updated: Note = {
        ...existing,
        title: input.title?.trim() ?? existing.title,
        body: input.body ?? existing.body,
        updated_at: new Date().toISOString(),
        lamport: nextLamport(existing.lamport),
      };

      const tx = db.offline.createOfflineTransaction({
        mutationFnName: "syncNotes",
        autoCommit: false,
      });

      tx.mutate(() => {
        db.notes.update(id, (draft) => {
          draft.title = updated.title;
          draft.body = updated.body;
          draft.updated_at = updated.updated_at;
          draft.lamport = updated.lamport;
        });
      });
      await tx.commit();

      return updated;
    },

    async softDeleteNote(id) {
      const existing = db.notes.get(id);
      if (!existing || existing.deleted_at) {
        throw new Error(`Note not found: ${id}`);
      }

      const now = new Date().toISOString();
      const updated: Note = {
        ...existing,
        deleted_at: now,
        updated_at: now,
        lamport: nextLamport(existing.lamport),
      };

      const tx = db.offline.createOfflineTransaction({
        mutationFnName: "syncNotes",
        autoCommit: false,
      });

      tx.mutate(() => {
        db.notes.update(id, (draft) => {
          draft.deleted_at = updated.deleted_at;
          draft.updated_at = updated.updated_at;
          draft.lamport = updated.lamport;
        });
      });
      await tx.commit();

      return updated;
    },
  };
}
