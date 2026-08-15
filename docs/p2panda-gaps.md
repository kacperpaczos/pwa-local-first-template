# Gaps between this template and p2panda

## 1. Purpose

A working gap list for the conversation in
[p2panda/p2panda#1235](https://github.com/p2panda/p2panda/issues/1235)
(plans for WebAssembly support) and
[p2panda/p2panda#1126](https://github.com/p2panda/p2panda/issues/1126)
(exposing the internals of the event streaming node API). The decision
context on our side is [ADR-011](adr/011-adopt-p2panda-direction.md); the
module-to-crate mapping is in [ADR-010](adr/010-per-device-op-log.md).

The document is written to be readable without reading our code.

## 2. What this template is, in p2panda terms

A browser-only local-first progressive web application (Chromium, Origin
Private File System) whose synchronization layer was deliberately built in
the shape of p2panda:

- **Per-device append-only logs.** Every device holds its own Ed25519 key,
  generated on first start and never transferred, and signs every
  operation. Operations are hash-linked (BLAKE3 backlinks, one-based
  sequence numbers per entity and device). Chain validation at ingest
  distinguishes the verdicts ok, gap, duplicate, and fork. Payload
  validation is separate: a payload the device cannot decode is
  quarantined individually without blocking the rest of the log.
- **Local-first storage.** Complete state lives in SQLite in the browser;
  the application is fully functional offline. The log doubles as the
  durable outgoing queue (a `published` flag), so a crash between a local
  write and its publication loses nothing.
- **A zero-knowledge relay.** The current transport (Gun, behind a
  replaceable `LogSyncTransport` interface) carries only AES-256-GCM
  ciphertext, bound through additional authenticated data to the signed
  operation header. The relay cannot read, forge, or selectively mutate
  content without detection. Synchronization is head announcement plus
  on-demand range fetch, not full-graph replay.

This matches the web architecture described by the maintainers in
issue 1235 — a thin signing client in the page, a broker in the middle,
end-to-end encryption throughout — implemented and running today, with an
end-to-end test suite (two browsers synchronizing through a real relay;
two tabs sharing one database) and a virtual-device integration harness.

It also answers the objection raised in that thread empirically: the
broker model did not compromise local-first operation. Data lives with the
user, offline operation requires no server, and the relay is a courier
that cannot open the envelopes.

## 3. Browser constraints observed in practice

Design input for a future WebAssembly client API, drawn from problems this
implementation actually encountered:

1. **Multiple tabs share one database.** A browser device is several tabs
   over one storage. Sequence numbering for the device's own log must be
   derived under a cross-tab exclusive lock (this implementation uses the
   Web Locks API plus a monotone cross-tab counter). A client API that
   assumes one instance per device will fork its own log in production.
2. **Browser storage confirms writes asynchronously.** A read issued
   immediately after a resolved write can miss the row. This
   implementation keeps its own in-memory read index, treats persistence
   as durability only, and states eventual read-after-write explicitly in
   its storage-port contract. The consequence for p2panda: storage traits
   should be implementable by the host (so a browser can back them with
   OPFS or IndexedDB) and must not assume synchronous read-after-write.
3. **Round trips dominate latency.** Fetching operation rows one at a time
   is the dominant synchronization cost here. The client-to-broker
   protocol should support batched range fetches as a first-class
   operation.
4. **Chain validation and payload validation need different failure
   modes.** Chain-invalid operations are dropped without touching the
   head; stored operations whose payload cannot be decoded are quarantined
   individually and surfaced in the UI. One malformed operation must never
   block the pipeline. This separation has worked well and is worth
   preserving in any client API.

## 4. Gaps on the p2panda side

1. **A thin browser client.** The Publisher and Consumer surface of
   issue 1126, exposed to WebAssembly: create and sign operation headers,
   verify and chain-validate incoming ones, and speak the
   client-to-broker protocol. Neither `p2panda-net` nor discovery nor
   gossip is required for the web use case.
2. **Binding technology.** `p2panda-ffi` uses UniFFI, which does not
   target the browser; the browser path is presumably `wasm-bindgen`, a
   separate artifact rather than an extension of the existing FFI. Which
   path do the maintainers prefer, and would a contribution starting with
   `p2panda-core` be welcome?
3. **Host-pluggable storage.** Can the `p2panda-store` traits be
   implemented from the host side, or is SQLite compiled in? Browser
   clients need the former.
4. **Batched range fetch** in the broker protocol (constraint 3 above).
5. **Multi-instance tolerance** over one store (constraint 1 above), or an
   explicit single-writer contract in which the host provides the lock;
   the Web Locks API can satisfy such a contract.
6. **Format stability guarantees before version 1.0.** Which parts of the
   operation header and the Postcard encoding are already frozen? Data
   written by early adopters needs a migration story, or at least a
   versioning commitment.

## 5. Gaps on our side

1. **Header encoding.** Sorted-key canonical JSON must become Postcard;
   timestamps must move from milliseconds to seconds; `previous` links for
   cross-log ordering must be added. Deferred until a p2panda peer exists
   to interoperate with ([ADR-010](adr/010-per-device-op-log.md), erratum
   in [ADR-011](adr/011-adopt-p2panda-direction.md)).
2. **Entity-generic materialization.** The wire protocol and payload
   registry are entity-agnostic, but the materializer is wired for one
   entity; adopting a stream-consumer API means finishing that
   generalization.
3. **Trust model replacement.** One shared space key today (all-or-nothing
   access, no revocation, no forward secrecy; documented rather than
   hidden) must become groups through `p2panda-auth` and
   `p2panda-encryption`. No bespoke access-control system was built here,
   precisely so that this replacement arrives unencumbered.
4. **Materialization model.** Payloads here are deltas, and state is a
   full recompute from the operation set (order-independent, idempotent).
   Adopting a stream-consumer API is a natural fit; richer conflict-free
   replicated data types, such as collaborative text, would return as a
   document-delta operation kind.

## 6. Offer of collaboration

- A browser reference application and test bed for the thin-client path:
  replacing the current relay with a p2panda broker is one module behind
  the transport interface, and the integration harness simulates
  multi-device convergence, restarts mid-synchronization, and
  acknowledgement coverage without a browser in the loop.
- Implementation experience for the client API design (section 3).
- A contribution starting with `p2panda-core` compiled to WebAssembly, if
  that path is welcome (section 4, item 2).

## Appendix: draft comment for p2panda/p2panda#1235

> Some empirical input for this thread — we have built and shipped a
> browser-only local-first template whose synchronization layer is
> deliberately p2panda-shaped, and it ended up being exactly the
> "thin client + broker" architecture @adzialocha describes above:
> https://github.com/kacperpaczos/pwa-local-first-template
>
> Browser side: per-device Ed25519 keys sign hash-linked, per-device
> append-only operation logs (BLAKE3 backlinks, one-based sequence
> numbers); everything is stored locally in SQLite/OPFS, and the
> application is fully functional offline. The broker (currently a Gun
> relay, behind a transport seam) only ever sees AES-GCM ciphertext bound
> via AAD to the signed header — a zero-knowledge pipe. Our architecture
> decision records keep a module-to-crate mapping toward an eventual
> p2panda migration:
> [ADR-010](https://github.com/kacperpaczos/pwa-local-first-template/blob/main/docs/adr/010-per-device-op-log.md),
> [ADR-011](https://github.com/kacperpaczos/pwa-local-first-template/blob/main/docs/adr/011-adopt-p2panda-direction.md).
>
> Two observations that might be useful here:
>
> 1. **The broker model does not compromise local-first operation in
>    practice.** Data lives in the browser, offline works with no server
>    at all, and the proxy cannot read anything. The tension in this
>    thread may therefore be smaller than it looks — a WebAssembly
>    *client* (create/sign/verify/store plus log-height synchronization
>    against a broker) serves the web use case fully; compiling
>    `p2panda-net` to WebAssembly is not required for it.
>
> 2. **Browser constraints a WebAssembly client API would need to
>    survive:** multiple tabs share one storage, so sequence-number
>    derivation needs cross-tab locking (we use the Web Locks API plus a
>    monotone counter — a client cannot assume one instance per device);
>    browser storage confirms writes asynchronously, so storage traits
>    should not assume synchronous read-after-write (host-pluggable
>    storage rather than compiled-in SQLite would let us back it with
>    OPFS); and the client-to-broker protocol benefits greatly from
>    batched range fetches — per-row round trips are our largest latency
>    cost today.
>
> If issue 1126 moves toward a wasm-bindgen client, we would gladly serve
> as a browser reference application and test bed — replacing our current
> relay with a p2panda broker is one module behind our transport
> interface, and we have a virtual-device integration harness to exercise
> it. A fuller gap list, in both directions, lives here:
> [docs/p2panda-gaps.md](https://github.com/kacperpaczos/pwa-local-first-template/blob/main/docs/p2panda-gaps.md).
