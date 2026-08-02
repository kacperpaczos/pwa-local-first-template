import type { Note } from "../db/schemas";

/**
 * Row-level LWW using Lamport clock, then updated_at as tie-breaker.
 * Schema has a single lamport per row (practical LWW for Phase 2 notes).
 */
export function resolveNoteLww(local: Note, remote: Note): Note {
  if (remote.lamport > local.lamport) return remote;
  if (remote.lamport < local.lamport) return local;
  return remote.updated_at >= local.updated_at ? remote : local;
}

export function shouldApplyRemote(local: Note | undefined, remote: Note): boolean {
  if (!local) return true;
  const winner = resolveNoteLww(local, remote);
  return winner === remote;
}
