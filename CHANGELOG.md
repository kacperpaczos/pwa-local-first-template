# Changelog

## Unreleased

### Added

- **Two new test layers** (`docs/architecture.md#test-layers`). `contract`
  runs one suite against every implementation of a port — `OpLogPersistence`
  is now exercised as both `MemoryOpLogPersistence` and the shipping
  `CollectionOpLogPersistence` (real TanStack persisted collections over
  `node:sqlite`), which previously had no test at all. `integration` composes
  the real local stack (facade → outbox → op log → engine → materializer)
  into 2-3 virtual devices, covering the facade→log path that only e2e
  touched, plus three-device convergence, restart-mid-cycle (closes BACKLOG
  §11) and tombstone GC gated on real acknowledgements.
- Shared test harness under `src/testing/harness/` (`FakeHub` extracted from
  `engine.test.ts`, `createVirtualDevice`, node:sqlite collections).
  Test-only and excluded from coverage.
- `pnpm test:e2e` now picks free ports when 8765 / 4173 are taken, and honours
  `GUN_PEER_PORT` / `E2E_WEB_PORT` (`scripts/e2e.mjs`).

### Changed

- `CollectionOpLogPersistence` and `persistLocal` moved from `db/client.ts` to
  `shared/store/collection-oplog-persistence.ts` — importing them no longer
  drags in OPFS, so the port and both its implementations sit together and can
  be contract-tested outside a browser.
- CI runs on Node 24 (the contract layer needs unflagged `node:sqlite`).

## 0.1.0

First tagged release. Repo audit + repair pass focused on hardening the sync
layer and reshaping module boundaries toward a future [p2panda](https://p2panda.org/)
migration (see [ADR-010](docs/adr/010-per-device-op-log.md)) — not a
migration itself, since p2panda has no stable browser binding yet.

### Breaking changes

- **Sync protocol bumped to v3** (per-device append-only operation logs,
  replacing v2's mutable-snapshot mutations over a Gun KV graph — see
  [ADR-010](docs/adr/010-per-device-op-log.md)). Old `app_sync` graph data
  from pre-0.1 builds is not read; a device upgrading republishes its local
  notes as a fresh op-log genesis on first boot, which converges with any
  peer doing the same through the normal merge path.
- **Pairing payload bumped to v3.** A v1/v2 pairing code now fails loudly
  instead of silently importing through an unconfirmed legacy path.
- **`VITE_AI_ENABLED` is now opt-in** — a production build ships with AI off
  unless the flag is explicitly set to `"true"` at build time (previously
  opt-out).

### Fixed

- Sync no longer silently drops a device's own mutations after a page
  reload or between two tabs on the same device — sequence numbers are now
  derived from persisted state under a lock instead of an in-memory counter.
- A single malformed remote operation can no longer wedge sync permanently;
  it is quarantined and surfaced (`degraded` sync status) while the rest of
  the log keeps flowing.
- Sync status no longer sticks on `outdated` until reload once one
  incompatible row is seen — it is recomputed every cycle.
- Tombstone garbage collection now requires every known peer to have
  actually acknowledged a deletion before hard-deleting it, closing a path
  where a note could resurrect after being GC'd locally. The peer roster
  counts devices from persisted log heads, and the startup pass runs after
  the first sync cycle, so the gate is evaluated against real acknowledgement
  state rather than an empty in-memory table on every boot.
- Ops are flagged as published only when the transport reports they actually
  went out. Previously an offline-only build (no relay configured) or a
  transport closed mid-flush marked them published anyway, which stranded the
  whole log: the next head announcement sat above rows no peer could fetch.
- Pairing or recovery now re-queues this device's own log for publication.
  Its previous ops were published to a Gun user graph the device can no
  longer reach, so without this a device with pre-pairing history never
  delivered it and left a permanent fetch gap for its new peers.
- A second browser tab can append to the log again. It previously failed
  every write for the tab's lifetime once a sibling tab appended, because the
  cross-tab counter ran ahead of that tab's in-memory index.
- An append interrupted between its two durable writes no longer risks
  forking this device's own log — height is derived from the highest stored
  op as well as the head row.
- Peer-supplied Lamport counters are range-checked, and the clock advances
  only for ops that actually applied. A single signed op with a counter at or
  above 2^53 could previously freeze the clock permanently, degrading LWW to
  its tie-break for every later edit.
- A failed *write* during materialization no longer permanently quarantines a
  valid op; quarantine is now reserved for payloads this device cannot decode
  or merge, and infrastructure failures retry.
- Backup import and export work on the corrupt-database recovery screen,
  which previously threw on the first note (the op-log index was never
  hydrated on that path).
- Gun subscriptions detach every child listener on unsubscribe and stop
  delivering into a torn-down subscription; previously only the first child
  was detached and stale announcements could reach a restarted engine.
- Pairing's legacy-import fallback, which routed a failed v2 parse straight
  around SAS confirmation, is removed.
- A Web Locks race could make "unload immediately followed by load" the AI
  engine spuriously report "AI active in another tab".

### Added

- Per-device ed25519 signing key (`shared/identity/device.ts`) — every op is
  now attributable to a specific device instead of a spoofable, unsigned
  origin id.
- Device roster in Settings, with each device's log height.
- PWA update-available toast (`registerType: "prompt"`) instead of a silent
  auto-reload.
- Biome as the project's linter/formatter; CI split into `check` (lint,
  typecheck, coverage, clean prod build, e2e-hook guard) and `e2e` jobs,
  plus a weekly scheduled run against dependency drift.
- Component testing (`@solidjs/testing-library` under a jsdom Vitest
  project) alongside the existing node-environment unit project.
- Completed PWA manifest (maskable + any icon variants, install
  screenshots), install-prompt button, app error boundary, 404 route.

### Known limitations worth calling out

- **The 6-digit pairing SAS authenticates nothing.** It is a transfer
  checksum: the digits derive from inputs the payload's own author chooses,
  over a 10^6 space, so an attacker who can rewrite the pairing channel can
  grind a forged payload that displays the genuine device's digits in well
  under a second. `pairing.test.ts` demonstrates the attack and asserts the
  current (insecure) behavior, so replacing it with an interactive SAS — a
  v0.2 item alongside `p2panda-auth` — fails loudly rather than silently.
  Until then, pair only over a channel an attacker cannot rewrite.

### Removed

- `checkpoint.ts` ("encrypted checkpoints") — shipped as unit-tested code
  with no call sites in the app; the README and ADR-008 claimed it as a
  working feature. Real log compaction is a v0.2/`p2panda-store` concern.
- `gun-transport.ts`, `apply-remote.ts`, `mutex.ts`, `entity-registry.ts` —
  superseded by the op-log transport/engine/materializer/payload-registry.
