import * as z from "zod/mini";

/**
 * Upper bound for any Lamport counter arriving from a peer.
 *
 * The clock is a plain JS number, so a value at or above 2^53 makes
 * `Math.max(clock, hint) + 1 === clock` — the clock freezes, every later
 * local edit gets an identical value, and LWW silently degenerates to the
 * tie-break comparison. A single signed op carrying a huge counter would
 * poison this device permanently (the value gets written into the state row
 * and re-seeded from it on every boot), so the bound is enforced at the
 * parse boundary rather than trusted. It sits far above any reachable edit
 * count.
 */
export const MAX_LAMPORT = 2 ** 40;

/** Bound for a single increment and for the total — see MAX_LAMPORT's rationale. */
export const MAX_COUNTER = 2 ** 40;

const lamportSchema = z.number().check(z.int(), z.gte(0), z.lte(MAX_LAMPORT));

/**
 * The demo domain: ONE shared counter with a label.
 *
 * - `value` is a grow-only counter (G-counter): it is never written directly,
 *   only derived by folding `increment` ops from every device's log. Addition
 *   commutes, so concurrent increments merge without conflict — two devices
 *   clicking "+1" at the same time yields +2 everywhere.
 * - `label` is a plain last-writer-wins register ordered by a Lamport clock:
 *   concurrent edits keep exactly one value, deterministically, on every
 *   device (the losing value is recorded in the local conflict history).
 *
 * That is the whole domain on purpose — one field per merge strategy the
 * template demonstrates. Everything else in the repo is template machinery.
 */
export const counterSchema = z.object({
  id: z.string(),
  value: z.number().check(z.int(), z.gte(0), z.lte(MAX_COUNTER)),
  label: z.string(),
  label_lamport: lamportSchema,
});

export type Counter = z.infer<typeof counterSchema>;

/** The single row the demo materializes into. */
export const COUNTER_ID = "default";

export function emptyCounter(): Counter {
  return { id: COUNTER_ID, value: 0, label: "", label_lamport: 0 };
}

export function parseCounter(data: unknown): Counter {
  return counterSchema.parse(data);
}
