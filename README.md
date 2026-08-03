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
| `pnpm test` / `pnpm test:unit` | Vitest (unit + integration Node) |
| `pnpm test:e2e` | Playwright (Chromium: smoke + sync) |
| `pnpm test:e2e:sync` | tylko project `chromium-sync` (serial + reset relay) |
| `pnpm test:all` | unit + e2e |

**CI lokalne / Definition of Done testów:** `pnpm typecheck && pnpm test:all` — wszystko green.

## Piramida testów

```text
Unit (Vitest / Node)     protocol, CRDT, merge-note, mutex, WsSyncTransport (fake WS),
                         apply-remote, facade (stuby), AI gate/status,
                         WebLLM provider (fake engine: download progress + stream),
                         AI session (download/inference state machine), RelayStore
Integration (Node)       RelayStore push/pull/idempotency (bez OPFS)
E2E (Playwright Chromium) smoke CRUD, offline→online→peer, multi-tab OPFS,
                         relay peers + soft-delete + idempotency, concurrent body merge,
                         AI panel hidden/available,
                         AI download + summarize via __createAiProvider mock (bez HF)
```

- **Chromium only** w CI — OPFS jest wymagane; Safari/WebKit nie są w scope.
- Project `chromium-smoke` — równoległy (nav, CRUD, AI bez GPU / ze stubem GPU / mock WebLLM).
- Project `chromium-sync` — `workers: 1`, `beforeEach` → `POST /test/reset` na relayu (`SYNC_RELAY_TEST_MODE=1`).
- Build e2e: `VITE_SYNC_WS_URL`, `VITE_AI_ENABLED=true`, `VITE_E2E=1` (ekspozycja `globalThis.__db` do merge body bez UI edycji).
- Helpery: `e2e/helpers.ts`.
- **WebLLM w CI:** prawdziwy download modelu / WebGPU inference **nie** jest odpalany — testy używają `globalThis.__createAiProvider` (e2e) oraz wstrzykiwanego `createEngine` (unit). Ręczny smoke z prawdziwym modelem: `VITE_AI_ENABLED=true` + WebGPU + przycisk „Pobierz model” (`VITE_AI_MODEL_ID`, domyślnie `SmolLM2-360M-Instruct-q4f16_1-MLC`).
- **Poza zakresem CI (dopisz przy 3.3–3.6):** embeddingi, RAG, pełny real-model e2e na GPU CI runnerze.

## Architektura

```text
src/
  app/                 # shell + routing
  features/notes/      # UI domeny
  features/ai/         # UI warstwy AI (Faza 3), warunkowe na stanie ai/
  shared/db/           # fasada zapisu, schemas Zod, UUIDv7, Lamport, sync_meta
  shared/sync/         # SyncTransport, WS adapter, LWW, mutex, protocol
  ai/                  # Faza 3 (WebLLM, lokalnie): flaga, detekcja WebGPU/storage, maszyna stanów
server/relay/          # append-only WebSocket relay (Phase 2)
```

- **SQLite/OPFS** = źródło prawdy (za `PersistenceFacade`).
- **Outbox** = `@tanstack/offline-transactions`.
- **`SyncTransport`** = `WsSyncTransport` (dev) lub `NoopSyncTransport` (gdy brak URL).
- **Konflikty notatek — hybrydowo, per pole** (`shared/sync/merge-note.ts`):
  - `title` i `deleted_at`: **LWW per-pole**, każde na własnym zegarze Lamporta (`title_lamport`, `deleted_lamport`) — edycja tytułu nie gubi współbieżnego usunięcia i odwrotnie.
  - `body`: **prawdziwy CRDT** (Loro `LoroText`, `shared/db/crdt.ts`) — współbieżne edycje tekstu scalają się po historii przyczynowej zamiast wybierać jednego „zwycięzcę" (patrz `merge-note.test.ts`).
- Walidacja wiadomości peer/relay: Zod (`shared/sync/protocol.ts`).
- Kursor sync: kolekcja `sync_meta`.
- Testy multi-tab: dwie karty w **tym samym** kontekście (wspólne OPFS) sprawdzają leader election `BrowserCollectionCoordinator` bez użycia relaya (`e2e/multi-tab.spec.ts`), osobno od testu dwóch peerów przez WS (`e2e/relay-peers.spec.ts`).

### Faza 3 — AI lokalnie (WebLLM)

- `src/ai/`: flaga `VITE_AI_ENABLED`, detekcja WebGPU, storage headroom, maszyna stanów, sesja download/inference (`session.ts`), adapter `WebLlmAiProvider` (`@mlc-ai/web-llm`, model `VITE_AI_MODEL_ID` / SmolLM2-360M).
- `initAiFeature()` rozstrzyga `unavailable` vs `available`; pobranie modelu i streszczenie startują z `AiPanel` (`Pobierz model` / `Streszcz`).
- Testy: unit ze stubem silnika; e2e ze stubem `navigator.gpu` + `globalThis.__createAiProvider` (bez pobierania wag z Hugging Face w CI).
- Embeddingi / RAG — kolejne etapy.

## Konfiguracja sync

```bash
# .env / CI
VITE_SYNC_WS_URL=ws://127.0.0.1:8787
```

W `import.meta.env.DEV` domyślnie używany jest `ws://127.0.0.1:8787`, jeśli zmienna jest pusta.

## Ryzyka i progi wymiany

- `@tanstack/browser-db-sqlite-persistence` jest młode — fasada umożliwia wymianę na RxDB / wa-sqlite.
- **Nie używamy** p2panda ani gun.js jako źródła prawdy / sync przeglądarkowego.
- PWA: baza OPFS nie jest precache’owana; `.wasm`/workery (w tym WASM Loro, ~3 MB) — `CacheFirst` w runtime, poza precache.
- **Gotcha w `@tanstack/browser-db-sqlite-persistence`:** gdy kilka kolekcji dzieli jeden `persistence`/`coordinator`, biblioteka cache'uje adapter per `(mode, schemaVersion)` i przy każdej nowej kolekcji nadpisuje aktywny adapter w koordynatorze (`coordinator.setAdapter`). Kolekcje o **różnych** `schemaVersion` na tym samym koordynatorze nadpisują sobie nawzajem aktywny adapter i psują wzajemnie walidację schematu (błąd `Schema version mismatch` w pętli retry). Dlatego `notes` i `sync_meta` w `shared/db/client.ts` muszą mieć **tę samą** wartość `schemaVersion` — patrz komentarz przy `sync_meta`.
