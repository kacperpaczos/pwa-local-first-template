import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Gun from "gun";

const PORT = Number(process.env.GUN_PEER_PORT ?? 8765);
const HOST = process.env.GUN_PEER_HOST ?? "127.0.0.1";
const TEST_MODE = process.env.GUN_PEER_TEST_MODE === "1" || process.env.NODE_ENV === "test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, TEST_MODE ? ".gun-test-data" : ".gun-data");

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function wipeDataDir(): void {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  ensureDataDir();
}

ensureDataDir();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const isTestPath = url.pathname.startsWith("/test/");

  // Always-available liveness probe (production + test).
  if (url.pathname === "/healthz" && req.method === "GET") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (isTestPath) {
    if (!TEST_MODE) {
      writeJson(res, 403, { error: "test mode disabled" });
      return;
    }

    if (url.pathname === "/test/health" && req.method === "GET") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/test/reset" && req.method === "POST") {
      // Best-effort wipe of radisk files. Clients keep their own Gun caches;
      // e2e uses a fresh SEA pair per openTwoPeers to isolate graph space.
      wipeDataDir();
      writeJson(res, 200, { ok: true });
      return;
    }

    writeJson(res, 404, { error: "not found" });
    return;
  }

  // Leave /gun for Gun's own request listener; 404 everything else.
  if (!url.pathname.startsWith("/gun")) {
    writeJson(res, 404, { error: "not found" });
  }
});

const gun = Gun({
  web: server,
  file: DATA_DIR,
  radisk: true,
});

server.listen(PORT, HOST, () => {
  console.log(`[gun-peer] listening on http://${HOST}:${PORT}/gun (test=${TEST_MODE})`);
});

export { gun, server, PORT, HOST };
