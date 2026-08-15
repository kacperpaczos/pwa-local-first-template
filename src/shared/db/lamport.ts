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
 * local state on startup, so a fresh page load (before any remote mutation
 * bumps it via `nextLamport(remoteHint)`) can't hand out a value that
 * collides with one this device already assigned in a previous session.
 * Only raises the clock — never lowers it.
 */
export function seedLamportFromState(rows: Iterable<{ label_lamport: number }>): void {
  let max = 0;
  for (const row of rows) {
    if (row.label_lamport > max) max = row.label_lamport;
  }
  if (max > lamport) {
    lamport = max;
  }
}

/** Test helper — do not use in app code. */
export function resetLamportForTests(value = 0): void {
  lamport = value;
}
