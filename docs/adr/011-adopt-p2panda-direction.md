# ADR-011: Actively steer toward p2panda (thin client and broker path)

## Context

[ADR-010](010-per-device-op-log.md) rebuilt synchronization around
per-device, hash-linked, signed operation logs and framed p2panda as a
passive future: replace the in-repository pieces with p2panda crates once a
stable browser binding exists. That framing assumed the blocker was a build
artifact — a WebAssembly build of the whole stack — and that nothing could
be done until it appeared.

Three findings from August 2026 change that assessment:

1. **The p2panda maintainers have described their intended web
   architecture** in
   [p2panda/p2panda#1235](https://github.com/p2panda/p2panda/issues/1235):
   not the full networking stack compiled to WebAssembly, but a thin
   WebAssembly or JavaScript client that creates and signs operations in
   the browser, communicating with a broker node that moves end-to-end
   encrypted data it cannot read. The groundwork is
   [p2panda/p2panda#1126](https://github.com/p2panda/p2panda/issues/1126),
   which proposes exposing the Publisher and Consumer internals of their
   high-level API. This template already implements that architecture —
   the browser signs and stores locally, and a relay (currently Gun)
   moves AES-GCM ciphertext — so the distance to the maintainers' intended
   web design is much shorter than the distance to compiling `p2panda-net`
   for the browser.
2. **The upstream discussion is stalled** on an unresolved disagreement
   about broker-based versus purely peer-to-peer designs, with no browser
   application on either side of the argument. This template is empirical
   evidence that the broker model preserves local-first properties
   (offline operation is complete; the relay is zero-knowledge), and its
   browser-specific findings — multi-tab writer locking, asynchronous
   read-after-write storage, batched range fetching — are design input
   p2panda does not currently have.
3. **An audit of this template's synchronization stack** (August 2026)
   found that all of its defects and its three known security gaps are
   located in exactly the code that a p2panda adoption would remove, while
   the parts that would remain (materializer, merge policy, facade, UI)
   were sound.

## Decision

The in-repository synchronization stack is no longer a destination; it is
a bridge. The project actively steers toward adopting p2panda crates piece
by piece, along the maintainers' web path — thin browser client plus
broker — rather than waiting for the full stack to compile to WebAssembly.

Specifically:

- **Freeze in-repository expansion** wherever a p2panda crate is the
  designated replacement: no bespoke group or access-control system
  (`p2panda-auth`), no bespoke group encryption or key rotation
  (`p2panda-encryption`, `p2panda-spaces`), no bespoke log compaction
  (`p2panda-store`), and no second in-repository transport. The affected
  backlog items are labelled frozen with this record as the reason; see
  [BACKLOG](../BACKLOG.md).
- **Continue maintaining** everything the migration does not replace: the
  materializer and merge policy, the persistence facade, the UI — and
  correctness fixes to the existing stack that protect users today, which
  count as bridge maintenance rather than expansion.
- **Engage upstream** with a concrete gap list and an offer to serve as
  the browser reference application:
  [docs/p2panda-gaps.md](../p2panda-gaps.md), written to be linked
  directly into issue 1235.
- **Perform alignment work on our side only when it unblocks
  interoperability** (unchanged from the reasoning of ADR-010): header
  encoding and timestamp changes have no value until a p2panda peer exists
  to communicate with.

## Erratum to ADR-010

The mapping table in ADR-010 lists the known encoding difference as
"canonical JSON to CBOR/Postcard". Since p2panda version 0.7.0 the wire
encoding is Postcard; CBOR was dropped. The difference is therefore:
sorted-key JSON to Postcard, milliseconds to seconds for timestamps, and
the missing `previous` links. ADR-010 is otherwise unchanged, and its
module-to-crate mapping remains the migration map.

## Consequences

- Backlog items 2.1 (pairing checksum), 2.2 (device revocation), 2.3
  (forward secrecy), 5.1 (index scans), and 5.2 (log compaction) are
  frozen; their fixes arrive with the corresponding p2panda crates. The
  security caveats they represent stay documented and visible until then.
- The template's public positioning changes from a comparison with p2panda
  to an on-ramp toward it: a browser application whose data model is
  already log-shaped, whose transport seam (`LogSyncTransport`) is the
  intended cut point for a p2panda broker client, and whose test harness
  (virtual devices, contract suite) can exercise a future binding.
- Gun remains the interim relay. Its upstream maintenance is slow but the
  library is functional, and it sits behind the transport seam; replacing
  it with anything other than a p2panda broker would be wasted effort.
- If upstream chooses a web path different from the one described in
  issue 1235, the freeze in this record still stands — the crates replace
  the same modules either way; only the transport plan would need
  revisiting.
