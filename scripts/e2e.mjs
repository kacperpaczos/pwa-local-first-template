#!/usr/bin/env node
// Runs the Playwright suite on ports that are actually free.
//
// The e2e stack needs two listeners: the Gun peer (GUN_PEER_PORT, default
// 8765) and the preview web server (E2E_WEB_PORT, default 4173). Either can
// be taken by something unrelated on a dev machine, and the failure mode is
// an opaque "webServer was not able to start". So: probe the defaults, fall
// back to an OS-assigned free port, and export both before Playwright is
// spawned — its config reads them synchronously, and workers inherit env at
// fork time.
//
// An explicitly set GUN_PEER_PORT / E2E_WEB_PORT always wins, so CI and
// `docs/` keep describing the ports they actually use.
import { spawn } from "node:child_process";
import net from "node:net";

const DEFAULT_GUN_PORT = 8765;
const DEFAULT_WEB_PORT = 4173;

/** Resolves true when nothing else holds the port on any local interface. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    // 0.0.0.0 so a listener bound to any interface (not just loopback) counts
    // as a conflict — that is exactly how the 8765 collision presents.
    server.listen(port, "0.0.0.0");
  });
}

/** An OS-assigned free port. Racy in principle, fine between probe and bind. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function resolvePort(envName, preferred) {
  const explicit = process.env[envName];
  if (explicit) {
    return { port: Number(explicit), source: "env" };
  }
  if (await isPortFree(preferred)) {
    return { port: preferred, source: "default" };
  }
  return { port: await freePort(), source: "auto" };
}

const gun = await resolvePort("GUN_PEER_PORT", DEFAULT_GUN_PORT);
const web = await resolvePort("E2E_WEB_PORT", DEFAULT_WEB_PORT);

for (const [name, picked, fallback] of [
  ["GUN_PEER_PORT", gun, DEFAULT_GUN_PORT],
  ["E2E_WEB_PORT", web, DEFAULT_WEB_PORT],
]) {
  process.env[name] = String(picked.port);
  if (picked.source === "auto") {
    console.log(`[e2e] ${fallback} is taken — using ${name}=${picked.port}`);
  } else {
    console.log(`[e2e] ${name}=${picked.port}`);
  }
}

const child = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
