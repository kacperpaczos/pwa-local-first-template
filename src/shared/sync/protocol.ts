import * as z from "zod/mini";
import { noteSchema } from "../db/schemas";

export const syncMutationSchema = z.object({
  idempotencyKey: z.string().check(z.minLength(1)),
  entity: z.literal("notes"),
  op: z.enum(["upsert", "soft_delete"]),
  payload: noteSchema,
});

export type ValidatedSyncMutation = z.infer<typeof syncMutationSchema>;

export const clientPushMessageSchema = z.object({
  type: z.literal("push"),
  requestId: z.string(),
  mutations: z.array(syncMutationSchema),
});

export const clientPullMessageSchema = z.object({
  type: z.literal("pull"),
  requestId: z.string(),
  cursor: z.nullable(z.string()),
});

export const clientMessageSchema = z.union([
  clientPushMessageSchema,
  clientPullMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const serverPushAckSchema = z.object({
  type: z.literal("push_ack"),
  requestId: z.string(),
  accepted: z.array(z.string()),
  rejected: z.array(
    z.object({
      idempotencyKey: z.string(),
      reason: z.string(),
    }),
  ),
});

export const serverPullResultSchema = z.object({
  type: z.literal("pull_result"),
  requestId: z.string(),
  cursor: z.nullable(z.string()),
  mutations: z.array(syncMutationSchema),
});

export const serverErrorSchema = z.object({
  type: z.literal("error"),
  requestId: z.optional(z.string()),
  message: z.string(),
});

export const serverMessageSchema = z.union([
  serverPushAckSchema,
  serverPullResultSchema,
  serverErrorSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(data: unknown): ClientMessage {
  return clientMessageSchema.parse(data);
}

export function parseServerMessage(data: unknown): ServerMessage {
  return serverMessageSchema.parse(data);
}

export function parseSyncMutation(data: unknown): ValidatedSyncMutation {
  return syncMutationSchema.parse(data);
}
