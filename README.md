# pwa-local-first-template

A local-first progressive web app template for offline-capable, multi-device document apps in the browser. The demo product is a notes app; the architecture is reusable for other entity-based local-first products.

---

## Why this exists

Most “sync later” tutorials either hide persistence behind a cloud API or treat a peer library as the database. This template does the opposite:

1. The browser keeps the **source of truth** (SQLite in OPFS).
2. An **outbox** records local writes while offline.
3. A swappable **sync transport** moves signed mutations between devices.
4. A fixed **merge policy** reconciles concurrent edits.

Gun is used only as mesh transport for SEA-signed payloads. It is not the application database.

---

## What you get

| Area | What it does |
| --- | --- |
| UI | Solid.js + SolidUI/Tailwind notes, settings, AI |
| Local DB | TanStack DB + SQLite/OPFS behind `PersistenceFacade` |
| Offline | `@tanstack/offline-transactions` outbox |
| Sync | `GunSyncTransport` (or `NoopSyncTransport` when no peers) |
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

## How data flows

```text
UI (Solid)
  → PersistenceFacade
  → TanStack collection + OPFS SQLite   ← source of truth
  → outbox
  → SyncTransport.push / pull
  → Gun mesh (SEA-signed mutations)
  → other device
  → applyRemoteMutations → mergeNote (LWW / Loro)
  → local OPFS again
```

Important invariants:

- **Local OPFS wins as SoT.** Peers never become the canonical store.
- **Mutations are note snapshots** (`upsert` / `soft_delete`), not a full op-log protocol.
- **Import backup** uses the same merge path as remote sync, so re-importing is safe and does not blind-overwrite newer local fields.

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
  shared/sync/         SyncTransport, Gun adapter, protocol (Zod), merge, mutex
  shared/identity/     SEA pair persistence and QR/JSON export-import
  ai/                  WebLLM session, GPU/storage gates, provider adapter
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
| Wire protocol shape | `src/shared/sync/protocol.ts` |
| Replace Gun with another transport | implement `SyncTransport` in `src/shared/sync/` |
| Identity / pairing | `src/shared/identity/` |
| AI behaviour | `src/ai/` |
| Backup format | `src/backup/` |

---

## Core concepts

### Source of truth

SQLite in OPFS, opened through `@tanstack/browser-db-sqlite-persistence` and exposed to the UI only via `PersistenceFacade`. Live queries use `@tanstack/solid-db`.

### Outbox and sync cursor

Local writes enqueue offline transactions. Sync metadata (relay/peer cursor) lives in the `sync_meta` collection. Collections `notes` and `sync_meta` **must share the same `schemaVersion`** (TanStack browser-db requirement).

### Transport

`SyncTransport` has `push`, `pull`, and `resolve`:

- With `VITE_GUN_PEERS` (or the dev default) → `GunSyncTransport`
- Without peers → `NoopSyncTransport` (purely local)

Gun carries signed mutations under the user’s SEA graph. The optional `server/gun-peer` process helps mesh and tests; it does not own note domain logic.

### Identity

A SEA keypair is created and stored in the browser. Settings can export it as QR/JSON so another device can import the same identity and join the same sync graph. Treat that payload as a secret.

### Conflict policy

| Field | Strategy |
| --- | --- |
| `title` | Last-writer-wins per field (Lamport clock `title_lamport`) |
| `deleted_at` | Last-writer-wins per field (`deleted_lamport`) |
| `body` | Loro `LoroText` CRDT (`body_doc` snapshot is authoritative; `body` is a plain-text projection) |

Editing the title does not clobber a concurrent soft-delete, and concurrent body edits merge causally instead of picking a single winner.

### Optional AI

Gated by `VITE_AI_ENABLED`. The runtime checks WebGPU and storage headroom, then can download a WebLLM model (tiered max/std/dev) and run summarize, title suggestions, local hash embeddings / semantic search, grounded RAG, and a thin agent with skills — all on-device. Real model downloads are consent-gated; CI uses injected mocks.

### Backup and recovery

- Export: versioned JSON of notes (merge-safe re-import) and optional SQL dump for inspection.
- Import: each note goes through `applyRemoteMutations` / `mergeNote` under the sync mutex.
- On startup, integrity check runs **before** collection preload. Failure shows `RecoveryScreen` instead of a blank app.

See also: [architecture](docs/architecture.md), [ADRs](docs/adr/), [gun-peer Docker](server/gun-peer/README.md).

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
Unit (Vitest)     protocol, CRDT, merge, mutex, Gun transport (fakes),
                  apply-remote, facade stubs, AI gates/session, identity
E2E (Playwright)  CRUD, offline→online, multi-tab OPFS, Gun peers,
                  concurrent body merge, backup, AI panel (mocked engine)
```

Notes for e2e:

- Chromium only (OPFS).
- `chromium-sync` resets the Gun peer via `POST /test/reset` and injects a shared SEA pair (no camera).
- `/test/*`, `__createAiProvider`, and `__importIdentity` are gated to test/dev modes.
- Helpers live in `e2e/helpers.ts`.

---

## What already works

- Local-first note CRUD with OPFS SQLite as source of truth
- Offline writes through the outbox
- Hybrid merge (LWW + Loro) with unit and e2e coverage
- Swappable sync transport (Gun / noop) with protocol `v` gating
- SEA identity + space-key AES-GCM, QR/JSON + SAS pairing, BIP39 recovery
- SEA/space ciphertext on the Gun path (peer is untrusted for note bodies)
- Multi-tab OPFS coordination
- PWA installability / service worker caching for WASM assets
- Feature-flagged on-device AI (summarize, meta, RAG, agent, tiers)
- JSON backup round-trip through merge + SQL dump
- Tombstone GC, encrypted checkpoints, local conflict history
- Startup integrity check and recovery UI
- Automated unit + Chromium e2e suite
- Dockerised gun-peer for production-style mesh hosting

---

## What still needs deliberate design

- Multi-user tenancy / capabilities beyond a shared SEA + space key
- Device revocation and key rotation (Phase 5)
- Whether sync should move from snapshot mutations toward append-only ops
- Safari / non-Chromium hosts, or a native shell if OPFS remains limiting
- Maturity of `@tanstack/browser-db-sqlite-persistence` (facade allows swap)
- Longer-term schema evolution beyond current `schemaVersion` / backup schema
- Whether a stack like p2panda/iroh is required at all (native-only today — see ADRs)

---

## Comparison with p2panda

This template is a full application slice: UI, local storage, merge policy, sync adapter, identity wiring, and PWA shell for a notes demo. p2panda is a modular local-first P2P engine (signed operations, discovery, gossip/sync on iroh). You bring the UI, product schema, and usually a native host.

They are not drop-in replacements. Adopting p2panda replaces the networking and operation model; it does not replace the product application by itself.

### Layer table

| Layer | This template | p2panda |
| --- | --- | --- |
| UI | Solid notes / settings / AI | Bring your own |
| Local store | Entity snapshots in OPFS SQLite | Append-only signed operations (+ local SQLite for ops/meta) |
| Mutation unit | Note `upsert` / `soft_delete` in outbox | Signed `Operation` (key + signature + body) |
| Conflicts | Fixed: LWW + Loro | Bring your own CRDT (or raw bytes) |
| Network | Gun mesh transport + optional helper peer | iroh discovery / gossip / sync |
| Identity | SEA on the transport path | Ed25519 on every operation |
| AuthZ / group crypto | Not solved | Roadmap (UCAN-style capabilities, group encryption) |
| Host | Browser PWA (Chromium + OPFS) | Primarily native Rust; JS/FFI experimental |

### Overlap

Both cover **local persistence** and **getting changes to other devices**. This template also owns the product UI and PWA. p2panda goes deeper on trust-minimised networking and operation identity. The practical integration hinge here is `SyncTransport`: you can swap adapters without rewriting Solid/OPFS/Loro, but full p2panda usually changes host assumptions as well.

Use p2panda (or similar) only if the product requires trust-minimised P2P discovery and an op-log network. Otherwise harden Gun transport, identity, tenancy, and encryption on the current path.

---

## Known caveats

- `@tanstack/browser-db-sqlite-persistence` is young; keep changes behind `PersistenceFacade`.
- Gun is transport only; do not treat the peer graph as application SoT.
- The OPFS database file is not precached by the service worker. Loro WASM (~3 MB) and related workers use runtime `CacheFirst`.
- `notes` and `sync_meta` must use the **same** `schemaVersion`.
- QR/JSON identity export contains private key material — handle it like a password.
- Real WebLLM downloads are not run in CI; e2e uses injected mocks.
