import * as z from "zod/mini";
import { noteSchema } from "@/shared/db/schemas";

/**
 * Op payloads carried by the per-device logs. Unlike the retired wire
 * protocol's decorative `op` field, `kind` here is authoritative — the
 * materializer switches on it.
 *
 * v0.1 ships FULL-STATE `upsert` payloads (whole Note row incl. the Loro
 * snapshot), not deltas: ops stay idempotent and order-tolerant at the
 * materializer, and `mergeNote` keeps doing per-field resolution.
 * Loro `export({mode:"update"})` deltas are a documented v0.2 optimization.
 */
export const noteOpPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), note: noteSchema }),
  z.object({
    kind: z.literal("delete"),
    id: z.string(),
    deleted_at: z.string(),
    deleted_lamport: z.number(),
  }),
]);

export type NoteOpPayload = z.infer<typeof noteOpPayloadSchema>;

type OpPayloadSchema = { parse(data: unknown): unknown };

const registry = new Map<string, OpPayloadSchema>();

/** Idempotent for the same schema reference; throws on a conflicting one. */
export function registerOpPayloadSchema(entity: string, schema: OpPayloadSchema): void {
  const existing = registry.get(entity);
  if (existing && existing !== schema) {
    throw new Error(`Conflicting op payload schema for entity "${entity}"`);
  }
  registry.set(entity, schema);
}

export function getOpPayloadSchema(entity: string): OpPayloadSchema | undefined {
  return registry.get(entity);
}

registerOpPayloadSchema("notes", noteOpPayloadSchema);

export function encodeOpPayload(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** Parse + validate payload bytes for an entity. Throws on garbage — callers quarantine. */
export function decodeOpPayload(entity: string, bytes: Uint8Array): unknown {
  const schema = getOpPayloadSchema(entity);
  if (!schema) {
    throw new Error(`No op payload schema registered for entity "${entity}"`);
  }
  return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export function decodeNoteOpPayload(bytes: Uint8Array): NoteOpPayload {
  return noteOpPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
