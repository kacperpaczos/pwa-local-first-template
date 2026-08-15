# What's between this template and p2panda

A working gap list for the conversation in
[p2panda/p2panda#1235](https://github.com/p2panda/p2panda/issues/1235)
(*Plans for WASM / WASI?*) and
[p2panda/p2panda#1126](https://github.com/p2panda/p2panda/issues/1126)
(*Expose "guts" of Event Streaming Node API*). Decision context on our side:
[ADR-011](adr/011-adopt-p2panda-direction.md); module→crate mapping:
[ADR-010](adr/010-per-device-op-log.md).

Written to be readable without reading our code.

---

## 1. What this template is, in p2panda terms

A browser-only (Chromium/OPFS) local-first PWA whose sync layer was
deliberately built p2panda-shaped:

- **Per-device append-only logs.** Every device holds its own ed25519 key
  (generated on first boot, never transferred — not even during pairing) and
  signs every operation. Operations are hash-linked (blake3 backlinks,
  1-based seq per `(entity, device)` log). Chain validation at ingest
  distinguishes ok / gap / duplicate / fork; payload validation is separate,
  and a payload the device cannot decode is quarantined per-op without
  blocking the rest of the log.
- **Local-first for real.** Full state lives in SQLite in the browser
  (OPFS); the app is 100% functional offline. The log doubles as the
  durable outbox (a `published` flag), so a crash between "written locally"
  and "sent" loses nothing.
- **A dumb, zero-knowledge relay.** The current transport (Gun, behind a
  swappable `LogSyncTransport` interface) only ever carries AES-256-GCM
  ciphertext, AAD-bound to the signed op header. The relay cannot read,
  forge, or selectively mutate content without detection. Sync is
  head-announcement + on-demand range fetch, not full-graph replay.

This is, as far as we can tell, exactly the web architecture described by
@adzialocha in #1235 — thin signing client in the page, broker in the
middle, E2EE throughout — running in production shape today, with e2e tests
(two browsers syncing through a real relay; two tabs sharing one database)
and a virtual-device integration harness.

It also answers the objection raised in that thread empirically: the broker
model did not compromise local-first. Data lives with the user, offline
works with no server, and the relay is a courier that cannot open the
envelopes.

## 2. Browser lessons we already paid for

Design input for a future wasm client API, from things that actually bit us:

1. **Multiple tabs share one database.** A browser "device" is N tabs over
   one storage. Sequence numbering for the device's own log must be derived
   under a cross-tab exclusive lock (we use the Web Locks API plus a
   monotone cross-tab counter); a client API that assumes one instance per
   device will fork its own log in the wild.
2. **Browser storage confirms writes asynchronously.** A read issued right
   after a resolved write can momentarily miss the row. Our store keeps its
   own in-memory read index and treats persistence as durability-only; our
   storage-port contract states *eventual* read-after-write explicitly.
   Takeaway: store traits should be host-implementable (so we can back them
   with OPFS/IndexedDB) and must not assume synchronous read-after-write.
3. **Round trips dominate.** Fetching op rows one-by-one is our #1 latency
   cost. The client↔broker protocol should support batched range fetches
   ("give me seq 4..19 of author X") as a first-class operation.
4. **Chain validation and payload validation want different failure modes.**
   Chain-invalid ops are dropped without touching the head; stored ops whose
   payload can't be decoded are quarantined individually and surfaced in the
   UI. One poison op must never wedge the pipeline. This split served us
   well and we'd advocate for it in any client API.

## 3. Gaps on the p2panda side (the asks)

1. **A thin browser client** — the #1126 Publisher/Consumer surface exposed
   to wasm: create + sign operation headers, verify + chain-validate
   incoming ones, and speak the client↔broker protocol. No `p2panda-net`,
   no discovery, no gossip needed for the web use case.
2. **Binding technology.** `p2panda-ffi` uses UniFFI, which does not target
   the browser; the browser path is presumably `wasm-bindgen`, i.e. a
   separate artifact rather than an extension of the existing FFI. Which
   path do the maintainers prefer, and would a contribution starting with
   `p2panda-core` be welcome?
3. **Host-pluggable storage.** Can `p2panda-store`'s traits be implemented
   from the host side (JS/OPFS), or is SQLite compiled in? Browser clients
   need the former.
4. **Batched range fetch** in the broker protocol (see lesson 3 above).
5. **Multi-instance tolerance** over one store (see lesson 1 above) — or an
   explicit "single writer, host provides the lock" contract we can satisfy
   with Web Locks.
6. **Format stability guarantees** pre-1.0: which parts of the operation
   header / Postcard encoding are already frozen? Data written by early
   adopters needs a migration story, or at least a versioning promise.

## 4. Gaps on our side (our work, tracked here)

1. **Header encoding**: sorted-key canonical JSON → Postcard; timestamps
   ms → s; add `previous` links for cross-log ordering. Deliberately
   deferred until there is a p2panda peer to interoperate with
   ([ADR-010](adr/010-per-device-op-log.md), errata in
   [ADR-011](adr/011-adopt-p2panda-direction.md)).
2. **Entity-generic materialization**: our wire protocol and payload
   registry are entity-agnostic, but the materializer (log → application
   rows) is wired for one entity; adopting a stream-consumer API means
   finishing that generalization.
3. **Trust model swap**: one shared space key today (all-or-nothing access,
   no revocation, no forward secrecy — documented, not hidden) → groups via
   `p2panda-auth` / `p2panda-encryption`. We deliberately did **not** build
   a bespoke ACL system so this swap arrives unencumbered.
4. **Materialization model**: our payloads are deltas and state is a full
   recompute from the op set (order-free, idempotent). Adopting a stream-
   consumer API is a natural fit; richer CRDT payloads (collaborative text)
   would return as a document-delta op kind.

## 5. What we offer

- A **browser reference application / test-bed** for the thin-client path:
  swapping our current relay for a p2panda broker is one module behind our
  transport interface, and our integration harness simulates multi-device
  convergence, restarts mid-sync, and GC acknowledgement coverage without a
  browser in the loop.
- Implementation experience for the client API design (section 2).
- A contribution starting at `p2panda-core`-to-wasm, if that path is
  welcome (ask 2).

---

## Appendix: draft comment for p2panda/p2panda#1235

> Some empirical input for this thread — we've built (and shipped) a
> browser-only local-first template whose sync layer is deliberately
> p2panda-shaped, and it ended up being exactly the "thin client + broker"
> architecture @adzialocha describes above:
> https://github.com/kacperpaczos/pwa-local-first-template
>
> Browser side: per-device ed25519 keys sign hash-linked, per-device
> append-only op logs (blake3 backlinks, 1-based seq); everything is stored
> locally in SQLite/OPFS, and the app is fully functional offline. The
> broker (currently a Gun relay, but it sits behind a transport seam) only
> ever sees AES-GCM ciphertext bound via AAD to the signed header — a dumb,
> zero-knowledge pipe. Our ADRs keep a module→crate mapping toward an
> eventual p2panda migration:
> [ADR-010](https://github.com/kacperpaczos/pwa-local-first-template/blob/main/docs/adr/010-per-device-op-log.md),
> [ADR-011](https://github.com/kacperpaczos/pwa-local-first-template/blob/main/docs/adr/011-adopt-p2panda-direction.md).
>
> Two observations that might be useful here:
>
> 1. **The broker model does not compromise local-first in practice.** Data
>    lives in the browser, offline works with no server at all, and the
>    proxy can't read anything. So the tension in this thread may be smaller
>    than it looks — a wasm *client* (create/sign/verify/store + log-height
>    sync against a broker) serves the web use case fully; compiling
>    `p2panda-net` to wasm isn't required for it.
>
> 2. **Browser constraints a wasm client API would need to survive:**
>    multiple tabs share one storage, so sequence-number derivation needs
>    cross-tab locking (we use Web Locks + a monotone counter — a client
>    can't assume one instance per device); browser storage confirms writes
>    asynchronously, so store traits shouldn't assume synchronous
>    read-after-write (host-pluggable storage rather than compiled-in SQLite
>    would let us back it with OPFS); and the client↔broker protocol really
>    wants batched range fetches — per-row round trips are our #1 latency
>    cost today.
>
> If #1126 moves toward a wasm-bindgen client, we'd gladly serve as a
> browser reference app / test-bed — swapping our current relay for a
> p2panda broker is one module behind our transport interface, and we have a
> virtual-device integration harness to exercise it. A fuller gap list
> (both directions) lives here:
> [docs/p2panda-gaps.md](https://github.com/kacperpaczos/pwa-local-first-template/blob/main/docs/p2panda-gaps.md).
