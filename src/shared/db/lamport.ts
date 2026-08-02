let lamport = 0;

/** Monotonic Lamport clock for deterministic LWW across peers (Faza 2). */
export function nextLamport(remoteHint = 0): number {
  lamport = Math.max(lamport, remoteHint) + 1;
  return lamport;
}

export function peekLamport(): number {
  return lamport;
}

/** Test helper — do not use in app code. */
export function resetLamportForTests(value = 0): void {
  lamport = value;
}
