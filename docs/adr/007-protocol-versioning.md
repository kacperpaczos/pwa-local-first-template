# ADR-007: Protocol versioning on Gun envelopes

> Still current under [ADR-010](010-per-device-op-log.md) — the wire moved from mutation snapshots to signed op rows, but every row still carries `v` and the same `[SUPPORTED_MIN_V, SUPPORTED_MAX_V]` gate applies (now `[3, 3]`). One behavioral fix: `outdated` status no longer latches — ADR-010's engine recomputes sync status every cycle instead of sticking once a single incompatible row is seen.

## Context
Wire format will change; clients must degrade sync without losing local data.

## Decision
Every Gun op row carries `v`. Client supports `[SUPPORTED_MIN_V, SUPPORTED_MAX_V]`. Incompatible remote rows are skipped and sync status becomes `outdated` for that cycle.

## Consequences
No WS hello handshake. Version gates live in Zod parse + transport receive path.
