import * as z from "zod/mini";

export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  updated_at: z.string(),
  deleted_at: z.nullable(z.string()),
  lamport: z.number(),
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

/** @deprecated use syncMutationSchema from shared/sync/protocol */
export const syncMutationMessageSchema = z.object({
  idempotencyKey: z.string(),
  entity: z.literal("notes"),
  op: z.enum(["upsert", "soft_delete"]),
  payload: noteSchema,
});

export type SyncMutationMessage = z.infer<typeof syncMutationMessageSchema>;

export function parseNote(data: unknown): Note {
  return noteSchema.parse(data);
}

export function parseCreateNoteInput(data: unknown): CreateNoteInput {
  return createNoteInputSchema.parse(data);
}
