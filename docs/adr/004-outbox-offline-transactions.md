# ADR-004: Outbox via offline-transactions

## Context
Offline writes must not be lost and must sync FIFO with multi-tab leadership.

## Decision
Use `@tanstack/offline-transactions` as the outbox engine (IndexedDB-backed), not a custom SQL `mutations` table.

## Consequences
Idempotency keys live on the wire; snapshot mutations (`upsert`/`soft_delete`) rather than append-only op-log.
