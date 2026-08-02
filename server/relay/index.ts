import { WebSocketServer, type WebSocket } from "ws";
import {
  parseClientMessage,
  syncMutationSchema,
  type ValidatedSyncMutation,
} from "../../src/shared/sync/protocol.ts";

type LogEntry = {
  seq: number;
  mutation: ValidatedSyncMutation;
};

const PORT = Number(process.env.SYNC_RELAY_PORT ?? 8787);

const log: LogEntry[] = [];
const seenKeys = new Set<string>();

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function handlePush(
  ws: WebSocket,
  requestId: string,
  mutations: ValidatedSyncMutation[],
): void {
  const accepted: string[] = [];
  const rejected: { idempotencyKey: string; reason: string }[] = [];

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
    if (seenKeys.has(mutation.idempotencyKey)) {
      accepted.push(mutation.idempotencyKey);
      continue;
    }

    seenKeys.add(mutation.idempotencyKey);
    log.push({ seq: log.length + 1, mutation });
    accepted.push(mutation.idempotencyKey);
  }

  send(ws, {
    type: "push_ack",
    requestId,
    accepted,
    rejected,
  });
}

function handlePull(ws: WebSocket, requestId: string, cursor: string | null): void {
  const fromSeq = cursor ? Number(cursor) : 0;
  const start = Number.isFinite(fromSeq) ? fromSeq : 0;
  const mutations = log.filter((entry) => entry.seq > start).map((e) => e.mutation);
  send(ws, {
    type: "pull_result",
    requestId,
    cursor: log.length > 0 ? String(log.length) : cursor,
    mutations,
  });
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const message = parseClientMessage(JSON.parse(text) as unknown);

      if (message.type === "push") {
        handlePush(ws, message.requestId, message.mutations);
        return;
      }

      handlePull(ws, message.requestId, message.cursor);
    } catch (error) {
      send(ws, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

console.log(`[sync-relay] listening on ws://127.0.0.1:${PORT}`);
