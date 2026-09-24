/**
 * Small order statistics shared by recurrence detection and the gameplan
 * engine. Pure, deterministic, and replayable: the same numbers in produce
 * the same number out, which is what lets a stored planning amount be
 * re-derived from the evidence it was computed from.
 */

/** Median of a list; 0 for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Nearest-rank percentile: the smallest value such that at least `p` of the
 * list is at or below it. Always an observed value, never an interpolated
 * one, so "the 75th percentile of what you paid" is a bill that actually
 * posted. `p` in [0, 1]; 0 for an empty list.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1]!;
}
