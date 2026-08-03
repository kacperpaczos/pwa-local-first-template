import * as z from "zod/mini";

export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  title_lamport: z.number(),
  /** Plain-text projection of `body_doc`, kept in sync for fast reads/filtering. */
  body: z.string(),
  /** Base64-encoded Loro CRDT snapshot — source of truth for `body`. */
  body_doc: z.string(),
  updated_at: z.string(),
  deleted_at: z.nullable(z.string()),
  deleted_lamport: z.number(),
});

export type Note = z.infer<typeof noteSchema>;

export const createNoteInputSchema = z.object({
  title: z.string().check(z.minLength(1)),
  body: z.optional(z.string()),
});

export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

export const updateNoteInputSchema = z.object({
  title: z.optional(z.string().check(z.minLength(1))),
  body: z.optional(z.string()),
});

export type UpdateNoteInput = z.infer<typeof updateNoteInputSchema>;

export function parseNote(data: unknown): Note {
  return noteSchema.parse(data);
}

export function parseCreateNoteInput(data: unknown): CreateNoteInput {
  return createNoteInputSchema.parse(data);
}
