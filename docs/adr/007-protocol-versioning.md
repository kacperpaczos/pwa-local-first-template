# ADR-007: Protocol versioning on Gun envelopes

## Context
Wire format will change; clients must degrade sync without losing local data.

## Decision
Every Gun mutation carries `v`. Client supports `[SUPPORTED_MIN_V, SUPPORTED_MAX_V]`. Incompatible remote mutations are skipped and sync status becomes `outdated`.

## Consequences
No WS hello handshake. Version gates live in Zod parse + transport receive path.
