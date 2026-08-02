# pwa-local-first-template

Local-first PWA: **Solid.js 1.9** + **Vite 8** + **TanStack DB** (SQLite/OPFS) + outbox + czysty CSS.

## Start

```bash
pnpm install
pnpm dev
```

Aplikacja: [http://localhost:3000](http://localhost:3000) · notatki: `/notes`

## Skrypty

| Komenda | Opis |
| --- | --- |
| `pnpm dev` | serwer deweloperski |
| `pnpm build` | build produkcyjny (+ service worker) |
| `pnpm preview` | podgląd builda |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest (unit) |
| `pnpm test:e2e` | Playwright (Chromium) |

## Architektura (Faza 1)

```text
src/
  app/                 # shell + routing
  features/notes/      # UI domeny
  shared/db/           # fasada zapisu, schemas Zod, UUIDv7, Lamport
  shared/sync/         # SyncTransport + Noop + mutex
```

- **SQLite/OPFS** przez `@tanstack/browser-db-sqlite-persistence` (za fasadą).
- **Outbox** przez `@tanstack/offline-transactions` (nawet bez realnego syncu).
- **`SyncTransport`** — wymienny adapter; teraz `NoopSyncTransport`.
- Mutacje UI tylko przez `PersistenceFacade` (soft-delete, `updated_at`, `lamport`).

## Ryzyka i progi wymiany

- Warstwa `@tanstack/browser-db-sqlite-persistence` jest młoda — wszystkie zapisy idą przez fasadę, żeby dało się wymienić na RxDB / bezpośrednie wa-sqlite bez przepisywania UI.
- **Nie używamy** p2panda ani gun.js jako źródła prawdy / sync przeglądarkowego (sierpień 2026).
- Multi-tab OPFS: coordinator jest włączony, ale pełne scenariusze e2e multi-tab zostawiamy na Fazę 2.
- PWA: baza OPFS nie jest precache’owana; `.wasm`/workery — `CacheFirst` w runtime.

## Faza 2 (poza zakresem tej bazy)

Własny relay WebSocket lub `automerge-repo` / Loro dla scalanych struktur; walidacja Zod wiadomości peerów już ma placeholder (`syncMutationMessageSchema`).
