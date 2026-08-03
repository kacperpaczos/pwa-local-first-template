import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ValidatedSyncMutation } from "../../src/shared/sync/protocol.ts";
import { RelayStore } from "./store.ts";

const PORT = Number(process.env.SYNC_RELAY_PORT ?? 8787);
const TEST_MODE =
  process.env.SYNC_RELAY_TEST_MODE === "1" || process.env.NODE_ENV === "test";

export const store = new RelayStore();

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
  const outcome = store.push(mutations);
  send(ws, {
    type: "push_ack",
    requestId,
    accepted: outcome.accepted,
    rejected: outcome.rejected,
  });
}

function handlePull(ws: WebSocket, requestId: string, cursor: string | null): void {
  const outcome = store.pull(cursor);
  send(ws, {
    type: "pull_result",
    requestId,
    cursor: outcome.cursor,
    mutations: outcome.mutations,
  });
}

function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (url.pathname === "/test/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/test/stats" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(store.stats()));
    return;
  }

  if (url.pathname === "/test/reset" && req.method === "POST") {
    if (!TEST_MODE) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "test mode disabled" }));
      return;
    }
    store.reset();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...store.stats() }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

const server = http.createServer(handleHttpRequest);
const wss = new WebSocketServer({ server });

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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sync-relay] ws://127.0.0.1:${PORT} (testMode=${TEST_MODE})`);
});
