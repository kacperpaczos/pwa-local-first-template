import * as z from "zod/mini";

export const syncMetaSchema = z.object({
  id: z.string(),
  cursor: z.nullable(z.string()),
  updated_at: z.string(),
});

export type SyncMeta = z.infer<typeof syncMetaSchema>;

export const RELAY_SYNC_META_ID = "relay";
