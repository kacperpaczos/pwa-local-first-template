import type { Collection } from "@tanstack/db";
import type { Note } from "../db/schemas";
import { noteSchema } from "../db/schemas";
import { open, seal, type SealedBlob } from "@/shared/crypto/envelope";

export const CHECKPOINT_STORAGE_KEY = "pwa-checkpoints";
export const CHECKPOINT_MAX_STORED = 2;
export const CHECKPOINT_AAD = "pwa-lf-checkpoint-v1";

export type Checkpoint = {
  seqCovered: number;
  exportedAt: string;
  notes: Note[];
};

export type StoredCheckpoint = {
  exportedAt: string;
  seqCovered: number;
  sealed: SealedBlob;
};

function maxNoteLamport(notes: readonly Note[]): number {
  let max = 0;
  for (const note of notes) {
    max = Math.max(max, note.title_lamport, note.deleted_lamport);
  }
  return max;
}

function asNoteArray(notes: Collection<Note, string> | readonly Note[]): Note[] {
  const rows = Array.isArray(notes) ? notes : (notes as Collection<Note, string>).toArray;
  return rows.map((note) => noteSchema.parse(note));
}

/**
 * Build a checkpoint snapshot. `seqCovered` is the max Lamport clock across
 * all local notes — the transport's sync cursor lives in a separate,
 * per-origin numbering (see GunSyncTransport) and is not comparable to note
 * Lamport clocks, so it deliberately does not feed into this value.
 */
export function buildCheckpoint(
  notes: Collection<Note, string> | readonly Note[],
  options: { now?: Date } = {},
): Checkpoint {
  const parsed = asNoteArray(notes);
  const seqCovered = maxNoteLamport(parsed);
  return {
    seqCovered,
    exportedAt: (options.now ?? new Date()).toISOString(),
    notes: parsed,
  };
}

export async function sealCheckpoint(
  checkpoint: Checkpoint,
  spaceKey: CryptoKey,
): Promise<SealedBlob> {
  const plaintext = new TextEncoder().encode(JSON.stringify(checkpoint));
  return seal(plaintext, spaceKey, CHECKPOINT_AAD);
}

export async function openCheckpoint(sealed: SealedBlob, spaceKey: CryptoKey): Promise<Checkpoint> {
  const opened = await open(sealed, spaceKey, CHECKPOINT_AAD);
  const raw = JSON.parse(new TextDecoder().decode(opened)) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid checkpoint payload");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.seqCovered !== "number" || typeof obj.exportedAt !== "string") {
    throw new Error("Invalid checkpoint metadata");
  }
  if (!Array.isArray(obj.notes)) {
    throw new Error("Invalid checkpoint notes");
  }
  return {
    seqCovered: obj.seqCovered,
    exportedAt: obj.exportedAt,
    notes: obj.notes.map((n) => noteSchema.parse(n)),
  };
}

function readStored(storage: Pick<Storage, "getItem">): StoredCheckpoint[] {
  try {
    const raw = storage.getItem(CHECKPOINT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is StoredCheckpoint =>
        !!row &&
        typeof row === "object" &&
        typeof (row as StoredCheckpoint).exportedAt === "string" &&
        typeof (row as StoredCheckpoint).seqCovered === "number" &&
        !!(row as StoredCheckpoint).sealed &&
        typeof (row as StoredCheckpoint).sealed.nonce === "string" &&
        typeof (row as StoredCheckpoint).sealed.ciphertext === "string",
    );
  } catch {
    return [];
  }
}

/** Persist a sealed checkpoint locally (keep at most {@link CHECKPOINT_MAX_STORED}). */
export function storeCheckpointLocal(
  sealed: SealedBlob,
  meta: { exportedAt: string; seqCovered: number },
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = defaultCheckpointStorage(),
): StoredCheckpoint[] {
  if (!storage || typeof storage.getItem !== "function") return [];
  const next: StoredCheckpoint[] = [
    { exportedAt: meta.exportedAt, seqCovered: meta.seqCovered, sealed },
    ...readStored(storage),
  ].slice(0, CHECKPOINT_MAX_STORED);
  storage.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function listLocalCheckpoints(
  storage: Pick<Storage, "getItem"> | undefined = defaultCheckpointStorage(),
): StoredCheckpoint[] {
  if (!storage || typeof storage.getItem !== "function") return [];
  return readStored(storage);
}

function defaultCheckpointStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage && typeof storage.getItem === "function") return storage;
  } catch {
    /* no localStorage */
  }
  return undefined;
}

export type GunCheckpointPublisher = {
  /** Best-effort put under `user.get('checkpoints')`. */
  publishCheckpoint?: (payload: {
    exportedAt: string;
    seqCovered: number;
    sealed: SealedBlob;
  }) => Promise<void>;
  /** Optional Gun user chain with `.get('checkpoints').put(...)`. */
  user?: {
    get: (key: string) => {
      put: (data: unknown, cb?: (ack: unknown) => void) => unknown;
    };
  };
};

/**
 * Best-effort publish of a sealed checkpoint to the Gun user graph under
 * `user.get('checkpoints')`. Local storage remains the reliable home for the
 * last two checkpoints; Gun publish is opportunistic and may fail silently
 * when no user/publisher is available.
 */
export async function publishCheckpointToGun(
  sealed: SealedBlob,
  meta: { exportedAt: string; seqCovered: number },
  transport: GunCheckpointPublisher | null | undefined,
): Promise<boolean> {
  if (!transport) return false;

  if (typeof transport.publishCheckpoint === "function") {
    try {
      await transport.publishCheckpoint({ ...meta, sealed });
      return true;
    } catch {
      return false;
    }
  }

  const user = transport.user;
  if (!user || typeof user.get !== "function") return false;

  const payload = {
    exportedAt: meta.exportedAt,
    seqCovered: meta.seqCovered,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    at: Date.now(),
  };

  try {
    await new Promise<void>((resolve, reject) => {
      user.get("checkpoints").put(payload, (ack) => {
        const err = (ack as { err?: string } | null)?.err;
        if (err) {
          reject(new Error(String(err)));
          return;
        }
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}
