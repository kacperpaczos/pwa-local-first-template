# ADR-012: Reset the demonstration domain to a counter

## Context

The template shipped with a product-sized demonstration: a notes
application with collaborative text (Loro), an optional on-device AI layer
(WebLLM: summarization, retrieval, agent), and a backup subsystem (JSON
merge-import, SQL dump, a recovery screen for corrupted databases). That
demonstration predates the clarification of the template's purpose. After
[ADR-011](011-adopt-p2panda-direction.md), the repository is a research
vehicle and an application template for browser local-first
synchronization, steering toward p2panda. Product features dilute that
purpose: they dominated the file count, the dependency weight, and the
reader's attention, while the part that matters — the synchronization
fabric — is identical regardless of domain.

## Decision

The demonstration domain becomes the smallest domain that still exercises
every layer: one shared counter with a label, presented as an input field
and a button.

- The **counter value** is a grow-only counter. The button appends an
  `increment` operation to the device's log; the value is the sum of all
  increment operations. Addition commutes, so concurrent clicks on any
  number of devices merge without conflict. This is the smallest
  demonstration of why an operation log is preferable to snapshot
  synchronization.
- The **label** is a last-writer-wins register ordered by a Lamport clock:
  the second primitive merge strategy, one field wide.

Removed outright (all recoverable from version control history):

- the AI layer (`src/ai`, `features/ai`, `@mlc-ai/web-llm`) — product
  logic, not template machinery;
- backup, export, and the corrupted-database recovery screen
  (`src/backup`) — built around the notes domain; the operation log itself
  is the durable record;
- the notes domain (`features/notes`), Loro (`loro-crdt`), and the note
  merge policy — the domain they served is gone; where collaborative text
  would return is described in [vision.md](../vision.md), section 6;
- `@tanstack/offline-transactions` — the log's `published` flag has been
  the actual outgoing queue since ADR-010; with delta operations the
  additional optimistic-write layer was not merely redundant but hazardous
  (see below). A UI write is now: append (durable), materialize (fold into
  state), publish (in the background).

The schema version increases to 4. Tables from the notes era are not read;
this is the same clean-break policy as ADR-010, with the same
justification: pre-1.0 software with no installed base to migrate.

## Findings recorded during implementation

Both findings are general local-first lessons rather than
counter-specific details.

1. **Delta operations force derived state.** The notes domain synchronized
   full-state payloads, so an optimistic local write later reconciled by
   an idempotent merge was safe. An `increment` delta is not idempotent:
   with several tabs over one database, an incremental fold can
   double-count or drop a delta under stale cross-tab reads. The
   materializer therefore performs a full recompute — state is a pure
   function of the operation set (a sum for the value, a last-writer-wins
   maximum for the label), which is order-independent and idempotent by
   construction. The state row is only ever derived from the log
   (operations append with `applied: false`), never written directly.
2. **Re-reads must never regress flags.** The materializer re-hydrates the
   operation index from persistence on each cycle in order to observe
   sibling tabs' appends, and persisted reads can lag the current tab's
   own writes. Flag merges are therefore monotonic (false to true only); a
   stale read had previously been able to return a just-published
   operation to the unpublished state between two cycles.

## Consequences

- The production build shrinks from approximately 9.4 MB to approximately
  3.4 MB of precached assets; the dependency list loses its three heaviest
  entries.
- The test suite shrinks (142 Vitest cases and 10 Playwright cases) while
  keeping every layer, and gains the two decisive synchronization cases:
  concurrent increments on two devices sum correctly, and increments from
  two tabs of one device sum correctly.
- The facade API is two calls, `increment` and `setLabel`. A bounded retry
  absorbs the cross-tab replication lag window (the typed
  `OwnLogLagError`).
- Tombstone garbage collection and its acknowledgement-coverage gate lost
  their subject, because nothing is deleted. The acknowledgement roster
  remains (device roster display and `isOpCovered`), and pruning remains a
  `p2panda-store` concern under the freeze of ADR-011.
- Backlog items concerning notes-era mechanics are closed as obsolete. The
  frozen security items (2.1 to 2.3) are unchanged: pairing and the space
  key work exactly as before.
