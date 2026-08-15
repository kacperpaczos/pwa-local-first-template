# Backlog

## 1. Purpose and labels

Open work, ordered by priority within each section. Items carry enough
context to be picked up without prior knowledge; the reasoning behind most
of them is in [ADR-010](adr/010-per-device-op-log.md) and the version 0.1.0
changelog entry.

Since [ADR-011](adr/011-adopt-p2panda-direction.md), the direction is
active adoption of [p2panda](https://p2panda.org/) along the thin-client
and broker path. Every item carries one of three labels:

- `frozen — p2panda`: do not build this. The designated fix is a p2panda
  crate; an in-repository version would be discarded at migration. Frozen
  items stay listed, and their security caveats stay documented, because
  the gaps are real until the replacement lands.
- `ours`: actionable regardless of the migration; the work either survives
  the replacement or protects users on the bridge stack today.
- `new — audit 2026-08`: found in the August 2026 audit of the
  synchronization stack; first in the queue for code work.

The gap list for the upstream conversation is
[p2panda-gaps.md](p2panda-gaps.md).

## 2. Security

### 2.1 `frozen — p2panda` — the pairing checksum authenticates nothing

`shared/identity/pairing.ts#deriveSasDigits`.

The six digits are derived from `spaceId` and `pair.pub`, both chosen by
whoever authored the payload, over a space of one million values. An
attacker able to rewrite the pairing channel reads the genuine code's
digits, then searches for a `spaceId` such that a forged payload (with the
attacker's keys) displays the same digits. The search completes offline in
well under a second. The victim compares digits, they match, and the
attacker's keys are imported.

`pairing.test.ts` contains a test that executes this attack and asserts the
current insecure behaviour, so a real fix will fail that test visibly
rather than leave it silently green.

A proper fix requires an interactive short-authentication-string exchange:
both sides commit to fresh ephemeral values, and the digits are derived
from the transcript. The one-way QR/JSON flow has no room for that, so this
is a flow change, not a patch, and the natural point to make it is the
adoption of `p2panda-auth`. Until then, the pairing channel itself is the
trust boundary; this is documented in the README and ADR-006.

### 2.2 `frozen — p2panda` — no device revocation or key rotation

Any party holding the space key has full read and write access
indefinitely. Removing a device from a space is not implemented; the
device roster in Settings shows which devices have synchronized but cannot
evict one. Maps to `p2panda-auth`.

### 2.3 `frozen — p2panda` — no forward secrecy or post-compromise security

There is one shared AES-256 space key, so any party that ever held it can
decrypt the entire history. Maps to `p2panda-encryption` and
`p2panda-spaces`.

## 3. Correctness and robustness

### 3.1 `ours` — acknowledgements are session state only

`shared/sync/engine.ts` — `acksByDevice` lives in memory and is rebuilt
from relay subscriptions on every start. Since
[ADR-012](adr/012-counter-hello-world.md) nothing is deleted, so the
tombstone garbage collection that consumed this signal is gone; the
coverage gate (`isOpCovered`) and the roster remain, used by the device
roster display and required by any future pruning. Persisting
acknowledgements (a third small collection, or a column on `oplog_heads`)
would make coverage deterministic across reloads. Do this when pruning
returns, which maps to `p2panda-store`.

### 3.2 `ours` — a corrupt device key silently creates a new identity

`shared/identity/device.ts#loadDeviceKey` returns null on unparseable
storage, so `ensureDeviceKey` generates a fresh key pair. The old log is
never appended to again — there is no fork, because the new device has its
own log and its own counter key — but attribution is silently lost and the
roster gains a permanent ghost entry. A decision is needed: surface the
event to the user, or accept and document it. Currently neither happens.

### 3.3 — resolved: pending delete operations were rescanned indefinitely

Obsolete since [ADR-012](adr/012-counter-hello-world.md): the counter
domain has no deletes, and the materializer recomputes state instead of
planning per-operation folds. The item returns only if a future domain
reintroduces cross-operation dependencies, such as a delete arriving
before the corresponding create.

### 3.4 `ours` — no way to release a quarantined operation

Quarantine is permanent; nothing removes an operation from it. The
conflict history in Settings lists the entries but offers no retry. After
a fix that makes a previously undecodable payload readable, those
operations stay dead. A retry action would need to clear the flag and let
the materializer fold them again.

### 3.5 `ours` — version stamping in `opFromWireRow`

`shared/sync/protocol.ts` stamps `OPLOG_VERSION` rather than carrying
`row.v`. This is safe only while the supported range is a single version:
the version is part of the signed, hashed header, so widening the range
without carrying the row's own version would make every non-current row
fail hash verification at ingest. The constraint is commented in place and
must be addressed with the next protocol version.

### 3.6 `ours` — entity-generality is one step short

The wire protocol, the payload registry, and the store are parameterized
by entity, but `client.ts` hydrates and materializes only `"counter"`.
Adding a second entity requires a materializer registry and a hydration
list, not a protocol change. Worth doing when a second entity actually
exists; that will be the test of whether the generalization holds.

### 3.7 `ours` — reliability of the per-row fetch on Gun

`gun-log-transport.ts#fetchOps` reads rows one sequence number at a time
with a timeout. This has not been soak-tested against a loaded relay. The
engine's gap retry covers transient misses, but the per-row round trip is
also the dominant synchronization latency cost. Needs a soak test against
`server/gun-peer` under load, and possibly a batched read.

### 3.8 — resolved: crash between append and publish had no test

`sync-stack.integration.test.ts` appends without flushing, rebuilds the
store and engine over the same persisted state (the boot path), and asserts
that the operation still ships and reaches a peer.

## 4. Audit findings, August 2026

### 4.1 `new — audit 2026-08` — an undecryptable wire row stalls that log silently

`gun-log-transport.ts#fetchOps` skips a row it cannot decrypt or parse,
and the engine reads the resulting hole as a relay propagation delay, so
it refetches the same range every cycle indefinitely. Only a protocol
version mismatch surfaces a status (`outdated`); a decryption failure
surfaces nothing. One corrupt or tampered row on the relay means the
authoring device's log above that sequence number never ingests, with no
signal in the UI and a permanent retry loop. Quarantine covers bad
payloads after ingest, not bad rows before ingest.

Fix shape: count consecutive failed decryptions per device and sequence
number, surface `degraded` with a reason after a threshold, and back off
the retry instead of repeating it every cycle. This protects users on the
bridge stack and is worth doing despite the migration direction.

### 4.2 `new — audit 2026-08` — flag updates write one row per round trip

`oplog-store.ts` — `markPublished` and `markApplied` both loop over
`persistence.patchOp` one hash at a time. After a large flush (the first
synchronization of a long log, or republication after pairing) this is a
sequence of storage round trips where one batched write would suffice. Add
a `patchOps(hashes, patch)` method to the `OpLogPersistence` port; the
contract suite covers both implementations.

## 5. Performance

### 5.1 `frozen — p2panda` — linear scans in the operation log read index

`shared/store/oplog-store.ts` — `opAtIndexed`, `maxOwnSeqIndexed`, and
`query()` walk every operation in the index. Acceptable at template scale;
linear in the lifetime operation count. Secondary maps would fix it, but
the store maps to `p2panda-store`.

### 5.2 `frozen — p2panda` — no log compaction

Log size grows with the lifetime operation count (every click is an
operation) and nothing prunes it. Real compaction maps to `p2panda-store`
pruning. A cheap mitigation is available now: debounce rapid clicks in the
facade so that a burst becomes one increment operation with a larger
amount.

## 6. Tooling and continuous integration

### 6.1 `ours` — coverage is collected but not enforced

`vitest.config.ts` reports coverage summaries and the CI prints them to
the job summary, but no thresholds exist. Pick a floor and fail below it;
otherwise coverage only ever declines.

### 6.2 `ours` — thin component test coverage

Three component test files exist (InstallAppButton, AppErrorBoundary, the
PairingSection error path). The jsdom project works; CounterPage and the
Settings sections are straightforward to test and untested.

### 6.3 `ours` — missing CI gates

No Lighthouse or PWA assertion, although manifest correctness is a
headline feature; no bundle size budget; no dependency audit.

### 6.4 `ours` — remove `workbox-window`

Listed in development dependencies, imported nowhere;
`virtual:pwa-register` is what the application actually uses.

## 7. Platform

### 7.1 `ours` — Chromium only

The Origin Private File System requirement excludes Safari and Firefox at
present. Revisit when OPFS support broadens, or if a native shell becomes
the answer.

### 7.2 `ours` — `@tanstack/browser-db-sqlite-persistence` is pre-1.0

Kept behind `PersistenceFacade` and the `OpLogPersistence` port so it
remains replaceable. Its asynchronous write confirmation is the reason
`OpLogStore` maintains its own read index; consult the consequences
sections of ADR-010 and ADR-012 before changing that.
