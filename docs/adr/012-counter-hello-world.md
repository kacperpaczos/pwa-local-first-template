# ADR-012: Reset the demo domain to a counter hello-world

## Context

The template shipped with a product-sized demo: a notes app (CRDT text
bodies via Loro), an optional on-device AI layer (WebLLM: summarize, RAG,
agent), and a backup subsystem (JSON merge-import, SQL dump, corrupt-DB
recovery screen). That demo predated the template's actual purpose becoming
clear — after [ADR-011](011-adopt-p2panda-direction.md) the repo is a
**research vehicle and application template** for browser local-first sync,
steering toward p2panda. Product features dilute that: they dominate the
file count, the dependency weight, and the reader's attention, while the
part that matters — the sync fabric — is the same regardless of domain.

## Decision

The demo domain becomes the smallest thing that still exercises every layer:
**one shared counter with a label** (an input and a button).

- The **counter value** is a grow-only counter: the button appends an
  `increment` op to the device's log; the value is the sum of all increment
  ops. Addition commutes, so concurrent clicks on any number of devices
  merge without conflict — the smallest honest demonstration of why an
  op log beats snapshot sync.
- The **label** is a last-writer-wins register on a Lamport clock: the other
  canonical merge strategy, one field wide.

Removed outright (all recoverable from git history):

- the AI layer (`src/ai`, `features/ai`, `@mlc-ai/web-llm`) — product logic;
- backup/export and the corrupt-DB recovery screen (`src/backup`) — built
  around notes; the op log itself is the durable record;
- notes (`features/notes`), Loro (`loro-crdt`) and the note merge policy —
  the domain they served is gone; where CRDT text would slot back in is
  documented in [vision.md](../vision.md);
- `@tanstack/offline-transactions` — the log's `published` flag has been the
  real outbox since ADR-010; with delta ops the extra optimistic-write layer
  was not just redundant but hazardous (see below). A UI write is now:
  append (durable) → materialize (fold into state) → publish (background).

`schemaVersion` bumps to 4; notes-era tables are not read (same clean-break
policy as ADR-010, and the same justification: pre-1.0 software, no install
base to migrate).

## Two consequences discovered while building it

Both are recorded because they are general local-first lessons, not
counter-specific trivia:

1. **Delta ops force derived state.** Notes synced full-state payloads, so
   an optimistic local write later reconciled by an idempotent merge was
   safe. An `increment` delta is not idempotent: with several tabs over one
   database, an incremental fold can double-count or drop a delta under
   stale cross-tab reads. The materializer therefore does a **full
   recompute** — state is a pure function of the op set (sum for value,
   max-lamport for label), which is order-free and idempotent by
   construction. The state row is only ever *derived* from the log
   (`applied: false` on append), never written directly.
2. **Re-reads must never regress flags.** The materializer re-hydrates the
   op index from persistence each cycle (to see sibling tabs' appends), and
   persisted reads can lag this tab's own writes. Flag merges are therefore
   monotonic (false → true only) — a stale read had been able to flip a
   just-published op back to unpublished between two cycles.

## Consequences

- The build drops from ~9.4 MB to ~3.4 MB of precached assets; the
  dependency list shrinks by the three heaviest entries.
- The test suite shrinks (142 Vitest + 10 Playwright) but keeps every layer
  and gains the two definitive sync tests: *concurrent increments on two
  devices sum* and *increments from two tabs of one device sum*.
- Facade API is two calls (`increment`, `setLabel`); a bounded retry absorbs
  the cross-tab replication lag window (`OwnLogLagError`).
- Tombstone GC and its ack-coverage gate lost their subject (nothing is
  deleted); the ack roster stays (device roster + `isOpCovered`), and
  pruning remains a `p2panda-store` concern per ADR-011's freeze.
- BACKLOG items about notes-era mechanics are closed as moot; the frozen
  security items (§1–§3) are unchanged — pairing and the space key work
  exactly as before.
