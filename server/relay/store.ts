import {
  syncMutationSchema,
  type ValidatedSyncMutation,
} from "../../src/shared/sync/protocol.ts";

export type LogEntry = {
  seq: number;
  mutation: ValidatedSyncMutation;
};

export type PushRejection = {
  idempotencyKey: string;
  reason: string;
};

export type PushOutcome = {
  accepted: string[];
  rejected: PushRejection[];
};

export type PullOutcome = {
  cursor: string | null;
  mutations: ValidatedSyncMutation[];
};

/**
 * Pure in-memory append-only mutation log used by the WebSocket relay.
 * Testable without sockets.
 */
export class RelayStore {
  private readonly log: LogEntry[] = [];
  private readonly seenKeys = new Set<string>();

  reset(): void {
    this.log.length = 0;
    this.seenKeys.clear();
  }

  stats(): { entries: number; keys: number } {
    return { entries: this.log.length, keys: this.seenKeys.size };
  }

  push(mutations: readonly unknown[]): PushOutcome {
    const accepted: string[] = [];
    const rejected: PushRejection[] = [];

    for (const raw of mutations) {
      const parsed = syncMutationSchema.safeParse(raw);
      if (!parsed.success) {
        rejected.push({
          idempotencyKey:
            typeof raw === "object" &&
            raw &&
            "idempotencyKey" in raw &&
            typeof (raw as { idempotencyKey: unknown }).idempotencyKey === "string"
              ? (raw as { idempotencyKey: string }).idempotencyKey
              : "unknown",
          reason: "invalid_mutation",
        });
        continue;
      }

      const mutation = parsed.data;
      if (this.seenKeys.has(mutation.idempotencyKey)) {
        accepted.push(mutation.idempotencyKey);
        continue;
      }

      this.seenKeys.add(mutation.idempotencyKey);
      this.log.push({ seq: this.log.length + 1, mutation });
      accepted.push(mutation.idempotencyKey);
    }

    return { accepted, rejected };
  }

  pull(cursor: string | null): PullOutcome {
    const fromSeq = cursor ? Number(cursor) : 0;
    const start = Number.isFinite(fromSeq) ? fromSeq : 0;
    const mutations = this.log.filter((entry) => entry.seq > start).map((e) => e.mutation);
    return {
      cursor: this.log.length > 0 ? String(this.log.length) : cursor,
      mutations,
    };
  }
}
