# ADR-008: Checkpoints and tombstone GC

## Context
Soft-deletes and histories grow; new devices should not replay forever.

## Decision
- Local GC hard-deletes tombstones older than 90 days.
- Encrypted checkpoints (max 2) in localStorage; best-effort publish under Gun `user.get('checkpoints')`.
- Gun peer radisk retention is not application SoT — document peer volume backups separately.

## Consequences
Long-offline devices may need resync from checkpoint + backup JSON, not infinite merge.
