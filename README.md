# pwa-local-first-template

A local-first progressive web app template for offline-capable, multi-device document apps in the browser. The demo product is a notes app; the architecture is reusable for other entity-based local-first products.

---

## Purpose

Most "sync later" tutorials either hide persistence behind a cloud API or treat a peer library as the database. This template does neither:

1. The browser keeps the **source of truth** (SQLite in OPFS).
2. Local writes append to a **per-device, hash-linked operation log** before the outbox publishes them.
3. A swappable **sync transport** moves signed, encrypted operations between devices — no backend server owns the data.
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
| Offline | `@tanstack/offline-transactions` outbox, backed by a durable per-device op log |
| Op log | Signed, hash-linked per-device append-only log (`shared/oplog/`, `shared/store/oplog-store.ts`) |
| Sync | `GunLogTransport` + `SyncEngine` (or `NoopLogTransport` when no peers) |
| Wire protocol | Entity-agnostic envelope wrapping a signed op header + ciphertext, per-entity payload schema registry (`protocol.ts`, `oplog/payload.ts`) |
| Identity | SEA keypair (Gun ACL) + per-device ed25519 signing key + AES-GCM space key; QR/JSON + SAS pairing; BIP39 recovery |
| Conflicts | LWW (title, soft-delete) + Loro CRDT (body) + local conflict history |
| PWA | Vite + Workbox service worker |
| AI | Optional on-device WebLLM, opt-in (summarize, meta, RAG, agent) |
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
  → OpLogStore.append (durable, per-device hash-linked log)
  → SyncEngine.flush → LogSyncTransport.publish
  → Gun mesh (SEA-authenticated graph, space-key encrypted op rows)
  → other device
  → SyncEngine: fetch → OpLogStore.ingest → materializeNoteOps → mergeNote (LWW / Loro)
  → local OPFS again
```

p2panda is a different kind of thing than this template — it's a modular **engine** (you bring the UI, product schema, and usually a native host), not an app slice. They're not drop-in replacements: adopting p2panda would replace the networking and operation model, not the product application. The table below breaks both down layer by layer, since "is this template like p2panda" only makes sense per-layer, not as a single yes/no.

**v0.1 note:** since [ADR-010](docs/adr/010-per-device-op-log.md), this template's own data model *is* a per-device append-only operation log — the biggest structural gap to p2panda from earlier versions is closed. What's left is mostly the transport (no p2panda browser binding yet) and real per-device authorization (p2panda-auth vs. this template's all-or-nothing shared space key).

| # | Layer | This template | p2panda equivalent | Relationship |
| --- | --- | --- | --- | --- |
| 1 | UI | Solid notes / settings / AI (`src/features/`) | Bring your own | No overlap — out of scope for p2panda by design |
| 2 | Local persistence | OPFS SQLite materialized from a **per-device append-only operation log**, behind `PersistenceFacade` + `OpLogStore` (`src/shared/db/`, `src/shared/store/`) | Append-only signed **operation log**, materialized into views | Same shape now: full-state payloads vs. p2panda's deltas is the remaining difference, and a deliberate v0.1 simplification (see ADR-010) |
| 3 | Outbox / offline writes | `@tanstack/offline-transactions` queues local writes; the log's `published` flag is itself the durable outbox | Not a distinct concept — operations are written straight to your own log | Converged: local writes append to the log first (durable), then publish — this template no longer treats "local commit" and "on the log" as different moments |
| 4 | Wire protocol | Versioned envelope wrapping a signed, hash-linked op header + ciphertext, entity-agnostic via a payload schema registry (`protocol.ts`, `oplog/header.ts`, `oplog/payload.ts`) | Signed `Operation` (key + signature + body), hash-linked into a log | Structurally aligned: both are a signed, hash-linked unit in an append-only per-author log. Encoding differs (sorted-key JSON vs. CBOR/Postcard) — a mechanical swap, not a redesign |
| 5 | Content encryption | AES-256-GCM "space key" shared by paired devices, BIP39-wrapped for recovery (`shared/crypto/envelope.ts`, `shared/identity/space.ts`, `recovery.ts`) | `p2panda-encryption` — decentralised group encryption with post-compromise security and optional forward secrecy, CRDT-based membership | p2panda's scheme is strictly more advanced (real revocation, forward secrecy); this template's single shared key has neither yet — see [caveats](#known-caveats) |
| 6 | Identity | Per-device ed25519 keypair signs every op directly (op attribution); a separate shared Gun SEA pair authenticates the transport graph; the space key is the content secret (`shared/identity/`) | Ed25519 keypair signs every operation directly — identity and content authenticity are the same mechanism | Op attribution now matches p2panda's model (ed25519 signs the op); transport auth is still a separate, shared secret — a real Gun replacement (layer 8) would let this collapse further |
| 7 | Conflict resolution | Fixed policy: LWW (Lamport clocks) for scalar fields, Loro CRDT for body text, applied while materializing the log (`materialize.ts`, `merge-note.ts`, `crdt.ts`) | Bring your own CRDT — the log format is CRDT-compatible but doesn't mandate one | Same "pluggable, not prescriptive" philosophy, applied at different granularity (whole-entity here vs. raw op-log there) |
| 8 | Sync transport | `LogSyncTransport` interface — `GunLogTransport` today, `NoopLogTransport` when offline-only (`shared/sync/transport.ts`, `gun-log-transport.ts`) | `p2panda-net` (iroh-based discovery/gossip/direct connections) | `p2panda-sync` is explicitly described upstream as "transport-agnostic... compatible with p2panda-net **or other peer-to-peer networking solutions**" — same swap-point philosophy as this template's `LogSyncTransport`, just not usable from a browser yet (see [Purpose](#purpose)) |
| 9 | Host | Browser PWA, Chromium + OPFS only (Vite + Workbox) | Primarily native Rust; browser bindings experimental/nonexistent for the current architecture | This is the actual reason the two projects don't currently compete — p2panda isn't aiming at the browser yet |

**The practical integration hinge is layer 8.** `LogSyncTransport` is the one seam explicitly designed to be swapped without touching layers 1–3 or 6–7 — `p2panda-net`'s own browser story is iroh's "Browsers Alpha" (relay-only) as of this writing, so the seam exists but isn't switched on. Layer 5 (encryption) is the other realistic near-term swap point — `p2panda-encryption`'s scheme is a strict upgrade over the current single-shared-key model, if/when it ships a browser binding, and requires reimplementing `seal()`/`open()` in `shared/crypto/envelope.ts` plus wiring real group membership (which has no home in `shared/identity/space.ts` today — see [ADR-010](docs/adr/010-per-device-op-log.md)).

Full non-comparative diagram, swap-point reference, and the module-by-module v0.2 mapping: [`docs/architecture.md`](docs/architecture.md) and [ADR-010](docs/adr/010-per-device-op-log.md). Decision history: [`docs/adr/`](docs/adr/).

---

## Repository map

```text
src/
  app/                 App shell and routing
  features/notes/      Notes UI and local store wiring
  features/ai/         AI panel (shown only when AI is available)
  features/settings/   Backup, SEA/QR pairing, device roster, persist status, recovery
  features/home/       Landing copy
  shared/db/           Schemas, facade, IDs, Lamport clocks, Loro helpers, DbProvider, client (op-log wiring)
  shared/oplog/        Signed op header (ed25519 + blake3), per-entity payload schemas, chain rules
  shared/store/        OpLogStore (per-device log), persistence port, materializer (log → notes)
  shared/sync/         LogSyncTransport, Gun adapter, SyncEngine, protocol, merge, GC coverage
  shared/identity/      SEA pair, per-device signing key, space key, QR/JSON + SAS pairing, BIP39 recovery
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
| Conflict rules | `src/shared/sync/merge-note.ts`, `src/shared/db/crdt.ts`, `src/shared/store/materialize.ts` |
| Op header / signing scheme | `src/shared/oplog/header.ts` |
| Wire protocol shape / add a second entity | `src/shared/sync/protocol.ts`, `src/shared/oplog/payload.ts` |
| Replace Gun with another transport | implement `LogSyncTransport` in `src/shared/sync/` |
| Identity / pairing / device keys | `src/shared/identity/` |
| AI behaviour | `src/ai/` |
| Backup format | `src/backup/` |

---

## Configuration

```bash
# .env / CI examples
VITE_GUN_PEERS=http://127.0.0.1:8765/gun
VITE_AI_ENABLED=true   # opt-in: any other value (or unset) ships AI off
VITE_AI_MODEL_ID=...   # optional; defaults to a hardware-detected Qwen3/Llama tier
VITE_E2E=1             # e2e-only hooks (do not use in production)
```

In `import.meta.env.DEV`, if `VITE_GUN_PEERS` is empty, the app defaults to `http://127.0.0.1:8765/gun`. `VITE_AI_ENABLED` is opt-in — a production build ships with AI off unless it is explicitly set to `"true"` at build time.

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
| `pnpm lint` / `pnpm lint:fix` | Biome (lint + format) |
| `pnpm test` / `pnpm test:unit` | Vitest (`unit` + `dom` projects) |
| `pnpm test:e2e` | Playwright (Chromium smoke + sync) |
| `pnpm test:e2e:sync` | Sync project only (serial + peer reset) |
| `pnpm test:all` | Unit + e2e |

**Definition of done:** `pnpm lint && pnpm typecheck && pnpm test:all` must be green. CI runs the same on `push` / `pull_request` to `main`, plus a weekly scheduled run against dependency drift (`.github/workflows/ci.yml`).

### Test pyramid

```text
Unit (Vitest, 2 projects)
  unit (node)   op header/chain/store, materializer, protocol, merge,
                Gun transport (fake graph, real SEA + AES-GCM crypto),
                facade / gc (mocked @tanstack/db), AI gates/session,
                identity/crypto (all real)
  dom (jsdom)   component tests (Solid Testing Library) — install
                prompt, error boundary, pairing error path
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
- Offline writes through the outbox, backed by a durable per-device operation log (the log's `published` flag *is* the outbox)
- Hybrid merge (LWW + Loro) applied while materializing the log, with unit and e2e coverage
- Swappable sync transport (`LogSyncTransport`: Gun / noop) with protocol `v` gating that does not latch on a single incompatible row
- Signed, hash-linked op log generalized beyond a single entity via a per-entity payload schema registry — a second entity/app can share the same log/materialize/transport machinery without touching `protocol.ts` again
- SEA transport auth + per-device ed25519 op signing + space-key AES-GCM, QR/JSON + SAS pairing (payload v3), BIP39 recovery
- Space ciphertext on the Gun path, fail-closed with no weaker fallback cipher (peer is untrusted for note bodies)
- Real GC coverage gate: tombstones hard-delete only once every known peer has acked the deleting op, not just past a local Lamport threshold
- Multi-tab OPFS coordination
- PWA installability / service worker caching for WASM assets, with an update-available toast (no silent auto-reload)
- Feature-flagged (opt-in) on-device AI (summarize, meta, RAG, agent, tiers)
- JSON backup round-trip through the same log-append + merge path as any remote op, plus SQL dump
- Tombstone GC, local conflict history, device roster (Settings)
- Startup integrity check and recovery UI
- Automated unit + component (Solid Testing Library) + Chromium e2e suite, with mock boundaries documented in-file; Biome lint/format in CI
- Dockerised gun-peer for production-style mesh hosting

---

## What still needs deliberate design

- Multi-user tenancy / capabilities beyond a shared SEA + space key — every device holding the space key has full read/write, with no notion of roles
- Device revocation and key rotation — the device roster (Settings) shows who has synced, but there's no way to revoke one
- Real forward secrecy / post-compromise security for content encryption — `p2panda-encryption` solves this today, this template's single shared key does not (see layer 5 above)
- Op log compaction / pruning — full-state payloads mean log size grows with edit count; no compaction ships in v0.1 (see [ADR-010](docs/adr/010-per-device-op-log.md))
- p2panda/iroh as a future transport: no official browser/WASM binding exists yet for the current (post-rewrite) p2panda architecture — revisit when either ships a stable one, not on a fixed timeline (see [Purpose](#purpose), ADR-005, ADR-010's v0.2 mapping table)
- Safari / non-Chromium hosts, or a native shell if OPFS remains limiting
- Maturity of `@tanstack/browser-db-sqlite-persistence` (facade allows swap)
- Longer-term schema evolution beyond current `schemaVersion` / backup schema

---

## Known caveats

- `@tanstack/browser-db-sqlite-persistence` is young; keep changes behind `PersistenceFacade`. It also confirms writes through an async round trip — code that reads a collection immediately after a `tx.commit()` resolves can observe a just-written row as momentarily absent (see `OpLogStore`'s in-memory read index in [ADR-010](docs/adr/010-per-device-op-log.md) for the pattern this template uses to avoid depending on that timing).
- Gun is transport only; do not treat the peer graph as application SoT.
- The OPFS database file is not precached by the service worker. Loro WASM (~3 MB) and related workers use runtime `CacheFirst`.
- All persisted collections (`notes`, `oplog_ops`, `oplog_heads`) must use the **same** `schemaVersion`.
- QR/JSON pairing payload contains private key material (SEA pair, space key) — handle it like a password. Device signing keys are the one thing pairing never transfers.
- **The 6-digit pairing SAS is a transfer checksum, not authentication.** It catches a mistyped, truncated, or wrong-device code. It does *not* stop an attacker who can rewrite the pairing channel: the digits are only 10^6 wide over inputs the payload's author chooses, so a forged payload can be ground offline in well under a second to display the same digits the genuine device shows (demonstrated in `pairing.test.ts`). Pair only over a channel an attacker cannot rewrite. A real SAS needs an interactive commitment exchange, which the one-way QR/JSON flow has no room for — tracked for v0.2 alongside `p2panda-auth`.
- The shared space key has no revocation or forward secrecy: anyone who ever had it can decrypt history. Don't treat pairing as reversible.
- **Breaking change from pre-v0.1 builds:** protocol v3 (ADR-010) does not read old `app_sync` graph data. A device upgrading from a pre-v0.1 build republishes its local notes as a fresh op-log genesis on first boot; this converges across devices via the normal merge path but is not a byte-for-byte migration of prior sync history.
- Real WebLLM downloads are not run in CI; e2e uses injected mocks.
