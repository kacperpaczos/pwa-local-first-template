# ADR-010: Per-device append-only operation log (protocol v3)

## Context

The v2 wire scheme synced mutable entity snapshots over a Gun KV graph, coordinated by a single in-memory `seq` counter per transport instance and a persisted per-origin cursor. That mismatch was structural, not incidental:

- `nextSeq` lived only in memory and reset to 1 on every page reload or new tab, while the remote cursor watermark was durable — a device's post-reload mutations could be silently filtered out by peers until its counter climbed back past the old watermark.
- Two tabs on one device shared the same `origin` id but had independent in-memory counters, so concurrent writes from both tabs could collide on the same `seq`.
- `applyRemoteMutations` had no per-mutation isolation: a single malformed `body_doc` threw, the sync cursor was never written, and the exact same mutation was re-pulled and re-thrown on every subsequent cycle — sync wedged permanently with no UI signal.
- The GC "coverage gate" compared a tombstone's `deleted_lamport` against the max Lamport value across *local* notes — a value that is by construction always ≥ any local tombstone's clock, so the gate always passed regardless of whether any peer had actually seen the deletion.
- `op` on the wire was decorative; deletion was inferred from `payload.deleted_at`, so the protocol's own stated semantics weren't load-bearing.

We are also deliberately steering the whole sync stack toward eventual replacement by [p2panda](https://p2panda.org/) once it ships a stable browser binding (see README "Why a template"). p2panda's core primitive is a per-author, hash-linked, signed operation log. Redesigning v3 around the same shape now means the v0.2 migration is a module swap behind existing seams, not a second rewrite of the merge/materialization layer.

## Decision

Replace snapshot-mutation sync with **per-device, append-only, hash-linked operation logs**, one log per `(entity, device)`.

**Operation header** (`shared/oplog/header.ts`) — p2panda-shaped, not p2panda-identical:

```ts
type OpHeader = {
  v: 3;
  publicKey: string;   // device ed25519 pub, base64url — the log's "author"
  entity: string;
  seq: number;         // 1-based height in this device's log for this entity
  backlink: string | null;  // hash of the previous op; null only at seq 1
  timestamp: number;   // ms epoch, advisory only — never used for merge decisions
  payloadHash: string; // blake3 of the plaintext payload
  payloadSize: number;
};
type Operation = { hash: string; header: OpHeader; signature: string };
```

Canonical encoding is sorted-key JSON (not CBOR/Postcard) and `timestamp` is milliseconds (not seconds) — the two deltas from p2panda-core v0.7 we're deferring to the actual migration, since closing them now buys nothing until real interop is on the table.

**Per-device signing key** (`shared/identity/device.ts`): every device generates its own ed25519 keypair on first boot and never transfers it — not even during pairing. This is the load-bearing change from v2: op authorship is now a real signature over real key material instead of a self-asserted, unsigned `origin` UUID a peer could spoof to poison another device's cursor watermark. The shared SEA pair and shared space key are unchanged in kind (see "What's still shared" below).

**Full-state payloads, not deltas.** An op's payload is either `{kind: "upsert", note}` (the complete `Note` row, Loro snapshot included) or `{kind: "delete", id, deleted_at, deleted_lamport}`. This keeps `mergeNote`'s existing per-field LWW + Loro-merge logic unchanged and makes ops idempotent and order-tolerant at the materializer — replaying the same op twice, or two devices' logs in either interleaving, converges to the same state. Loro `export({mode:"update"})` deltas are a deliberate v0.2 optimization: they cut op size but require handling causal gaps at the materializer, which full snapshots don't.

**Seq is derived from persisted state under a lock**, not an in-memory counter (`shared/store/oplog-store.ts`). `append()` reads the current head from the store's own read index (populated from durable storage via `hydrate()`, kept current on every write) inside an exclusive Web Lock, and a cross-tab `localStorage` counter closes the gap between "committed to the persisted collection" and "visible to a query" (see the note on `OpLogStore`'s in-memory index below). This structurally removes both the reload-reset and cross-tab-collision failure modes: seq can only ever come from what was actually durably written.

**Quarantine, not rejection.** `ingest()` validates an incoming op's signature and chain position (`ok | gap | duplicate | fork`) before ever looking at its payload; chain-invalid ops are dropped without touching the head. A stored op whose payload later fails to decode or merge (`materializeNoteOps`, `shared/store/materialize.ts`) is quarantined per-op — logged with a reason, excluded from future materialization passes — while every other op keeps flowing. One corrupt op can no longer wedge the whole pipeline.

Quarantine is reserved for verdicts on the *data*: a failure to write is left to propagate and retry, because quarantining is permanent and a full disk says nothing about an op's validity. For the same reason the Lamport clock only advances for an op that actually landed, and peer-supplied counters are range-checked at the parse boundary (`MAX_LAMPORT`) — a single signed op carrying a counter at or above 2^53 would otherwise freeze the clock for good, since the poisoned value propagates into note rows and re-seeds from them on every boot.

**Publication is only claimed when it happened.** `LogSyncTransport.publish` returns the ops it actually put on the wire, and only those are flagged `published`. A transport with no peers (Noop) or one closed mid-run reports none, so its ops stay queued. The flag also resets for this device's own log whenever `restart()` swaps the transport after a pairing or recovery import: "published" was true of a Gun user graph the device can no longer reach, and leaving it set would strand the pre-change history while the next op announced a head above a hole no peer could fetch past.

**Real GC coverage** (`shared/sync/coverage.ts`, `shared/sync/engine.ts#isOpCovered`): a tombstone is hard-deletable only once every other device in the roster has acked the deleting op's `(device, seq)` to at least that height. The roster is built from **persisted** log heads as well as this session's head/ack traffic — acks themselves are session state, so a roster made only of live subscription data would be empty at exactly the moment the startup GC pass runs, making the gate vacuously true on every boot (the same no-op gate this rewrite set out to replace). GC is therefore also chained after the first sync cycle rather than fired alongside it, so acks have arrived before the gate is evaluated. A device with no known peers is *vacuously* covered — correct for a standalone or not-yet-paired device. The 90-day retention window remains a backstop for a peer that goes permanently offline after being observed once.

**Wire layout on Gun** (`shared/sync/gun-log-transport.ts`) is a clean break from v2 — no dual-read bridge:

```
app_oplog/<entity>/logs/<device>/<seq>  → wire row (opaque AES-GCM ciphertext)
app_oplog/<entity>/heads/<device>       → { seq, hash }   (monotone — safe under Gun's own LWW)
app_oplog/<entity>/acks/<device>        → { json: "{...}" }  (that device's view of every other device's acked height)
```

The transport subscribes only to `heads`/`acks`, not to every op row (`.map().on()` over the whole entity as v2 did) — op rows are range-fetched on demand once a head announcement shows there's something new, so boot cost no longer grows with lifetime edit count. It also **fails closed**: if the space key can't be loaded, the transport rejects rather than falling back to per-pair SEA encryption (v2's behavior), and the engine surfaces a `locked` status instead of silently downgrading ciphertext strength.

**Old `app_sync` graph data is ignored, not migrated.** This is pre-0.1 software with no install base to preserve; a v2/v3 bridge would mean keeping every v2 failure mode's code path alive and tested indefinitely for zero real users. On first v3 boot, a device with existing local notes but no log yet republishes them as genesis `upsert` ops in its own log — convergent with any other device doing the same, via the same LWW/Loro merge that handles any other concurrent edit.

### What's still shared (deliberately out of scope for v0.1)

Pairing still transfers one shared SEA pair (Gun write-ACL) and one shared AES-256 space key (content encryption) to every device — the payload is now v3 (adds an informational `inviterDevice` id) but the trust model is unchanged: any device holding the space key can write, and revocation isn't implemented. Real per-device authorization is `p2panda-auth`'s job; closing that gap now would mean building a bespoke groups/ACL system this template would then have to throw away at the actual migration. See README "Known caveats".

### What was deleted, not carried forward

- `gun-transport.ts` / `apply-remote.ts` — superseded by `gun-log-transport.ts` / `engine.ts` + `materialize.ts`.
- `checkpoint.ts` — the v2 code shipped `sealCheckpoint`/`publishCheckpointToGun` with unit tests but **zero call sites in the app**; README and ADR-008 claimed "encrypted checkpoints" as a shipped feature. Real log compaction is a `p2panda-store`-shaped v0.2 concern; we chose deleting dead code over wiring up a feature nobody asked for to make the claim technically true.
- `mutex.ts` — superseded by `navigator.locks`-based exclusion in `oplog-store.ts` and `engine.ts`.
- `entity-registry.ts` — folded into `shared/oplog/payload.ts`'s per-entity payload schema registry.

## Consequences

- Sync survives reload and multi-tab use without data loss by construction (regression-tested in `oplog-store.test.ts` and `engine.test.ts`), not by a patched-over cursor scheme.
- A malformed or hostile op degrades sync status to `degraded` (visible in Settings → device roster / conflict history) instead of silently wedging it.
- Every op is individually attributable to a signing device, closing the spoofable-origin gap — though authorization (who may hold the space key) is unchanged from v2 and remains the biggest open item toward the p2panda mapping.
- Full-snapshot payloads mean log size grows with edit count, not just content size, and there is no compaction yet; this is an accepted v0.1 tradeoff against implementation complexity, tracked for v0.2 alongside the p2panda-store swap.
- `OpLogStore` reads from an in-memory index rather than re-querying the persisted TanStack collection on every call, because `persistedCollectionOptions` collections confirm a write through an async round trip — a query issued immediately after `await tx.commit()` resolves can observe the just-written row as momentarily absent. The index is populated via `hydrate()` after collections finish preloading and kept synchronously current on every write; `persistence` remains the durability layer and the `hydrate()` source, not the live read path. Because that index is per-instance and sibling tabs share one database, `append` re-reads from persistence whenever the cross-tab counter runs ahead of it, and derives the height from the highest op it can find as well as the head row — so a second tab, or a crash between the two durable writes of an append, extends the chain instead of reusing a seq (which would fork this device's own log).
- The corrupt-database path preloads and hydrates before surfacing `RecoveryScreen`, since recovery still has to read notes to export them and append imported ones — both of which need a populated head index.

## v0.2 mapping (target: p2panda)

| This module | p2panda crate | Known delta to close |
| --- | --- | --- |
| `shared/oplog` (header, ed25519, blake3) | `p2panda-core` | canonical JSON → CBOR/Postcard; ms → s timestamps; add `previous` for cross-log deps |
| `shared/store/oplog-store` (+ `oplog-persistence`) | `p2panda-store` | API is already trait-shaped for this swap |
| `shared/sync/engine` | `p2panda-sync` | protocol framing, real log-height exchange semantics |
| `shared/sync/gun-log-transport` | `p2panda-net` (iroh) | browser support is iroh's "Browsers Alpha" (relay-only) as of this writing — not a blocker for the seam, a blocker for switching it on |
| `shared/store/materialize` | app-side materialization from logs | concept unchanged |
| `shared/identity/device` | `p2panda-core` key types | already 1:1 (both ed25519) |
| shared space key + AES-GCM envelope | `p2panda-encryption` / `p2panda-spaces` | real group encryption replaces one shared key |
| roster + ack-based GC | `p2panda-auth` + log pruning | real membership/permissions instead of "anyone with the space key" |
