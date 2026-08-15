# Backlog

Open work after v0.1.0. Ordered by priority within each section. Items carry
enough context to be picked up cold — the reasoning behind most of them lives
in [ADR-010](adr/010-per-device-op-log.md) and the v0.1.0 CHANGELOG entry.

The v0.2 direction is unchanged: replace homegrown pieces with
[p2panda](https://p2panda.org/) crates once a stable browser binding exists.
The module→crate mapping table is in ADR-010.

---

## Security — known holes

### 1. The pairing SAS authenticates nothing

`shared/identity/pairing.ts#deriveSasDigits`

Six digits derived from `spaceId + pair.pub` — both chosen by whoever
authored the payload — over a 10^6 space. An attacker who can rewrite the
pairing channel reads the genuine code's digits, then grinds their own
`spaceId` until a forged payload (own keys) displays the same digits. Offline,
well under a second. The victim compares digits, they match, and the attacker's
keys are imported.

`pairing.test.ts` contains a test that **executes this attack and asserts the
current insecure behavior**, so a real fix will fail it loudly rather than
leave it silently green.

Fixing it properly needs an interactive SAS: both sides commit to fresh
ephemeral values, then derive the digits from the transcript. The one-way
QR/JSON flow has no room for that, so this is a flow change (two-way channel
or a short live exchange), not a patch. Natural pairing with p2panda-auth
adoption.

Until then: the pairing channel itself is the trust boundary. Documented in
the README caveats and ADR-006.

### 2. No device revocation or key rotation

Anyone holding the space key has full read/write forever; removing a device
from a space is not implemented. The Settings device roster shows who has
synced but cannot evict. Maps to `p2panda-auth`.

### 3. No forward secrecy / post-compromise security

One shared AES-256 space key, so anyone who ever held it can decrypt all
history. Maps to `p2panda-encryption` / `p2panda-spaces`.

---

## Correctness / robustness

### 4. Acks are session state only

`shared/sync/engine.ts` — `acksByDevice` lives in memory and is rebuilt from
Gun subscriptions on every boot. The GC coverage gate compensates by treating
an unacked-but-known peer as *not* covering (conservative, correct), and the
startup GC pass is chained after the first sync cycle so acks have a chance to
arrive. But an automatic GC pass right after boot on a flaky network will
still usually skip.

Persisting acks (a third small collection, or a column on `oplog_heads`) would
make GC deterministic across reloads. Deferred from v0.1 to avoid another
schema version for a best-effort background job.

The *gate* itself is now covered against real acks across three devices
(`gc-coverage.integration.test.ts`), so a regression in coverage logic fails
fast. Persisting acks across reloads remains open.

### 5. Corrupt device key silently mints a new identity

`shared/identity/device.ts#loadDeviceKey` returns `null` on unparseable
storage, so `ensureDeviceKey` generates a fresh keypair. The old log is never
appended to again (no fork — the new device has its own log and its own
counter key), but attribution is silently lost and the roster grows a ghost
entry that can never be removed.

Decide: surface it to the user, or accept and document it. Currently neither.

### 6. `pending` delete ops are rescanned forever

`shared/store/materialize.ts` — a `delete` op whose target note has never been
seen stays unapplied and is re-planned on every cycle. Harmless (the plan is
pure and cheap, nothing blocks behind it) but unbounded if the creating
device never shows up. Consider aging them into quarantine after N cycles.

### 7. No way to release a quarantined op

Quarantine is permanent — nothing un-quarantines. The Settings conflict
history lists the entries but offers no retry. After a bug fix that makes a
previously-undecodable payload readable, those ops stay dead. A "retry
quarantined" action would need to clear the flag and let the materializer
re-plan.

### 8. Version stamping in `opFromWireRow`

`shared/sync/protocol.ts` stamps `OPLOG_VERSION` rather than carrying
`row.v`. Safe only while `SUPPORTED_MIN_V === SUPPORTED_MAX_V === 3` — the
version is inside the signed, hashed header, so widening the supported range
without fixing this makes every non-current row fail hash verification at
ingest. Commented in place; must be handled with the next protocol bump.

### 9. Entity-agnosticism is one step short

The wire protocol, payload registry, and store are entity-parameterized, but
`client.ts` hydrates and materializes only `"notes"`
(`store.hydrate([SYNC_ENTITY])`, `materializeNoteOps`). Adding a second entity
needs a materializer registry and a hydrate list, not a protocol change. Worth
doing when a second entity actually exists — that is the test of whether the
generalization holds.

### 10. Gun `.once()` range-fetch reliability

`gun-log-transport.ts#fetchOps` reads rows one seq at a time with a timeout.
Never soak-tested against a loaded relay; the engine's gap retry covers
transient misses, but the per-row round trip is also the main sync latency
cost. Wants a soak test against `server/gun-peer` under load, and possibly a
batched read.

### 11. Crash between append and publish

~~The log doubles as the outbox (`published` flag), which replaced the
offline-transactions retry path for network failures. A crash between the
durable append and the publish leaves the op queued — correct by design, but
there is no test for it. Add one.~~

**Done.** `sync-stack.integration.test.ts` appends without flushing, rebuilds
the store + engine over the same persisted state (the boot path), and asserts
the op still ships and lands on a peer.

---

## Performance

### 12. O(n) scans in the op-log read index

`shared/store/oplog-store.ts` — `opAtIndexed`, `maxOwnSeqIndexed`, and
`query()` all walk every op in the index. Fine at v0.1 scale, linear in
lifetime edit count. Add secondary maps (`(entity,device,seq) → hash`,
per-flag sets) when the log gets large enough to matter.

### 13. No log compaction

Full-state `upsert` payloads mean log size grows with edit count, not content
size. No pruning ships in v0.1. Two directions, both v0.2: Loro delta payloads
(`export({mode:"update"})`, needs causal-gap handling at the materializer) and
real compaction (maps to `p2panda-store` pruning).

Cheap mitigation available now: debounce/coalesce rapid edits in the facade so
a burst of keystrokes is one op, not twenty.

---

## Tooling / CI

### 14. Coverage is collected but not enforced

`vitest.config.ts` reports `text-summary` + `json-summary` and CI prints it to
the job summary, but there are no thresholds. Pick a floor and fail under it,
otherwise coverage only ever ratchets down.

### 15. Thin component test coverage

Three `.tsx` test files (InstallAppButton, AppErrorBoundary, PairingSection
error path). The jsdom project exists and works — the extracted Settings
sections and AI panels are now easy to test and untested.

### 16. Missing CI gates

- No Lighthouse/PWA assertion, despite manifest correctness being a headline
  feature.
- No bundle-size budget (the main chunk already warns at >500 kB).
- No dependency audit.

### 17. Remove `workbox-window`

Listed in `devDependencies`, imported nowhere (`virtual:pwa-register` is what
the app actually uses).

---

## Platform

### 18. Chromium only

OPFS requirement. Safari/WebKit out of scope for v0.1. Revisit when OPFS
support is broad enough, or if a native shell becomes the answer.

### 19. `@tanstack/browser-db-sqlite-persistence` is pre-1.0

Kept behind `PersistenceFacade` and the `OpLogPersistence` port so it stays
swappable. Its async write-confirmation behavior is the reason `OpLogStore`
maintains its own read index — see ADR-010's consequences section before
changing that.
