# Vision

## 1. Purpose

This is the foundational document of the repository. It defines what
local-first and peer-to-peer mean here, describes the architecture and the
protocol, assigns responsibilities to modules, justifies every runtime
dependency, marks the boundary between the template and the demonstration
domain, and lays out the migration path to p2panda together with the
reasoning behind it.

Decision history lives in [`adr/`](adr/); this document states the current
position. The repository is a template and a research vehicle, not a
product. The demonstration domain is intentionally minimal — one counter,
one label (section 6) — so that everything else in the tree constitutes the
template.

## 2. Definitions and commitments

### 2.1 Local-first

Local-first is defined here as four verifiable commitments:

1. **The user's device holds the source of truth.** Complete application
   state is stored in SQLite inside the browser, in the Origin Private File
   System (OPFS). No server holds the data; consequently, no server can
   withhold, edit, or lose it.
2. **Offline operation is not a degraded mode.** Every feature works
   without network connectivity. Synchronization is a background process
   that reconciles state when connectivity returns.
3. **Writes are durable before they are shared.** Every change is recorded
   in a local, append-only operation log before any network activity takes
   place. A crash, or an arbitrarily long offline period, loses no data.
4. **Concurrent edits merge deterministically.** Devices editing
   concurrently converge to the same state without a coordinator and
   without asking the user to choose a winner. Merges that discarded a
   value are recorded in a local conflict history for inspection.

### 2.2 Peer-to-peer in a browser

A browser tab cannot accept inbound connections, so direct
device-to-device transport is not available to a web application. The
practical architecture for the web — the same one the p2panda maintainers
describe in [p2panda#1235](https://github.com/p2panda/p2panda/issues/1235)
— is a thin client with a relay:

- each device signs and stores everything locally;
- devices exchange end-to-end encrypted operations through a relay;
- the relay cannot read, forge, or selectively alter the operations,
  because every operation is signed and hash-chained, and payload content
  is sealed with AES-GCM under a key held only by paired devices.

The relay is therefore a courier, not a participant. It requires no
account, holds no state worth stealing, and any instance of it is
replaceable.

## 3. Architecture overview

The following cross-section traces one write from a click to another
device. Each layer is a module with a defined seam; section 4 assigns
ownership.

```text
  click "+1"
    |
 1  UI (Solid)                    reads one live-queried state row
    |  facade.increment()
 2  PersistenceFacade             the only write API visible to the UI
    |  append {kind:"increment"}
 3  OpLogStore                    signs the operation with the device
    |                             Ed25519 key, chains it (BLAKE3 backlink,
    |                             sequence n+1), writes it durably under a
    |                             cross-tab Web Lock
 4  Materializer                  recomputes the state row from the log:
    |                             value = sum of increments, label =
    |                             last-writer-wins maximum; a pure function
    |                             of the operation set
 5  SyncEngine                    background: publishes unpublished
    |                             operations, observes remote log heads,
    |                             fetches missing ranges
 6  LogSyncTransport              the wire seam; currently GunLogTransport
    |                             (AES-GCM sealed payloads on a Gun graph)
 7  Relay (server/gun-peer)       zero-knowledge, replaceable
    |
    v  the same stack, mirrored, on every other paired device:
       fetch -> verify signature and chain -> ingest -> materialize -> UI
```

Three structural facts carry most of the design:

- **The log is the outgoing queue.** Each operation carries a `published`
  flag. A crash between append and publish leaves the operation queued,
  and the next synchronization cycle ships it. There is no second queue.
- **State is derived, never written directly.** The state row is a pure
  function of the operation set, which makes materialization idempotent
  and order-independent. This is what allows any interleaving of devices,
  tabs, and retries to converge;
  [ADR-012](adr/012-counter-hello-world.md) records why this property is
  load-bearing.
- **One log per entity and device.** Synchronization is an exchange of log
  heights: announce heads, fetch missing ranges, validate the hash chain,
  and quarantine what cannot be decoded, so that a single malformed
  operation never blocks the pipeline
  ([ADR-010](adr/010-per-device-op-log.md)).

## 4. Responsibilities and trust boundary

| Module | Owns | Must not |
| --- | --- | --- |
| `features/counter` | rendering and input handling | touch storage or synchronization directly |
| `shared/db/facade.ts` | the write API (`increment`, `setLabel`), Lamport stamping | expose log or synchronization internals to the UI |
| `shared/db/client.ts` | wiring: collections, store, engine, entity name | contain domain rules |
| `shared/oplog/` | operation header format, signing, hash-chain rules, payload schema registry | depend on transports or the UI |
| `shared/store/oplog-store.ts` | durable append and ingest, sequence derivation under locks, the read index | interpret payload content |
| `shared/store/materialize.ts` | folding operations into state; the merge policy | perform network activity |
| `shared/sync/engine.ts` | cycle orchestration: flush, pull, acknowledgements, status | parse or trust payload content |
| `shared/sync/gun-log-transport.ts` | moving sealed bytes; the wire layout on Gun | observe plaintext beyond the sealing boundary |
| `shared/identity/` | relay credential pair, device Ed25519 key, space key, pairing, BIP39 recovery | allow the device secret key to leave the module |
| `server/gun-peer` | relaying encrypted rows | any application logic |

The trust boundary lies at the transport seam: everything below it is
untrusted. Signatures and hash chains make the log tamper-evident; the
space key makes content unreadable to the relay; chain validation (with
verdicts `ok`, `gap`, `duplicate`, `fork`) makes reordering and replay
detectable.

## 5. Protocol

The protocol has three layers, separated deliberately.

### 5.1 Operation

The unit of change (`shared/oplog/header.ts`):

```ts
header = { v: 3, publicKey, entity, seq, backlink, timestamp, payloadHash, payloadSize }
op     = { hash: blake3(header), header, signature: ed25519(header) }
```

`seq` is the one-based height in the device's log for the given entity.
`backlink` is the hash of the previous operation and is null only at
sequence one. `timestamp` is advisory; merge decisions never read wall
clocks.

### 5.2 Payload

Payloads (`shared/oplog/payload.ts`) are validated per entity against a
registered schema and carried as sealed bytes. The demonstration entity
registers two kinds: `{kind: "increment", amount}` and `{kind:
"set_label", label, lamport}`. Payloads are deltas; the materializer gives
them meaning.

### 5.3 Wire

The wire layout (`shared/sync/protocol.ts`, `gun-log-transport.ts`)
consists of flat rows on the relay, containing ciphertext only:

```text
app_oplog/<entity>/logs/<device>/<seq> -> signed header fields plus AES-GCM ciphertext
app_oplog/<entity>/heads/<device>      -> { seq, hash }   monotone head announcement
app_oplog/<entity>/acks/<device>       -> { json }        acknowledged height per peer
```

A synchronization cycle proceeds as follows: publish own unpublished
operations (rows before the head announcement, so that an announced head
never points above a missing row); for each remote head above the local
height, fetch the missing range; verify signatures and chain positions;
ingest; materialize; publish acknowledgements. Every operation carries a
version field; an unsupported version degrades the status to `outdated`
for that cycle without latching.

## 6. Domain and template boundary

The boundary between the template (to be kept) and the demonstration
domain (to be replaced by a product) is exactly four files:

| Demonstration domain | Replace with |
| --- | --- |
| `shared/db/schemas.ts` | the product's entity row schema |
| `shared/oplog/payload.ts` (the registered schema) | the product's operation kinds |
| `shared/store/materialize.ts` | the product's merge policy |
| `features/counter/` | the product's UI |

Everything else — log, store, engine, transport, identity, settings — is
domain-independent.

The counter was chosen because it is the smallest domain that still proves
the machinery. A grow-only counter (concurrent writes are summed) and a
last-writer-wins register (concurrent writes resolve to one deterministic
winner) are the two primitive merge strategies; a product domain composes
them and may add richer conflict-free replicated data types. Collaborative
text, which the notes-era version of this repository implemented with
Loro, would return as a document-delta operation kind folded in the
materializer.

## 7. Dependencies

Each runtime dependency is listed with the reason it is present and its
fate on the migration path of section 8.

| Dependency | Reason | Fate |
| --- | --- | --- |
| `solid-js`, router, Kobalte, Tailwind | the UI layer; no coupling to synchronization | remains; replaceable by the user |
| `@tanstack/db`, `@tanstack/browser-db-sqlite-persistence` | typed collections over SQLite in OPFS; cross-tab coordination | remains, behind the `OpLogPersistence` port and the facade |
| `gun` (with SEA) | the relay transport available in a browser today; SEA authenticates graph writes | replaced by a p2panda broker client at the `LogSyncTransport` seam |
| `@noble/curves`, `@noble/hashes` | Ed25519 signatures and BLAKE3 hashes for the operation format | replaced by `p2panda-core`, which uses the same primitives |
| `@scure/bip39` | recovery phrase for the space key | replaced together with `p2panda-encryption` |
| `zod` | schema validation at trust boundaries | remains |
| `nanostores` | minimal UI-visible state, such as the synchronization status | remains |
| `qrcode` | rendering the pairing payload | remains until pairing moves to `p2panda-auth` |

The test tooling (four Vitest layers and Playwright) is described in
[architecture.md, section 5](architecture.md#5-test-layers).

## 8. Migration path to p2panda

The repository's history is a staged argument. Each stage exists because
the previous one fails a specific requirement; the sequence is also the
order in which one would rebuild the system or evaluate an alternative
stack.

**Stage 0 — local state.** A collection over SQLite in OPFS.
Motivation: commitments 1 and 2 — the source of truth on the device and
full offline operation. Insufficient as soon as a second device exists.

**Stage 1 — an append-only operation log under every write.**
Motivation: synchronizing snapshots loses concurrent edits and cannot
answer what changed since a given point. A log provides durable writes
(commitment 3), history, and a unit of synchronization. Insufficient as
soon as the network is untrusted.

**Stage 2 — signing and hash-chaining each device's log.**
Motivation: the transport is someone else's computer. Signatures make
authorship verifiable, so a peer cannot forge another device's changes;
backlinks make gaps, forks, and tampering detectable. Insufficient for
privacy.

**Stage 3 — sealed payloads and a zero-knowledge relay.**
Motivation: a browser cannot connect device to device, so a relay is
unavoidable; it must therefore be blind. AES-GCM under a key held by
paired devices, with additional authenticated data binding the ciphertext
to the signed header, means the relay moves envelopes it cannot open.
Insufficient for efficiency.

**Stage 4 — log-height synchronization.**
Motivation: replaying the full history on every start grows without
bound. Head announcements, range fetches, and acknowledgements make the
cost proportional to what actually changed. Insufficient without merge
semantics.

**Stage 5 — deterministic materialization.**
Motivation: operations need a merge policy to become state. Defining
state as a pure function of the operation set (a sum, and a
last-writer-wins maximum) turns convergence from a protocol property into
arithmetic, which satisfies commitment 4. Insufficient once a person owns
several devices.

**Stage 6 — identity and pairing.**
Motivation: "my devices" must be a verifiable notion. Each device holds a
signing key that never leaves it; a shared space key is moved by QR or
JSON payload during pairing; a BIP39 phrase allows recovery. The known
and documented gaps of this stage are the pairing checksum, the absence
of revocation, and the absence of forward secrecy
([BACKLOG](BACKLOG.md), items 2.1 to 2.3).

**Stage 7 — replacing the fabric with p2panda.**
Motivation: stages 1 to 6 amount to roughly two thousand lines of
in-repository synchronization code, and every finding of the August 2026
audit was located in that code. p2panda provides the same structures as
maintained crates, including the authorization and encryption layers
(`p2panda-auth`, `p2panda-encryption`) that close the stage-6 gaps
properly. The operation format here was shaped after p2panda's from the
start, so the migration is a module replacement rather than a rewrite:
the module-to-crate mapping is in
[ADR-010](adr/010-per-device-op-log.md), the chosen path (thin
WebAssembly client plus broker) is in
[ADR-011](adr/011-adopt-p2panda-direction.md), and the concrete gap list
on both sides is in [p2panda-gaps.md](p2panda-gaps.md). Until those gaps
close, nothing that a p2panda crate would replace is built here; the
affected backlog items carry the label `frozen — p2panda`.

After stage 7, what remains in this repository is the domain boundary of
section 6 and the UI — which is the intended definition of the template.

## 9. Related documents

- [architecture.md](architecture.md) — layer diagram, replacement points,
  test layers, invariants
- [adr/](adr/) — decision records
- [BACKLOG.md](BACKLOG.md) — open work, labelled by fate
- [p2panda-gaps.md](p2panda-gaps.md) — the gap list for the upstream
  conversation
