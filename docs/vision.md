# Vision: local-first + P2P in a browser tab

The base document for this repository. What we mean by local-first and P2P,
what the architecture is, who is responsible for what, what we depend on and
why, and the road from an empty page to p2panda. Decision history lives in
[`adr/`](adr/); this document states the current position.

---

## 1. What we are committing to

**Local-first** here is four testable commitments, not a mood:

1. **The user's device holds the source of truth.** Full state lives in
   SQLite inside the browser (OPFS). No server can withhold, edit, or lose
   the user's data, because no server has it.
2. **Offline is not a degraded mode.** Every feature works with the network
   cable cut; sync is a background concern that catches up later.
3. **Writes are durable before they are shared.** A click is recorded in a
   local, append-only log before any network is involved. A crash or
   an offline week loses nothing.
4. **Concurrent edits merge deterministically.** Two devices editing at
   once converge to the same state without a coordinator and without asking
   the user to pick a winner (they can inspect what merged in the conflict
   history).

**P2P** in a browser is a constrained claim and we state the constraint
up front: a browser tab cannot accept inbound connections, so true
device-to-device transport is not available to a web app today. The honest
browser shape — the same one the p2panda maintainers describe for the web —
is a **thin client + dumb relay**: devices sign and store everything
locally and exchange **end-to-end-encrypted** payloads through a relay that
cannot read, forge, or selectively alter them (every op is signed and
hash-chained; content is AES-GCM sealed under a key only paired devices
hold). The relay is a courier, not a party. No account, no server-side
state worth stealing, any relay instance is replaceable.

**Research focus.** The repo is a template and a test-bed, not a product.
The demo domain is deliberately a hello-world — one counter, one label
(see [§5](#5-domain-split)) — so that everything else in the tree IS the
template.

## 2. Architecture — the layer cross-section

What happens between a click and another device, top to bottom. Every layer
is a module with a seam; the table in §3 says who owns what.

```text
  click "+1"
    │
 1  UI (Solid)                    reads one live-queried state row
    │  facade.increment()
 2  PersistenceFacade             the ONLY write API the UI sees
    │  append {kind:"increment"}
 3  OpLogStore                    signs the op (device ed25519), chains it
    │                             (blake3 backlink, seq n+1), writes it
    │                             durably — under a cross-tab Web Lock
 4  Materializer                  recomputes the state row FROM the log:
    │                             value = Σ increments, label = LWW max
    │                             (pure function of the op set)
 5  SyncEngine                    background: publishes unpublished ops,
    │                             observes remote log heads, fetches gaps
 6  LogSyncTransport              the wire seam. Today: GunLogTransport
    │                             (AES-GCM sealed payloads on a Gun graph)
 7  Relay (server/gun-peer)       dumb, zero-knowledge, replaceable
    │
    ▼  ...the same stack, mirrored, on every other paired device:
       fetch → verify signature + chain → ingest → materialize → UI
```

Key structural facts:

- **The log is the outbox.** Each op carries a `published` flag; a crash
  between append and publish leaves the op queued, and the next cycle ships
  it. There is no second queue.
- **State is derived, never written.** The state row is a pure function of
  the op set. That makes materialization idempotent and order-free, which is
  what lets any interleaving of devices, tabs, and retries converge
  ([ADR-012](adr/012-counter-hello-world.md) records why this is load-bearing).
- **One log per (entity, device).** Sync is per-device log-height exchange:
  announce heads, fetch missing ranges, validate the hash chain, quarantine
  what cannot be decoded — one poison op never wedges the pipeline
  ([ADR-010](adr/010-per-device-op-log.md)).

## 3. Responsibilities

| Module | Owns | Must never |
| --- | --- | --- |
| `features/counter` (UI) | rendering, input handling | touch storage or sync directly |
| `shared/db/facade.ts` | the write API (`increment`, `setLabel`), Lamport stamping | expose log/sync internals to the UI |
| `shared/db/client.ts` | wiring: collections, store, engine, entity name | contain domain rules |
| `shared/oplog/` | op header format, signing, hash-chain rules, payload schema registry | know about transports or UI |
| `shared/store/oplog-store.ts` | durable append/ingest, seq derivation under locks, read index | interpret payloads |
| `shared/store/materialize.ts` | folding ops into state (the merge policy lives here) | talk to the network |
| `shared/sync/engine.ts` | cycle orchestration: flush, pull, acks, status | parse or trust payload content |
| `shared/sync/gun-log-transport.ts` | moving sealed bytes; wire layout on Gun | see plaintext (it seals/opens at the boundary, keyed by identity) |
| `shared/identity/` | SEA pair (relay auth), device ed25519 key, space key, pairing, BIP39 recovery | leave the module (device secret key never transfers) |
| `server/gun-peer` | relaying encrypted rows | any application logic |

The **trust boundary**: everything below the transport seam is untrusted.
Signatures + hash chains make the log tamper-evident; the space key makes
content unreadable; chain validation (`ok / gap / duplicate / fork`) makes
reordering and replay detectable.

## 4. Protocol

Three layers, separable on purpose:

**Operation** (`shared/oplog/header.ts`) — the unit of change:

```ts
header = { v: 3, publicKey, entity, seq, backlink, timestamp, payloadHash, payloadSize }
op     = { hash: blake3(header), header, signature: ed25519(header) }
```

`seq` is 1-based height in this device's log for this entity; `backlink` is
the previous op's hash (null at seq 1); `timestamp` is advisory only — merge
decisions never read wall clocks.

**Payload** (`shared/oplog/payload.ts`) — per-entity, schema-validated,
carried as sealed bytes. The demo entity registers two kinds:
`{kind:"increment", amount}` and `{kind:"set_label", label, lamport}`.
Payloads are deltas; the materializer gives them meaning.

**Wire** (`shared/sync/protocol.ts`, `gun-log-transport.ts`) — flat rows on
the relay, ciphertext only:

```text
app_oplog/<entity>/logs/<device>/<seq> → signed header fields + AES-GCM ciphertext
app_oplog/<entity>/heads/<device>      → { seq, hash }     (monotone announce)
app_oplog/<entity>/acks/<device>       → { json }          (seen-up-to per peer)
```

Sync cycle: publish own unpublished ops (rows before head, so an announced
head never points above a hole) → for each remote head above our local
height, range-fetch → verify + chain-validate → ingest → materialize →
publish acks. Every op carries `v`; an unsupported version degrades status
to `outdated` for that cycle without latching.

## 5. Domain split

The line between **template** (keep, reuse) and **demo domain** (replace
with your product) is exactly four files:

| Demo domain (replace) | With your own |
| --- | --- |
| `shared/db/schemas.ts` | your entity row schema |
| `shared/oplog/payload.ts` (the registered schema) | your op kinds |
| `shared/store/materialize.ts` | your merge policy (how ops fold into state) |
| `features/counter/` | your UI |

Everything else — log, store, engine, transport, identity, settings — is
domain-blind. The counter was chosen because it is the smallest domain that
still proves the machinery: a grow-only counter (concurrent writes **sum**)
and an LWW register (concurrent writes **pick one winner, deterministically**)
are the two primitive merge strategies; a real product composes them (and
richer CRDTs — collaborative text would return here as a Loro/Yjs document
payload with delta ops, which is exactly what the notes-era version did).

## 6. Dependencies — what, why, and its fate

Runtime dependencies are liabilities; each one is listed with the reason it
earns its place and what happens to it on the p2panda road (§7):

| Dependency | Why it is here | Fate |
| --- | --- | --- |
| `solid-js` (+ router, Kobalte/SolidUI, Tailwind) | UI. Thin, replaceable, no sync coupling | stays (yours to swap) |
| `@tanstack/db` + `browser-db-sqlite-persistence` | typed collections over SQLite/OPFS, cross-tab coordination | stays; behind `OpLogPersistence` + facade seams |
| `gun` (+ SEA) | the relay transport that works in a browser today; SEA authenticates graph writes | **replaced** by a p2panda broker client at the `LogSyncTransport` seam |
| `@noble/curves`, `@noble/hashes` | ed25519 signatures, blake3 hashes — the op format | **replaced** by `p2panda-core` (same primitives) |
| `@scure/bip39` | recovery phrase for the space key | replaced alongside `p2panda-encryption` |
| `zod` | payload/schema validation at trust boundaries | stays |
| `nanostores` | tiny UI-visible state (sync status) | stays |
| `qrcode` | pairing payload display | stays until `p2panda-auth` pairing |

Dev-side, the four-layer Vitest suite + Playwright are described in
[architecture.md](architecture.md#test-layers).

## 7. The road from zero to p2panda — and why each step

The template's history is a staged argument; each stage exists because the
previous one fails a specific test. This is also the order in which you
would rebuild it — or evaluate any other local-first stack.

- **Stage 0 — local state.** A collection over SQLite/OPFS. *Why:*
  commitment 1 and 2 (source of truth on device, offline whole). Fails at:
  a second device.
- **Stage 1 — an append-only op log under every write.** *Why:* syncing
  snapshots loses concurrent edits and cannot say "what changed since X";
  a log gives durable writes (commitment 3), history, and a sync unit.
  Fails at: trusting the network.
- **Stage 2 — sign and hash-chain each device's log.** *Why:* the transport
  will be someone else's computer. Signatures make authorship real
  (a peer cannot spoof another device's changes); backlinks make gaps,
  forks and tampering detectable. Fails at: privacy.
- **Stage 3 — seal payloads, dumb relay.** *Why:* a browser cannot do
  device-to-device, so a relay is unavoidable — then it must be blind.
  AES-GCM under a paired-devices key, AAD-bound to the signed header:
  the relay moves envelopes it cannot open. Fails at: efficiency.
- **Stage 4 — log-height sync.** *Why:* replaying everything on every boot
  grows with history. Head announcements + range fetch + acks make cost
  proportional to what actually changed. Fails at: meaning.
- **Stage 5 — deterministic materialization.** *Why:* ops need a merge
  policy to become state. Make state a pure function of the op set (sum,
  LWW max) and convergence stops being a protocol property and becomes
  arithmetic (commitment 4). Fails at: humans having several devices.
- **Stage 6 — identity and pairing.** *Why:* "my devices" must mean
  something: per-device signing keys (never transferred), a shared space
  key moved by QR/JSON pairing, BIP39 recovery. Known, documented holes:
  the pairing checksum authenticates nothing, no revocation, no forward
  secrecy ([BACKLOG](BACKLOG.md) §1–§3).
- **Stage 7 — hand the fabric to p2panda.** *Why:* stages 1–6 are
  ~2k lines of homegrown sync code whose every audit finding lived below
  the facade — and p2panda ships the same shapes as maintained crates,
  including the auth/encryption layers that close the Stage-6 holes
  properly (`p2panda-auth`, `p2panda-encryption`). Our op format is
  deliberately p2panda-shaped so this is a module swap, not a rewrite:
  the mapping is [ADR-010](adr/010-per-device-op-log.md)'s table, the path
  (thin wasm client + broker) is [ADR-011](adr/011-adopt-p2panda-direction.md),
  and the concrete two-sided gap list is
  [p2panda-gaps.md](p2panda-gaps.md). Until those gaps close, nothing that
  a p2panda crate would replace gets built here (the BACKLOG's
  `[frozen — p2panda]` label).

What survives Stage 7 on our side is exactly §5's domain line plus the UI —
which is the definition of a good template: the part you keep is the part
that was yours.
