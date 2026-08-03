import * as z from "zod/mini";
import { noteSchema } from "../db/schemas";

/** Current mutation wire protocol version (Gun SEA graph). */
export const PROTOCOL_VERSION = 1;

/** Inclusive lower bound of versions this client can ingest. */
export const SUPPORTED_MIN_V = 1;

/** Inclusive upper bound of versions this client can ingest. */
export const SUPPORTED_MAX_V = 1;

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

export const syncMutationSchema = z.object({
  v: z.number(),
  idempotencyKey: z.string().check(z.minLength(1)),
  entity: z.literal("notes"),
  op: z.enum(["upsert", "soft_delete"]),
  payload: noteSchema,
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
  return parsed;
}
