# pwa-local-first-template

A research template for local-first, multi-device web applications that run
entirely in the browser, with no backend service owning the data. The
demonstration domain is intentionally minimal — a single shared counter with
a text label — so that everything else in the repository constitutes the
reusable template.

This file is an overview. The foundational document, including definitions,
the protocol, and the migration path, is [docs/vision.md](docs/vision.md).

## 1. Principles

The template implements four verifiable commitments, stated in full in
[vision.md, section 2](docs/vision.md#2-definitions-and-commitments):

1. The user's device holds the source of truth. Complete application state
   is stored in SQLite inside the browser (Origin Private File System). No
   server holds the data, therefore no server can lose or withhold it.
2. Offline operation is not a degraded mode. Every feature works without
   network connectivity; synchronization is a background process that
   catches up when connectivity returns.
3. Writes are durable before they are shared. Every change is appended to a
   signed, hash-linked, per-device operation log before any network
   activity. The log also serves as the outgoing queue.
4. Concurrent edits merge deterministically. Application state is
   recomputed as a pure function of the operation set: counter increments
   are summed (a grow-only counter), and the label is resolved by
   last-writer-wins ordering on a Lamport clock.

Peer-to-peer operation in a browser is a constrained claim, and the
constraint is stated explicitly: a browser tab cannot accept inbound
connections, so devices exchange end-to-end encrypted operations through a
relay that cannot read, forge, or selectively alter them. The relay is a
courier, not a participant.

## 2. Status and direction

The current state is the counter demonstration running on the complete
synchronization stack: per-device operation logs, log-height synchronization
over a Gun relay, device pairing by QR code with per-device Ed25519 signing
keys, and BIP39 recovery. The behaviour is verified by four Vitest layers
and a Playwright end-to-end suite, including the two decisive cases:
concurrent increments on two devices sum correctly, and increments from two
tabs of one device sum correctly.

The direction, decided in
[ADR-011](docs/adr/011-adopt-p2panda-direction.md), is adoption of
[p2panda](https://p2panda.org/). The in-repository synchronization stack is
a bridge, not a destination. The chosen path is the one the p2panda
maintainers describe for the web — a thin signing client in the browser
plus a broker node — which matches the architecture this template already
implements. Work that a p2panda crate would replace is frozen (see the
labels in [docs/BACKLOG.md](docs/BACKLOG.md)); the list of gaps on both
sides is maintained in [docs/p2panda-gaps.md](docs/p2panda-gaps.md), with
reference to the upstream discussions
[p2panda#1235](https://github.com/p2panda/p2panda/issues/1235) and
[p2panda#1126](https://github.com/p2panda/p2panda/issues/1126).

The staged path from an empty page to p2panda, with the reasoning behind
each stage, is described in
[vision.md, section 8](docs/vision.md#8-migration-path-to-p2panda).

## 3. Getting started

```bash
pnpm install
pnpm dev
```

| Process | Address | Role |
| --- | --- | --- |
| Application | http://localhost:3000 | counter and settings pages |
| Gun relay | http://127.0.0.1:8765/gun | relay for encrypted operations |

Open the application and increment the counter. To exercise
synchronization, open the Settings page, pair a second browser profile (by
QR code or by copying the pairing payload), and observe that increments
performed on both sides are added together rather than conflicting.

Browser support: Chromium only, because the Origin Private File System is
required. Safari and Firefox are out of scope at present.

## 4. Repository layout

```text
src/
  app/                 Application shell and routing
  features/counter/    Demonstration domain (input field and increment button)
  features/settings/   Pairing, device roster, recovery, appearance, storage
  shared/db/           Schemas, write facade, database wiring, Lamport clock
  shared/oplog/        Operation header (Ed25519, BLAKE3), payload registry, chain rules
  shared/store/        Operation log store, persistence port and implementations, materializer
  shared/sync/         Transport interface, Gun adapter, synchronization engine, wire protocol
  shared/identity/     Relay credentials, device signing key, space key, pairing, recovery
  testing/harness/     Virtual devices and in-memory hub for the test layers
server/gun-peer/       The relay process (Docker-ready, no application logic)
e2e/                   Playwright specifications and helpers
docs/                  Vision, architecture, decision records, backlog
```

Common modification points:

| Goal | Location |
| --- | --- |
| Replace the demonstration domain with a product domain | the four files listed in [vision.md, section 6](docs/vision.md#6-domain-and-template-boundary) |
| Change merge rules | `src/shared/store/materialize.ts` |
| Change the operation header or signing scheme | `src/shared/oplog/header.ts` |
| Replace the transport | implement `LogSyncTransport` in `src/shared/sync/` |
| Change identity, pairing, or device keys | `src/shared/identity/` |

## 5. Configuration

```bash
VITE_GUN_PEERS=http://127.0.0.1:8765/gun  # empty value disables networking (offline-only transport)
VITE_E2E=1                                # test hooks; never set in production
GUN_PEER_PORT, E2E_WEB_PORT               # test-run ports; free ports are chosen automatically when taken
```

In development builds, an empty `VITE_GUN_PEERS` falls back to
`http://127.0.0.1:8765/gun`.

## 6. Development commands and verification

| Command | Purpose |
| --- | --- |
| `pnpm dev` | run the relay and the application |
| `pnpm build`, `pnpm preview` | production build with service worker; preview of that build |
| `pnpm typecheck`, `pnpm lint` | TypeScript check; Biome lint and format check |
| `pnpm test` | all four Vitest layers |
| `pnpm test:unit`, `test:contract`, `test:integration`, `test:dom` | a single Vitest layer |
| `pnpm test:e2e` | Playwright suite; ports are selected automatically |
| `pnpm test:all` | every Vitest layer followed by the Playwright suite |

The definition of done is that `pnpm lint && pnpm typecheck && pnpm
test:all` passes. Continuous integration runs the same commands
(`.github/workflows/ci.yml`), plus a weekly scheduled run against dependency
drift. The test-layer table — which parts are real and which are substituted
per layer — is in
[architecture.md, section 5](docs/architecture.md#5-test-layers).

## 7. Known limitations

- The six-digit pairing code is a transfer checksum, not authentication. An
  attacker able to rewrite the pairing channel can forge a payload that
  displays the same digits; `pairing.test.ts` demonstrates the attack. Pair
  only over a channel the attacker cannot rewrite. Under
  [ADR-011](docs/adr/011-adopt-p2panda-direction.md), an in-repository fix
  is intentionally not planned: the replacement is `p2panda-auth`.
- The shared space key has no revocation and no forward secrecy. Any party
  that ever held the key can decrypt the entire history. Pairing should not
  be treated as reversible.
- The pairing payload contains private key material (the relay credential
  pair and the space key) and must be handled like a password. Device
  signing keys are never transferred.
- `@tanstack/browser-db-sqlite-persistence` is a pre-1.0 dependency and
  confirms writes asynchronously. The operation log store keeps its own
  read index with monotonic flag merges for this reason; see
  [ADR-010](docs/adr/010-per-device-op-log.md) and
  [ADR-012](docs/adr/012-counter-hello-world.md).
- Gun is a transport only. The relay graph is never the source of truth.
- Schema version 4 is a clean break: data written by builds preceding the
  counter domain (ADR-012) is not read.

## 8. Related documents

- [docs/vision.md](docs/vision.md) — definitions, architecture
  cross-section, responsibilities, protocol, dependencies, migration path
- [docs/architecture.md](docs/architecture.md) — layer diagram, replacement
  points, test layers, invariants
- [docs/adr/](docs/adr/) — decision records, numbered chronologically
- [docs/BACKLOG.md](docs/BACKLOG.md) — open work, labelled by fate
- [docs/p2panda-gaps.md](docs/p2panda-gaps.md) — the gap list for the
  upstream conversation
