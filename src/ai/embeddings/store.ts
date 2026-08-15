/**
 * Local-only embedding cache. Never synced via Gun / SyncMutation.
 * Prefers IndexedDB; falls back to an in-memory map + localStorage JSON.
 */

const DB_NAME = "pwa-ai-embeddings";
const DB_VERSION = 1;
const STORE_NAME = "vectors";
const LS_KEY = "pwa-ai-embeddings-v1";

export type StoredEmbedding = {
  /** `${noteId}:${bodyHash}` */
  key: string;
  noteId: string;
  bodyHash: string;
  modelId: string;
  dims: number;
  /** Packed float32 values */
  values: number[];
};

let memoryCache: Map<string, StoredEmbedding> | null = null;
let idb: IDBDatabase | null = null;
let idbFailed = false;

function storageKey(noteId: string, bodyHash: string): string {
  return `${noteId}:${bodyHash}`;
}

/** Fast non-crypto hash for cache invalidation when note body changes. */
export function hashBody(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function loadLocalStorageMap(): Map<string, StoredEmbedding> {
  if (memoryCache) return memoryCache;
  memoryCache = new Map();
  if (typeof localStorage === "undefined") return memoryCache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return memoryCache;
    const parsed = JSON.parse(raw) as StoredEmbedding[];
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry?.key) memoryCache.set(entry.key, entry);
      }
    }
  } catch {
    /* corrupt — start empty */
  }
  return memoryCache;
}

function persistLocalStorageMap(): void {
  if (!memoryCache || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...memoryCache.values()]));
  } catch {
    /* quota — keep in-memory only */
  }
}

function openIdb(): Promise<IDBDatabase | null> {
  if (idb) return Promise.resolve(idb);
  if (idbFailed || typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => {
        idbFailed = true;
        resolve(null);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      req.onsuccess = () => {
        idb = req.result;
        resolve(idb);
      };
    } catch {
      idbFailed = true;
      resolve(null);
    }
  });
}

export async function getStoredEmbedding(
  noteId: string,
  bodyHash: string,
): Promise<StoredEmbedding | null> {
  const key = storageKey(noteId, bodyHash);
  const db = await openIdb();
  if (db) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve((req.result as StoredEmbedding | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return loadLocalStorageMap().get(key) ?? null;
}

export async function putStoredEmbedding(entry: StoredEmbedding): Promise<void> {
  const db = await openIdb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
    return;
  }
  const map = loadLocalStorageMap();
  map.set(entry.key, entry);
  persistLocalStorageMap();
}

export async function clearEmbeddingStore(): Promise<void> {
  const db = await openIdb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  memoryCache = new Map();
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Test helper — drops in-memory / IDB handles between Vitest cases. */
export function resetEmbeddingStoreForTests(): void {
  memoryCache = null;
  if (idb) {
    try {
      idb.close();
    } catch {
      /* ignore */
    }
  }
  idb = null;
  idbFailed = false;
}

export { storageKey };
