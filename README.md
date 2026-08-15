# pwa-local-first-template

A research template for **local-first, multi-device apps that live entirely
in the browser** — no backend owns the data. The demo is deliberately a
hello-world: one shared counter with a label. Everything else in the tree is
the template.

## The vision, in short

Four commitments define local-first here (full statement:
[docs/vision.md](docs/vision.md)):

1. **The device holds the source of truth** — full state in SQLite/OPFS; no
   server has the data, so no server can lose or withhold it.
2. **Offline is not a degraded mode** — everything works with the network
   cut; sync catches up later.
3. **Writes are durable before they are shared** — every change is appended
   to a signed, hash-linked, per-device log before any network is involved.
   The log doubles as the outbox.
4. **Concurrent edits merge deterministically** — state is recomputed as a
   pure function of the op set: counter clicks **sum** (grow-only counter),
   the label resolves by **last-writer-wins** on a Lamport clock.

P2P in a browser is a constrained claim, and the constraint is stated
honestly: a tab cannot accept inbound connections, so devices exchange
**end-to-end-encrypted** ops through a dumb relay that cannot read or forge
anything (signatures + hash chains + AES-GCM sealed payloads). The relay is
a courier, not a party.

## Status & direction

**Now (v0.2 line):** the counter hello-world over the full sync fabric —
per-device op logs, log-height sync over a Gun relay, QR pairing with
per-device ed25519 keys, BIP39 recovery — verified by four Vitest layers
plus Playwright e2e, including the two definitive cases: *concurrent
increments on two devices sum* and *increments from two tabs of one device
sum*.

**Direction ([ADR-011](docs/adr/011-adopt-p2panda-direction.md)):** the
homegrown sync stack is a bridge, not a destination. The project steers
toward [p2panda](https://p2panda.org/) along the path its maintainers
describe for the web — a thin signing client in the browser plus a broker —
which is the architecture this template already implements. Work that a
p2panda crate would replace is frozen
([BACKLOG](docs/BACKLOG.md) labels); the two-sided gap list for the
upstream conversation is [docs/p2panda-gaps.md](docs/p2panda-gaps.md)
(ref [p2panda#1235](https://github.com/p2panda/p2panda/issues/1235),
[#1126](https://github.com/p2panda/p2panda/issues/1126)).

The staged road from an empty page to p2panda — and why each stage exists —
is [vision.md §7](docs/vision.md#7-the-road-from-zero-to-p2panda--and-why-each-step).

## Quick start

```bash
pnpm install
pnpm dev
```

| Process | URL | Role |
| --- | --- | --- |
| App | http://localhost:3000 | the counter + settings |
| Gun relay | http://127.0.0.1:8765/gun | dumb encrypted-payload courier |

Open the app, click the counter, then pair a second browser profile from
**Settings** (QR or JSON) and watch increments from both sides **add up**
instead of conflicting.

## What's in the box

| Area | What it does |
| --- | --- |
| Demo domain | One counter (grow-only) + label (LWW) — `src/features/counter`, 4 files to swap for your product ([vision.md §5](docs/vision.md#5-domain-split)) |
| Local DB | TanStack DB + SQLite/OPFS behind `PersistenceFacade` |
| Op log | Signed (ed25519), hash-linked (blake3), per-device append-only log; the `published` flag is the outbox |
| Sync | Log-height exchange: head announcements, range fetch, chain validation, per-op quarantine |
| Transport | `LogSyncTransport` seam — Gun relay today, p2panda broker intended |
| Identity | SEA pair (relay auth) + per-device signing key + AES-GCM space key; QR/JSON pairing; BIP39 recovery |
| PWA | Vite + Workbox service worker, installable |
| Docs | [vision](docs/vision.md) · [architecture](docs/architecture.md) · [ADRs](docs/adr/) · [BACKLOG](docs/BACKLOG.md) · [p2panda gaps](docs/p2panda-gaps.md) |

**Browser target:** Chromium (OPFS required). Safari / WebKit out of scope
for now.

## Repository map

```text
src/
  app/                 App shell and routing
  features/counter/    The demo domain UI (input + button)
  features/settings/   Pairing, device roster, recovery, appearance, storage
  shared/db/           Schemas, facade, client wiring, Lamport clock, DbProvider
  shared/oplog/        Signed op header (ed25519 + blake3), payload registry, chain rules
  shared/store/        OpLogStore, persistence port + both implementations, materializer
  shared/sync/         LogSyncTransport, Gun adapter, SyncEngine, wire protocol, conflict log
  shared/identity/     SEA pair, device signing key, space key, pairing, BIP39 recovery
  testing/harness/     Virtual devices + fake hub (test layers)
server/gun-peer/       The relay (Docker-ready; no application logic)
e2e/                   Playwright specs and helpers
```

### Where to change what

| Goal | Start here |
| --- | --- |
| Replace the demo domain with your product | the 4 files in [vision.md §5](docs/vision.md#5-domain-split) |
| Merge rules | `src/shared/store/materialize.ts` |
| Op header / signing scheme | `src/shared/oplog/header.ts` |
| Replace Gun with another transport | implement `LogSyncTransport` in `src/shared/sync/` |
| Identity / pairing / device keys | `src/shared/identity/` |

## Configuration

```bash
VITE_GUN_PEERS=http://127.0.0.1:8765/gun  # empty → offline-only (NoopLogTransport)
VITE_E2E=1                                # e2e-only hooks (never in production)
GUN_PEER_PORT / E2E_WEB_PORT              # e2e ports; auto-picked when taken
```

In dev, an empty `VITE_GUN_PEERS` falls back to `http://127.0.0.1:8765/gun`.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | relay + app |
| `pnpm build` / `pnpm preview` | production build + SW / preview |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / Biome |
| `pnpm test` | Vitest, all four layers |
| `pnpm test:unit` / `test:contract` / `test:integration` / `test:dom` | one layer |
| `pnpm test:e2e` | Playwright (picks free ports automatically) |
| `pnpm test:all` | every Vitest layer + e2e |

**Definition of done:** `pnpm lint && pnpm typecheck && pnpm test:all`
green. CI runs the same (`.github/workflows/ci.yml`) plus a weekly run
against dependency drift.

The test-layer table (what is real vs. stand-in per layer) is in
[architecture.md](docs/architecture.md#test-layers).

## Known caveats

- **The 6-digit pairing code is a transfer checksum, not authentication.**
  An attacker who can rewrite the pairing channel can forge a payload that
  shows the same digits (demonstrated in `pairing.test.ts`). Pair only over
  a channel an attacker cannot rewrite. Per
  [ADR-011](docs/adr/011-adopt-p2panda-direction.md) a homegrown fix is
  deliberately not planned — this closes with `p2panda-auth`.
- The shared space key has no revocation and no forward secrecy: anyone who
  ever held it can decrypt everything. Don't treat pairing as reversible.
- The pairing payload contains private key material (SEA pair, space key) —
  handle it like a password. Device signing keys never transfer.
- `@tanstack/browser-db-sqlite-persistence` is young and confirms writes
  asynchronously — the op-log store keeps its own read index with monotonic
  flag merges for exactly this reason (ADR-010, ADR-012).
- Gun is transport only; the peer graph is never the source of truth.
- Clean break from pre-0.2 builds: `schemaVersion` 4 does not read
  notes-era tables (ADR-012).
