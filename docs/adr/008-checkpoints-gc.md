# ADR-008: Checkpoints and tombstone GC

> **Superseded by [ADR-010](010-per-device-op-log.md).** The "encrypted checkpoints" below shipped as unit-tested code (`checkpoint.ts`) with **zero call sites in the app** — this ADR and the README both claimed it as a working feature when it wasn't wired to anything. ADR-010 deleted that code rather than retrofit call sites to make the claim true after the fact; real log compaction is a `p2panda-store`-shaped v0.2 concern. The GC decision below is also superseded: retention-only GC could hard-delete a tombstone before any peer had seen it, then resurrect the note when that peer's pre-delete copy later synced in. ADR-010 replaces the gate with real ack-based coverage (`shared/sync/coverage.ts`) — retention remains a backstop for a peer that never returns, not the only condition.

## Context
Soft-deletes and histories grow; new devices should not replay forever.

## Decision
- Local GC hard-deletes tombstones older than 90 days, **and** only once every known peer has acked the deleting op (ADR-010).
- ~~Encrypted checkpoints (max 2) in localStorage; best-effort publish under Gun `user.get('checkpoints')`.~~ Not implemented — deleted as dead code in ADR-010.
- Gun peer radisk retention is not application SoT — document peer volume backups separately.

## Consequences
Long-offline devices may need resync from backup JSON, not infinite merge. Real log compaction (the checkpoint concept was reaching for) is deferred to the p2panda-store migration.
