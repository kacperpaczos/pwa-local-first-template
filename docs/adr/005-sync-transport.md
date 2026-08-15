# ADR-005: Swappable SyncTransport

> **Superseded by [ADR-010](010-per-device-op-log.md)** for the concrete interface shape (`SyncTransport` → `LogSyncTransport`, `GunSyncTransport` → `GunLogTransport`). The swap-point *principle* below — a mesh-agnostic interface with a Noop fallback — is unchanged and still the layer 8 seam referenced in the README's p2panda comparison.

## Context
Mesh library choices change; product code must not.

## Decision
`LogSyncTransport` with `publish` / `publishAcks` / `subscribeHeads` / `subscribeAcks` / `fetchOps`. Default: `GunLogTransport`. Fallback: `NoopLogTransport`. Merge stays local in `materialize.ts` (the transport carries signed ops, not merge decisions).

## Consequences
Gun can be replaced without rewriting Solid/OPFS/Loro — this is the seam the eventual p2panda-net migration targets.
