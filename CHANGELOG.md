# Changelog

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
  where a note could resurrect after being GC'd locally.
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

### Removed

- `checkpoint.ts` ("encrypted checkpoints") — shipped as unit-tested code
  with no call sites in the app; the README and ADR-008 claimed it as a
  working feature. Real log compaction is a v0.2/`p2panda-store` concern.
- `gun-transport.ts`, `apply-remote.ts`, `mutex.ts`, `entity-registry.ts` —
  superseded by the op-log transport/engine/materializer/payload-registry.
