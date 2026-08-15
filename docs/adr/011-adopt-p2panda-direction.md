# ADR-011: Actively steer toward p2panda (thin client + relay path)

## Context

[ADR-010](010-per-device-op-log.md) rebuilt sync around per-device,
hash-linked, signed operation logs and framed p2panda as a *passive* future:
"replace homegrown pieces with p2panda crates once a stable browser binding
exists." That framing assumed the blocker was a build artifact — a wasm
build of the whole stack — and that until it appeared there was nothing to
do but wait.

Three things learned in August 2026 change that:

1. **The p2panda maintainers have described their intended web architecture**
   (in [p2panda/p2panda#1235](https://github.com/p2panda/p2panda/issues/1235)):
   not the full networking stack compiled to wasm, but a thin WASM/JS
   *client* that creates and signs operations in the browser, talking to a
   broker node ("proxy" with a static address) that moves end-to-end
   encrypted data it cannot read. The groundwork is
   [p2panda/p2panda#1126](https://github.com/p2panda/p2panda/issues/1126)
   (exposing the Publisher/Consumer internals of their high-level API).
   **This template already implements exactly that architecture** — browser
   signs and stores locally, a dumb relay (currently Gun) moves AES-GCM
   ciphertext — so the distance to their intended web story is much shorter
   than the distance to "p2panda-net in wasm".
2. **That upstream discussion is stalled** on an unresolved
   "broker vs. pure p2p" argument, with no browser application on either
   side of the table. This template is empirical evidence for the broker
   model being genuinely local-first (offline works fully; the relay is
   zero-knowledge), and its browser-specific findings (multi-tab writer
   locking, async read-after-write storage, batched range fetch) are design
   input p2panda does not currently have.
3. **An audit of this template's sync stack** (2026-08) found that
   effectively all of its bugs and its three known security holes live in
   precisely the code a p2panda adoption deletes — while the pieces that
   would remain (materializer, merge policy, facade, UI) were clean.

## Decision

The homegrown sync stack is no longer a destination; it is a **bridge**.
The project actively steers toward adopting p2panda crates piece by piece,
along the maintainers' own web path — thin browser client + broker — rather
than waiting for the full stack to compile to wasm.

Concretely:

- **Freeze homegrown expansion** where a p2panda crate is the designated
  replacement. No bespoke group/ACL system (`p2panda-auth`), no bespoke
  group encryption or key rotation (`p2panda-encryption` / `p2panda-spaces`),
  no bespoke log compaction (`p2panda-store`), no second homegrown transport.
  The affected BACKLOG items are labeled **frozen** with this ADR as the
  reason — see [BACKLOG](../BACKLOG.md).
- **Keep maintaining** everything the migration does not replace: the
  materializer and merge policy (LWW + Loro), the persistence facade, the
  UI, backup, AI — and correctness fixes to the existing stack that protect
  users today (they are bridge maintenance, not expansion).
- **Engage upstream** with a concrete gap list and an offer to serve as the
  browser reference application: [docs/p2panda-gaps.md](../p2panda-gaps.md),
  written to be linked directly into p2panda/p2panda#1235.
- **Alignment work on our side happens when it unblocks interop, not
  before** (unchanged from ADR-010's reasoning): header encoding and
  timestamp changes are worthless until there is a p2panda peer to talk to.

## Errata to ADR-010

ADR-010's v0.2 mapping table lists the known encoding delta as "canonical
JSON → CBOR/Postcard". Since p2panda v0.7.0 the wire encoding is
**Postcard** (CBOR was dropped). The delta is therefore: sorted-key JSON →
Postcard, ms → s timestamps, and the missing `previous` links. ADR-010 is
otherwise unchanged and its module→crate mapping remains the migration map.

## Consequences

- BACKLOG items §1 (pairing SAS), §2 (device revocation), §3 (forward
  secrecy), §12 (index scans), §13 (log compaction) are frozen; their fix
  arrives with the corresponding p2panda crate, not from us. The security
  caveats they represent stay documented and prominent until then.
- The template's public positioning changes from "p2panda comparison" to
  "p2panda on-ramp": a browser app whose data model is already log-shaped,
  whose transport seam (`LogSyncTransport`) is the intended cut point for a
  p2panda broker client, and whose test harness (virtual devices, contract
  suite) can exercise a future binding.
- Gun remains the interim relay. It is slow-maintained upstream but
  functional, and it sits behind the transport seam; replacing it with
  anything other than a p2panda broker would now be wasted motion.
- If upstream chooses a different web path than the one described in #1235,
  this ADR's *freeze* still stands (the crates replace the same modules
  either way); only the transport plan would need revisiting.
