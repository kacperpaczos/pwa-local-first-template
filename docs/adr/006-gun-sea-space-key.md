# ADR-006: Gun transport + SEA space key trust

## Context
Original Faza 4 planned WS + Ed25519/AES. Project standardized on Gun+SEA instead.

## Decision
- Device identity: Gun SEA pair.
- Content encryption: AES-256-GCM `spaceKey` (WebCrypto), sealed into pairing payload; SEA encrypt remains fallback for older peers.
- Pairing: QR/JSON + 6-digit SAS.
- Recovery: BIP39 12-word phrase wraps `spaceKey` (does not replace SEA device keys).
- Gun peer is untrusted for note contents; metadata (`seq`, `op`, `v`) may remain visible for routing.

## Consequences
No return to WS relay for trust model. Production peer is still useful for mesh durability (Docker), not as SoT.
