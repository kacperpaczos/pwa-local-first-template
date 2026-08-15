import { createEntityId } from "../db/ids";

export const CONFLICT_LOG_STORAGE_KEY = "pwa-conflict-log";
export const CONFLICT_LOG_MAX_ENTRIES = 200;
export const CONFLICT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ConflictField = "label";

export type ConflictEntry = {
  id: string;
  entityId: string;
  field: ConflictField;
  lostValue: string | null;
  lostLamport: number;
  wonValue: string | null;
  at: string;
};

export type RecordConflictInput = {
  entityId: string;
  field: ConflictField;
  lostValue: string | null;
  lostLamport: number;
  wonValue: string | null;
  at?: string;
};

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage && typeof storage.getItem === "function") return storage;
  } catch {
    /* no localStorage in this environment */
  }
  return undefined;
}

function canUseStorage(storage: Pick<Storage, "getItem"> | undefined): boolean {
  return typeof storage?.getItem === "function";
}

function readAll(storage: Pick<Storage, "getItem">): ConflictEntry[] {
  try {
    const raw = storage.getItem(CONFLICT_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is ConflictEntry =>
        !!row &&
        typeof row === "object" &&
        typeof (row as ConflictEntry).id === "string" &&
        typeof (row as ConflictEntry).entityId === "string" &&
        (row as ConflictEntry).field === "label" &&
        typeof (row as ConflictEntry).lostLamport === "number" &&
        typeof (row as ConflictEntry).at === "string",
    );
  } catch {
    return [];
  }
}

function writeAll(entries: ConflictEntry[], storage: Pick<Storage, "setItem">): void {
  storage.setItem(CONFLICT_LOG_STORAGE_KEY, JSON.stringify(entries));
}

function prune(entries: ConflictEntry[], nowMs: number): ConflictEntry[] {
  const cutoff = nowMs - CONFLICT_LOG_RETENTION_MS;
  return entries
    .filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t >= cutoff;
    })
    .slice(0, CONFLICT_LOG_MAX_ENTRIES);
}

/**
 * Append a conflict entry. No-ops when `localStorage` is unavailable
 * (Node unit tests without an injected storage).
 */
export function recordConflict(
  input: RecordConflictInput,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultStorage(),
): ConflictEntry | null {
  if (!canUseStorage(storage) || !storage) return null;

  const entry: ConflictEntry = {
    id: createEntityId(),
    entityId: input.entityId,
    field: input.field,
    lostValue: input.lostValue,
    lostLamport: input.lostLamport,
    wonValue: input.wonValue,
    at: input.at ?? new Date().toISOString(),
  };

  const next = prune([entry, ...readAll(storage)], Date.parse(entry.at) || Date.now());
  writeAll(next, storage);
  return entry;
}

export function listConflicts(
  options: { entityId?: string; now?: number | Date } = {},
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultStorage(),
): ConflictEntry[] {
  if (!canUseStorage(storage) || !storage) return [];
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : Date.now();
  let entries = prune(readAll(storage), nowMs);
  // Persist prune side-effect when setItem is available.
  if ("setItem" in storage && typeof storage.setItem === "function") {
    writeAll(entries, storage as Pick<Storage, "setItem">);
  }
  if (options.entityId) {
    entries = entries.filter((e) => e.entityId === options.entityId);
  }
  return entries;
}

export function clearOldConflicts(
  now: number | Date = Date.now(),
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultStorage(),
): number {
  if (!canUseStorage(storage) || !storage || typeof (storage as Storage).setItem !== "function") {
    return 0;
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const before = readAll(storage);
  const after = prune(before, nowMs);
  writeAll(after, storage as Pick<Storage, "setItem">);
  return before.length - after.length;
}

export function conflictsForEntity(
  entityId: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): ConflictEntry[] {
  return listConflicts({ entityId }, storage);
}
