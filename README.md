# pwa-local-first-template

A local-first progressive web app template for offline-capable, multi-device document apps in the browser. The demo product is a notes app; the architecture is reusable for other entity-based local-first products.

---

## Purpose

Most "sync later" tutorials either hide persistence behind a cloud API or treat a peer library as the database. This template does neither:

1. The browser keeps the **source of truth** (SQLite in OPFS).
2. An **outbox** records local writes while offline.
3. A swappable **sync transport** moves signed, encrypted mutations between devices — no backend server owns the data.
4. A fixed **merge policy** reconciles concurrent edits.

Gun is used only as mesh transport for signed, encrypted payloads. It is not the application database, and it is not meant to be permanent — see [Architecture by layer](#architecture-by-layer-compared-to-p2panda) below for why.

**This is a template, not a framework.** It proves out one working architecture for a browser-based, server-optional local-first app. It stays a template — code you fork and adapt — until a second real application (different entities, same sync fabric) validates which parts are actually reusable as-is. Extracting shared packages before that point would be guessing at genericity instead of testing it.

### Why a template, and why not just adopt an existing P2P engine

Serious P2P engines exist — [p2panda](https://p2panda.org/), [iroh](https://www.iroh.computer/), [libp2p](https://libp2p.io/), [Holepunch/Pear](https://docs.pears.com/) — but as of this writing none of them ship an official, stable **browser** binding for their current architecture:

- `p2panda-js` (npm, WASM) is deprecated and wraps a pre-rewrite version of p2panda. The current modular stack (`p2panda-core`, `p2panda-net`, `p2panda-sync`, `p2panda-encryption`) only ships Node/Python/Go (`p2panda-ffi`, UniFFI) and GLib (`p2panda-gobject`) bindings — both native, not browser.
- iroh compiles to WASM but its own docs describe browser connectivity as "Browsers Alpha" — relay-only, no direct connections or hole-punching in-browser.
- js-libp2p has stabilized WebRTC-Direct (browser↔server) but browser↔browser WebRTC is still tracked as in-progress.
- Holepunch/Pear's Hypercore stack is production-proven, but targets the Pear/Bare runtime, not a standard browser tab.

So the gap this template fills is specifically: **browser-only, no backend server, real P2P mesh, real local persistence.** Gun and Trystero are the realistic transports for that today; the native engines above are the likely future once one of them ships a real browser story. The [transport boundary](#8-sync-transport) is designed so that swap is contained, not a rewrite.

---

## What you get

| Area | What it does |
| --- | --- |
| UI | Solid.js + SolidUI/Tailwind notes, settings, AI |
| Local DB | TanStack DB + SQLite/OPFS behind `PersistenceFacade` |
| Offline | `@tanstack/offline-transactions` outbox |
| Sync | `GunSyncTransport` (or `NoopSyncTransport` when no peers) |
| Wire protocol | Entity-agnostic envelope + per-entity schema registry (`protocol.ts`, `entity-registry.ts`) |
| Identity | SEA keypair + AES-GCM space key; QR/JSON + SAS pairing; BIP39 recovery |
| Conflicts | LWW (title, soft-delete) + Loro CRDT (body) + local conflict history |
| PWA | Vite + Workbox service worker |
| AI | Optional on-device WebLLM (summarize, meta, RAG, agent) |
| Backup | JSON merge-import + SQL dump; integrity check + recovery |
| Docs | [`docs/architecture.md`](docs/architecture.md) + [`docs/adr/`](docs/adr/) |

**Browser target:** Chromium (OPFS required). Safari / WebKit are out of scope for now.

---

## Quick start

```bash
pnpm install
pnpm dev
```

That starts two processes:

| Process | URL | Role |
| --- | --- | --- |
| App | http://localhost:3000 | UI (`/notes`, `/settings`, …) |
| Gun peer | http://127.0.0.1:8765/gun | Mesh / signaling helper (no note business logic) |

Open the app, create notes, then pair a second browser profile from **Settings** (QR or JSON) to exercise sync.

---

## Architecture by layer (compared to p2panda)

```text
UI (Solid)
  → PersistenceFacade
  → TanStack collection + OPFS SQLite   ← source of truth
  → outbox
  → SyncTransport.push / pull
  → Gun mesh (SEA + space-key encrypted mutations)
  → other device
  → applyRemoteMutations → mergeNote (LWW / Loro)
  → local OPFS again
```

p2panda is a different kind of thing than this template — it's a modular **engine** (you bring the UI, product schema, and usually a native host), not an app slice. They're not drop-in replacements: adopting p2panda would replace the networking and operation model, not the product application. The table below breaks both down layer by layer, since "is this template like p2panda" only makes sense per-layer, not as a single yes/no.

| # | Layer | This template | p2panda equivalent | Relationship |
| --- | --- | --- | --- | --- |
| 1 | UI | Solid notes / settings / AI (`src/features/`) | Bring your own | No overlap — out of scope for p2panda by design |
| 2 | Local persistence | OPFS SQLite, entity **snapshots**, behind `PersistenceFacade` (`src/shared/db/`) | Append-only signed **operation log**, materialized into views | Different data model, not just different tech: this template has a per-device SoT it owns; p2panda's log is closer to the SoT itself |
| 3 | Outbox / offline writes | `@tanstack/offline-transactions` queues local mutations while offline | Not a distinct concept — operations are written straight to your own log | No direct analog; a consequence of #2's snapshot model |
| 4 | Wire protocol | Versioned envelope (`v`/`idempotencyKey`/`entity`/`op`/`payload`), entity-agnostic via a schema registry (`protocol.ts`, `entity-registry.ts`) | Signed `Operation` (key + signature + body), hash-linked into a log | Conceptually parallel (both are a typed, versioned unit of change) but structurally different — snapshot-with-op vs. hash-chained log entry |
| 5 | Content encryption | AES-256-GCM "space key" shared by paired devices, BIP39-wrapped for recovery (`shared/crypto/envelope.ts`, `shared/identity/space.ts`, `recovery.ts`) | `p2panda-encryption` — decentralised group encryption with post-compromise security and optional forward secrecy, CRDT-based membership | p2panda's scheme is strictly more advanced (real revocation, forward secrecy); this template's single shared key has neither yet — see [caveats](#known-caveats) |
| 6 | Identity | Split: Gun SEA pair authenticates the transport; the space key is the actual content secret (`shared/identity/`) | Ed25519 keypair signs every operation directly — identity and content authenticity are the same mechanism | This template bifurcates transport auth from content secrecy; p2panda unifies them at the operation level |
| 7 | Conflict resolution | Fixed policy: LWW (Lamport clocks) for scalar fields, Loro CRDT for body text (`merge-note.ts`, `crdt.ts`) | Bring your own CRDT — the log format is CRDT-compatible but doesn't mandate one | Same "pluggable, not prescriptive" philosophy, applied at different granularity (whole-entity here vs. raw op-log there) |
| 8 | Sync transport | `SyncTransport` interface — `GunSyncTransport` today, `NoopSyncTransport` when offline-only (`shared/sync/transport.ts`, `gun-transport.ts`) | `p2panda-net` (iroh-based discovery/gossip/direct connections) | `p2panda-sync` is explicitly described upstream as "transport-agnostic... compatible with p2panda-net **or other peer-to-peer networking solutions**" — same swap-point philosophy as this template's `SyncTransport`, just not usable from a browser yet (see [Purpose](#purpose)) |
| 9 | Host | Browser PWA, Chromium + OPFS only (Vite + Workbox) | Primarily native Rust; browser bindings experimental/nonexistent for the current architecture | This is the actual reason the two projects don't currently compete — p2panda isn't aiming at the browser yet |

**The practical integration hinge is layer 8.** `SyncTransport` is the one seam explicitly designed to be swapped without touching layers 1–3 or 6–7. Layer 5 (encryption) is the other realistic near-term swap point — `p2panda-encryption`'s scheme is a strict upgrade over the current single-shared-key model, if/when it ships a browser binding, and only requires reimplementing `seal()`/`open()` in `shared/crypto/envelope.ts`.

Full non-comparative diagram and swap-point reference: [`docs/architecture.md`](docs/architecture.md). Decision history: [`docs/adr/`](docs/adr/).

---

## Repository map

```text
src/
  app/                 App shell and routing
  features/notes/      Notes UI and local store wiring
  features/ai/         AI panel (shown only when AI is available)
  features/settings/   Backup, SEA/QR pairing, persist status, recovery
  features/home/       Landing copy
  shared/db/           Schemas, facade, IDs, Lamport clocks, Loro helpers, DbProvider
  shared/sync/         SyncTransport, Gun adapter, protocol + entity registry, merge, mutex
  shared/identity/     SEA pair, space key, QR/JSON + SAS pairing, BIP39 recovery
  ai/                  WebLLM session, GPU/storage gates, provider adapter, agent, embeddings
  backup/              JSON export/import, storage.persist(), integrity check
server/gun-peer/       Lightweight Gun peer for local mesh / e2e reset
e2e/                   Playwright helpers and specs
```

### Where to change what

| Goal | Start here |
| --- | --- |
| Note fields / validation | `src/shared/db/schemas.ts` |
| Create / update / delete API for UI | `src/shared/db/facade.ts` |
| Conflict rules | `src/shared/sync/merge-note.ts`, `src/shared/db/crdt.ts` |
| Wire protocol shape / add a second entity | `src/shared/sync/protocol.ts`, `src/shared/sync/entity-registry.ts` |
| Replace Gun with another transport | implement `SyncTransport` in `src/shared/sync/` |
| Identity / pairing | `src/shared/identity/` |
| AI behaviour | `src/ai/` |
| Backup format | `src/backup/` |

---

## Configuration

```bash
# .env / CI examples
VITE_GUN_PEERS=http://127.0.0.1:8765/gun
VITE_AI_ENABLED=true
VITE_AI_MODEL_ID=...   # optional; defaults to a small SmolLM2 WebLLM build
VITE_E2E=1             # e2e-only hooks (do not use in production)
```

In `import.meta.env.DEV`, if `VITE_GUN_PEERS` is empty, the app defaults to `http://127.0.0.1:8765/gun`.

---

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Gun peer + Vite app |
| `pnpm dev:app` | App only |
| `pnpm dev:gun-peer` | Gun peer only |
| `pnpm build` | Production build + service worker |
| `pnpm preview` | Preview production build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `pnpm test:unit` | Vitest |
| `pnpm test:e2e` | Playwright (Chromium smoke + sync) |
| `pnpm test:e2e:sync` | Sync project only (serial + peer reset) |
| `pnpm test:all` | Unit + e2e |

**Definition of done:** `pnpm typecheck && pnpm test:all` must be green. CI runs the same on `push` / `pull_request` to `main` (`.github/workflows/ci.yml`).

### Test pyramid

```text
Unit (Vitest)     protocol + entity registry, CRDT, merge, mutex,
                  Gun transport (fake graph, real SEA crypto),
                  apply-remote / facade / gc (mocked @tanstack/db),
                  AI gates/session, identity/crypto (all real)
E2E (Playwright)  CRUD, offline→online, multi-tab OPFS, Gun peers
                  (real network + real OPFS), concurrent body merge,
                  backup, AI panel (mocked model, real orchestration)
```

Notes for e2e:

- Chromium only (OPFS).
- `chromium-sync` resets the Gun peer via `POST /test/reset` and seeds a shared SEA pair + space key directly into `localStorage` via Playwright's `addInitScript` (no camera) — done pre-boot so both are present before the app's first read.
- `/test/*` and `__createAiProvider` are gated to test/dev modes. `__importIdentity`/`__exportIdentity` (`src/shared/identity/e2e.ts`) exist as DEV-console tooling for manual identity export/import but aren't currently called by the automated e2e suite.
- Helpers live in `e2e/helpers.ts`.

---

## What already works

- Local-first note CRUD with OPFS SQLite as source of truth
- Offline writes through the outbox
- Hybrid merge (LWW + Loro) with unit and e2e coverage
- Swappable sync transport (Gun / noop) with protocol `v` gating
- Wire protocol generalized beyond a single entity via a schema registry — a second entity/app can share the same envelope and encrypted-space transport without touching `protocol.ts` again
- SEA identity + space-key AES-GCM, QR/JSON + SAS pairing, BIP39 recovery
- SEA/space ciphertext on the Gun path (peer is untrusted for note bodies)
- Multi-tab OPFS coordination
- PWA installability / service worker caching for WASM assets
- Feature-flagged on-device AI (summarize, meta, RAG, agent, tiers)
- JSON backup round-trip through merge + SQL dump
- Tombstone GC, encrypted checkpoints, local conflict history
- Startup integrity check and recovery UI
- Automated unit + Chromium e2e suite, with mock boundaries documented in-file
- Dockerised gun-peer for production-style mesh hosting

---

## What still needs deliberate design

- Multi-user tenancy / capabilities beyond a shared SEA + space key
- Device revocation and key rotation (Phase 5)
- Real forward secrecy / post-compromise security for content encryption — `p2panda-encryption` solves this today, this template's single shared key does not (see layer 5 above)
- Whether sync should move from snapshot mutations toward an append-only op-log — no forcing function today: OPFS is already a per-device source of truth, so the main benefit of an op-log (efficient partial sync without a SoT) doesn't clearly apply here
- p2panda/iroh as a future transport: no official browser/WASM binding exists yet for the current (post-rewrite) p2panda architecture — revisit when either ships a stable one, not on a fixed timeline (see [Purpose](#purpose), ADR-005)
- Safari / non-Chromium hosts, or a native shell if OPFS remains limiting
- Maturity of `@tanstack/browser-db-sqlite-persistence` (facade allows swap)
- Longer-term schema evolution beyond current `schemaVersion` / backup schema

---

## Known caveats

- `@tanstack/browser-db-sqlite-persistence` is young; keep changes behind `PersistenceFacade`.
- Gun is transport only; do not treat the peer graph as application SoT.
- The OPFS database file is not precached by the service worker. Loro WASM (~3 MB) and related workers use runtime `CacheFirst`.
- `notes` and `sync_meta` must use the **same** `schemaVersion`.
- QR/JSON identity export contains private key material — handle it like a password.
- The shared space key has no revocation or forward secrecy: anyone who ever had it can decrypt history. Don't treat pairing as reversible.
- Real WebLLM downloads are not run in CI; e2e uses injected mocks.
