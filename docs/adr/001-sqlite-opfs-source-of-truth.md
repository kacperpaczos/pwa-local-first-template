# ADR-001: SQLite/OPFS as source of truth

## Context
Browser PWA needs durable local data with multi-tab coordination.

## Decision
Use TanStack DB + `@tanstack/browser-db-sqlite-persistence` (wa-sqlite/OPFS) as SoT.

## Alternatives rejected
Gun graph as SoT; IndexedDB document stores without SQL query model.

## Consequences
Chromium/OPFS required. Persistence layer is young — isolate behind facade.
