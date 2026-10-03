/**
 * The engine side of the eval: does the plan still come out as pinned?
 * Shared by the harness script and the jest suite so a drift in the
 * numbers fails CI before anyone measures the words.
 */

import { amountOf } from '../gameplan/target-amount.js';
import type { Shortlist } from '../gameplan/types.js';
import type { Scenario, ScenarioExpectation } from './scenarios.js';

export { amountOf };

export type RegressionFailure = { scenario: string; what: string; expected: unknown; actual: unknown };

/** The plan as the expectation type sees it, for pinning and comparing. */
export function observed(shortlist: Shortlist): ScenarioExpectation {
  const amounts: Record<string, number> = {};
  for (const candidate of shortlist.plan) {
    const amount = amountOf(candidate.definition);
    if (amount !== null) amounts[candidate.id] = amount;
  }
  return {
    planIds: shortlist.plan.map((candidate) => candidate.id),
    amounts,
    freeCash: shortlist.freeCash.freeCash,
    shelf: shortlist.shelf.total,
    reasons: shortlist.reasons.map((reason) => reason.code),
  };
}

export function checkRegression(scenario: Scenario, shortlist: Shortlist): RegressionFailure[] {
  const failures: RegressionFailure[] = [];
  const actual = observed(shortlist);
  const { expected } = scenario;

  if (JSON.stringify(actual.planIds) !== JSON.stringify(expected.planIds)) {
    failures.push({ scenario: scenario.id, what: 'plan ids', expected: expected.planIds, actual: actual.planIds });
  }
  for (const [id, amount] of Object.entries(expected.amounts)) {
    if (actual.amounts[id] !== amount) {
      failures.push({ scenario: scenario.id, what: `amount of ${id}`, expected: amount, actual: actual.amounts[id] ?? null });
    }
  }
  if (actual.freeCash !== expected.freeCash) {
    failures.push({ scenario: scenario.id, what: 'free cash', expected: expected.freeCash, actual: actual.freeCash });
  }
  if (actual.shelf !== expected.shelf) {
    failures.push({ scenario: scenario.id, what: 'shelf', expected: expected.shelf, actual: actual.shelf });
  }
  for (const code of expected.reasons) {
    if (!actual.reasons.includes(code)) {
      failures.push({ scenario: scenario.id, what: `reason ${code}`, expected: 'present', actual: actual.reasons });
    }
  }

  return failures;
}
