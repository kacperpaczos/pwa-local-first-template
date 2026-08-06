import * as z from "zod/mini";
import { noteSchema } from "../db/schemas";
import { getEntitySchema, registerEntitySchema } from "./entity-registry";

registerEntitySchema("notes", noteSchema);

/**
 * Current mutation wire protocol version (Gun SEA graph).
 * v2 adds a required `origin` field on the wire (per-device id used to
 * disambiguate independent writers in the sync cursor — see
 * GunSyncTransport). v1 peers can't produce it, so v1 rows are rejected by
 * {@link isSupportedProtocolVersion} and surface as "outdated" sync status.
 */
export const PROTOCOL_VERSION = 2;

/** Inclusive lower bound of versions this client can ingest. */
export const SUPPORTED_MIN_V = 2;

/** Inclusive upper bound of versions this client can ingest. */
export const SUPPORTED_MAX_V = 2;

export function isSupportedProtocolVersion(v: number): boolean {
  return Number.isInteger(v) && v >= SUPPORTED_MIN_V && v <= SUPPORTED_MAX_V;
}

export class ProtocolVersionError extends Error {
  readonly name = "ProtocolVersionError";
  readonly version: number;

  constructor(version: number) {
    super(
      `Unsupported protocol version ${version} (supported ${SUPPORTED_MIN_V}–${SUPPORTED_MAX_V})`,
    );
    this.version = version;
  }
}

export class UnknownEntityError extends Error {
  readonly name = "UnknownEntityError";
  readonly entity: string;

  constructor(entity: string) {
    super(`Unknown sync entity "${entity}"`);
    this.entity = entity;
  }
}

export const syncMutationSchema = z.object({
  v: z.number(),
  idempotencyKey: z.string().check(z.minLength(1)),
  entity: z.string().check(z.minLength(1)),
  op: z.enum(["upsert", "soft_delete"]),
  payload: z.unknown(),
});

export type ValidatedSyncMutation = z.infer<typeof syncMutationSchema>;

/**
 * Parse and validate a sync mutation. Missing `v` defaults to
 * {@link PROTOCOL_VERSION} (local outbox). Versions outside
 * {@link SUPPORTED_MIN_V}–{@link SUPPORTED_MAX_V} throw {@link ProtocolVersionError}.
 */
export function parseSyncMutation(data: unknown): ValidatedSyncMutation {
  const input =
    data !== null && typeof data === "object"
      ? { v: PROTOCOL_VERSION, ...(data as Record<string, unknown>) }
      : data;

  const parsed = syncMutationSchema.parse(input);
  if (!isSupportedProtocolVersion(parsed.v)) {
    throw new ProtocolVersionError(parsed.v);
  }

  const entitySchema = getEntitySchema(parsed.entity);
  if (!entitySchema) {
    throw new UnknownEntityError(parsed.entity);
  }
  entitySchema.parse(parsed.payload);

  return parsed;
}
