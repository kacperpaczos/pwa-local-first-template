# ADR-005: Swappable SyncTransport

## Context
Mesh library choices change; product code must not.

## Decision
`SyncTransport` with `push` / `pull` / `resolve`. Default: `GunSyncTransport`. Fallback: `NoopSyncTransport`. Merge stays local in `applyRemoteMutations` (`resolve` is intentionally unused).

## Consequences
Gun can be replaced without rewriting Solid/OPFS/Loro.
