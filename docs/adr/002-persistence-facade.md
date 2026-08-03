# ADR-002: TanStack persistence behind a facade

## Context
`@tanstack/browser-db-sqlite-persistence` is early and may need replacement (RxDB / direct wa-sqlite).

## Decision
All mutations go through `PersistenceFacade`; UI never touches collections for writes.

## Consequences
Swap cost is bounded to `client.ts` + facade. Live queries may still bind to collections.
