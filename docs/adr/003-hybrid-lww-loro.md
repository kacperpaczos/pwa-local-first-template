# ADR-003: Hybrid LWW + Loro conflicts

## Context
Concurrent title/delete edits need deterministic winners; body needs causal merge.

## Decision
Per-field Lamport LWW for `title` and `deleted_at`; Loro CRDT for `body` (`body_doc` authoritative).

## Consequences
Lost LWW values are recorded in local `conflict_log` for UX restore. Body conflicts do not create log entries.
