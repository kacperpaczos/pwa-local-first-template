let lamport = 0;

/** Monotonic Lamport clock for deterministic LWW across peers. */
export function nextLamport(remoteHint = 0): number {
  lamport = Math.max(lamport, remoteHint) + 1;
  return lamport;
}

export function peekLamport(): number {
  return lamport;
}

/**
 * Seed the clock from the highest Lamport value already present in the
 * local notes on startup, so a fresh page load (before any remote mutation
 * bumps it via `nextLamport(remoteHint)`) can't hand out a value that
 * collides with one this device already assigned in a previous session.
 * Only raises the clock — never lowers it.
 */
export function seedLamportFromNotes(
  notes: Iterable<{ title_lamport: number; deleted_lamport: number }>,
): void {
  let max = 0;
  for (const note of notes) {
    if (note.title_lamport > max) max = note.title_lamport;
    if (note.deleted_lamport > max) max = note.deleted_lamport;
  }
  if (max > lamport) {
    lamport = max;
  }
}

/** Test helper — do not use in app code. */
export function resetLamportForTests(value = 0): void {
  lamport = value;
}
