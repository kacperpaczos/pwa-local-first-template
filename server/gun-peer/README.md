# Gun peer (production)

Self-hosted Gun relay with radisk persistence. The peer is **not** a source of
truth and does **not** replace client-side E2EE — it only relays opaque graph
data.

## Quick start

```bash
cd server/gun-peer
docker compose up --build -d
```

- Mesh endpoint: `http://localhost:8765/gun`
- Health: `http://localhost:8765/healthz` → `{ "ok": true }`
- Data volume: Docker volume `gun-data` → `/app/.gun-data`

Point the PWA at the peer (Vite / env) with something like:

```bash
VITE_GUN_PEERS=http://localhost:8765/gun
```

## Optional TLS (Caddy)

`compose.yaml` includes a commented `caddy` service. Uncomment it, add a
`Caddyfile` that reverse-proxies to `gun-peer:8765`, then:

```bash
docker compose up --build -d
```

Example Caddyfile:

```caddy
gun.example.com {
  reverse_proxy gun-peer:8765
}
```

## Local (without Docker)

From the repo root (uses the workspace `gun` + `tsx`):

```bash
pnpm dev:gun-peer
```

## Notes

- Container listens on `0.0.0.0:8765` (`GUN_PEER_HOST` / `GUN_PEER_PORT`).
- The e2e suite starts its own peer. `pnpm test:e2e` honours `GUN_PEER_PORT`
  and `E2E_WEB_PORT`, and picks a free port automatically when 8765 or 4173 is
  already taken — so a peer left running (or an unrelated service on 8765)
  does not block the suite.
- Runs as a non-root user.
- `/healthz` is always available (not gated by test mode).
- Gun publish of app checkpoints is best-effort under the SEA user graph
  (`user.get('checkpoints')`); durable checkpoint copies live in the client
  `localStorage` key `pwa-checkpoints` (max 2).
