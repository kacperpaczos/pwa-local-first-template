export type SyncMutation = {
  idempotencyKey: string;
  entity: "notes";
  op: "upsert" | "soft_delete";
  payload: unknown;
};

export type PushResult = {
  accepted: readonly string[];
  rejected: readonly { idempotencyKey: string; reason: string }[];
};

export type PullResult = {
  cursor: string | null;
  mutations: readonly SyncMutation[];
};

export type Conflict = {
  local: SyncMutation;
  remote: SyncMutation;
};

/**
 * Swappable sync adapter.
 * Default: GunSyncTransport (SEA-signed mesh). Fallback: NoopSyncTransport.
 */
export interface SyncTransport {
  push(outbox: readonly SyncMutation[]): Promise<PushResult>;
  pull(cursor: string | null): Promise<PullResult>;
  resolve(conflicts: readonly Conflict[]): Promise<void>;
}
