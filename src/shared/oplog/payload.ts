import * as z from "zod/mini";
import { MAX_COUNTER, MAX_LAMPORT } from "@/shared/db/schemas";

/**
 * Op payloads carried by the per-device logs. `kind` is authoritative — the
 * materializer switches on it.
 *
 * Both payloads are DELTAS, not snapshots, and that is the point of the demo:
 *
 * - `increment` carries only the amount. Folding is addition, addition
 *   commutes, so any interleaving of any devices' logs converges — the
 *   classic grow-only counter, expressed as op-log materialization.
 * - `set_label` carries the full new value plus a Lamport timestamp; folding
 *   is last-writer-wins with a deterministic tie-break. Same op shape, very
 *   different merge policy — which is exactly what the payload registry
 *   exists to express per entity.
 */
export const counterOpPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("increment"),
    amount: z.number().check(z.int(), z.gte(1), z.lte(MAX_COUNTER)),
  }),
  z.object({
    kind: z.literal("set_label"),
    label: z.string(),
    // Bounded like the schema's counters — see MAX_LAMPORT.
    lamport: z.number().check(z.int(), z.gte(0), z.lte(MAX_LAMPORT)),
  }),
]);

export type CounterOpPayload = z.infer<typeof counterOpPayloadSchema>;

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

registerOpPayloadSchema("counter", counterOpPayloadSchema);

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

export function decodeCounterOpPayload(bytes: Uint8Array): CounterOpPayload {
  return counterOpPayloadSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
