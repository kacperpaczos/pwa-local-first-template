import type { AppDatabase } from "./client";
import { ensureStoragePersisted } from "@/backup/status";
import { createBodyDoc, updateBodyDoc } from "./crdt";
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
      void ensureStoragePersisted();
      const input = parseCreateNoteInput(rawInput);
      const now = new Date().toISOString();
      const body = createBodyDoc(input.body?.trim() ?? "");
      const note: Note = {
        id: createEntityId(),
        title: input.title.trim(),
        title_lamport: nextLamport(),
        body: body.text,
        body_doc: body.doc,
        updated_at: now,
        deleted_at: null,
        deleted_lamport: 0,
      };

      const tx = db.offline.createOfflineTransaction({
        mutationFnName: "syncNotes",
        autoCommit: false,
      });

      tx.mutate(() => {
        db.notes.insert(note);
      });
      try {
        await tx.commit();
      } catch (error) {
        if (db.notes.get(note.id)) {
          return note;
        }
        throw error;
      }

      return note;
    },

    async updateNote(id, rawInput) {
      const input = updateNoteInputSchema.parse(rawInput);
      const existing = db.notes.get(id);
      if (!existing || existing.deleted_at) {
        throw new Error(`Note not found: ${id}`);
      }

      const titleChanged = input.title !== undefined && input.title.trim() !== existing.title;
      const body =
        input.body !== undefined && input.body !== existing.body
          ? updateBodyDoc(existing.body_doc, input.body)
          : { text: existing.body, doc: existing.body_doc };

      const updated: Note = {
        ...existing,
        title: input.title?.trim() ?? existing.title,
        title_lamport: titleChanged ? nextLamport(existing.title_lamport) : existing.title_lamport,
        body: body.text,
        body_doc: body.doc,
        updated_at: new Date().toISOString(),
      };

      const tx = db.offline.createOfflineTransaction({
        mutationFnName: "syncNotes",
        autoCommit: false,
      });

      tx.mutate(() => {
        db.notes.update(id, (draft) => {
          draft.title = updated.title;
          draft.title_lamport = updated.title_lamport;
          draft.body = updated.body;
          draft.body_doc = updated.body_doc;
          draft.updated_at = updated.updated_at;
        });
      });
      try {
        await tx.commit();
      } catch (error) {
        const current = db.notes.get(id);
        if (current && current.title_lamport === updated.title_lamport && current.body === updated.body) {
          return updated;
        }
        throw error;
      }

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
        deleted_lamport: nextLamport(existing.deleted_lamport),
      };

      const tx = db.offline.createOfflineTransaction({
        mutationFnName: "syncNotes",
        autoCommit: false,
      });

      tx.mutate(() => {
        db.notes.update(id, (draft) => {
          draft.deleted_at = updated.deleted_at;
          draft.updated_at = updated.updated_at;
          draft.deleted_lamport = updated.deleted_lamport;
        });
      });
      try {
        await tx.commit();
      } catch (error) {
        const current = db.notes.get(id);
        if (current?.deleted_at) {
          return updated;
        }
        throw error;
      }

      return updated;
    },
  };
}
