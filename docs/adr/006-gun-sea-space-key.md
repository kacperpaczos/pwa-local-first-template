# ADR-006: Gun transport + SEA space key trust

> **Partially superseded by [ADR-010](010-per-device-op-log.md).** Per-op attribution now comes from a real per-device ed25519 signature (`shared/identity/device.ts`), not the Gun SEA pair — every paired device still shares one SEA pair, but it is scoped down to what it always should have been: the Gun user-graph write ACL. The AES-GCM space key and pairing/recovery flows below are unchanged in kind (pairing payload bumped to v3, see ADR-010). The v2 "SEA encrypt remains fallback" behavior is gone: the transport now fails closed with no fallback cipher when the space key can't be loaded.

## Context
Original Faza 4 planned WS + Ed25519/AES. Project standardized on Gun+SEA instead.

## Decision
- Transport auth: Gun SEA pair, shared by every paired device (Gun user-graph write ACL only — not op attribution as of ADR-010).
- Op attribution: per-device ed25519 keypair, generated locally, never transferred by pairing.
- Content encryption: AES-256-GCM `spaceKey` (WebCrypto), sealed into pairing payload.
- Pairing: QR/JSON + 6-digit SAS — a transfer checksum only. The digits derive from sender-chosen inputs over a 10^6 space, so a payload forged by an attacker controlling the channel can be ground to match the genuine device's digits; the pairing channel itself is the trust boundary. An interactive SAS is a v0.2 item (see ADR-010's p2panda-auth mapping).
- Recovery: BIP39 12-word phrase wraps `spaceKey` (does not touch the SEA pair or device key).
- Gun peer is untrusted for note contents; op envelope metadata (`seq`, `hash`, `v`) remains visible for routing.

## Consequences
No return to WS relay for trust model. Production peer is still useful for mesh durability (Docker), not as SoT. Authorization (who may hold the space key) is still all-or-nothing — real per-device revocation is `p2panda-auth`'s job (ADR-010's v0.2 mapping), not solved here.
