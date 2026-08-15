import * as z from "zod/mini";

/**
 * Upper bound for any Lamport counter arriving from a peer.
 *
 * The clock is a plain JS number, so a value at or above 2^53 makes
 * `Math.max(clock, hint) + 1 === clock` — the clock freezes, every later
 * local edit gets an identical value, and LWW silently degenerates to the
 * tie-break comparison. A single signed op carrying a huge counter would
 * poison this device permanently (the value gets written into note rows and
 * re-seeded from them on every boot), so the bound is enforced at the parse
 * boundary rather than trusted. It sits far above any reachable edit count.
 */
export const MAX_LAMPORT = 2 ** 40;

const lamportSchema = z.number().check(z.int(), z.gte(0), z.lte(MAX_LAMPORT));

export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  title_lamport: lamportSchema,
  /** Plain-text projection of `body_doc`, kept in sync for fast reads/filtering. */
  body: z.string(),
  /** Base64-encoded Loro CRDT snapshot — source of truth for `body`. */
  body_doc: z.string(),
  updated_at: z.string(),
  deleted_at: z.nullable(z.string()),
  deleted_lamport: lamportSchema,
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
