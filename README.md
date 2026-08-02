# pwa-local-first-template

Local-first PWA: **Solid.js 1.9** + **Vite 8** + **TanStack DB** (SQLite/OPFS) + outbox + **WebSocket sync relay**.

## Start

```bash
pnpm install
pnpm dev
```

Uruchamia równolegle:
- aplikację: [http://localhost:3000](http://localhost:3000) (`/notes`)
- relay sync: `ws://127.0.0.1:8787`

## Skrypty

| Komenda | Opis |
| --- | --- |
| `pnpm dev` | relay + Vite |
| `pnpm dev:app` | tylko front |
| `pnpm dev:relay` | tylko WebSocket relay |
| `pnpm build` | build produkcyjny (+ service worker) |
| `pnpm preview` | podgląd builda |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest (unit) |
| `pnpm test:e2e` | Playwright (Chromium + relay) |

## Architektura

```text
src/
  app/                 # shell + routing
  features/notes/      # UI domeny
  shared/db/           # fasada zapisu, schemas Zod, UUIDv7, Lamport, sync_meta
  shared/sync/         # SyncTransport, WS adapter, LWW, mutex, protocol
server/relay/          # append-only WebSocket relay (Phase 2)
```

- **SQLite/OPFS** = źródło prawdy (za `PersistenceFacade`).
- **Outbox** = `@tanstack/offline-transactions`.
- **`SyncTransport`** = `WsSyncTransport` (dev) lub `NoopSyncTransport` (gdy brak URL).
- Konflikty notatek: **LWW** po `lamport`, potem `updated_at`.
- Walidacja wiadomości peer/relay: Zod (`shared/sync/protocol.ts`).
- Kursor sync: kolekcja `sync_meta`.

## Konfiguracja sync

```bash
# .env / CI
VITE_SYNC_WS_URL=ws://127.0.0.1:8787
```

W `import.meta.env.DEV` domyślnie używany jest `ws://127.0.0.1:8787`, jeśli zmienna jest pusta.

## Ryzyka i progi wymiany

- `@tanstack/browser-db-sqlite-persistence` jest młode — fasada umożliwia wymianę na RxDB / wa-sqlite.
- **Nie używamy** p2panda ani gun.js jako źródła prawdy / sync przeglądarkowego.
- CRDT (Automerge/Loro) dopiero gdy LWW przestanie wystarczać dla współbieżnego tekstu/list.
- PWA: baza OPFS nie jest precache’owana; `.wasm`/workery — `CacheFirst` w runtime.
