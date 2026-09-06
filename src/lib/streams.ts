/**
 * Pure rules about recurring streams shared by the facts engine and the
 * gameplan engine. Nothing here touches the database, so the planner can
 * import it without pulling in a connection pool.
 */

import type { FactsRecurringStream } from '../types/financial-facts.js';

function parseDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

/**
 * A stream whose last occurrence is much older than its cadence has ended —
 * a previous employer's payroll, a cancelled subscription. Grace is 2× the
 * cadence with a 21-day floor so a weekly stream survives a short vacation.
 * User-confirmed streams follow the same physics: money that stopped
 * arriving is not income, and a bill that stopped landing is not reserved.
 */
export function isStreamStale(
  stream: Pick<FactsRecurringStream, 'cadenceDays' | 'lastDate'>,
  throughDate: string,
): boolean {
  const graceDays = Math.max(2 * stream.cadenceDays, 21);
  return parseDay(throughDate) - parseDay(stream.lastDate) > graceDays;
}
