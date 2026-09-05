import { describe, expect, test } from '@jest/globals';

import {
  MIN_USEFUL_COMMIT,
  PACE_TABLE,
  buildShortlist,
  effectivePace,
  periodsUntilMonthEnd,
  swapTarget,
} from '../../src/gameplan/candidates.js';
import { MONEY_COMMIT_TYPES, type PlanHistory, type ShortlistInput } from '../../src/gameplan/types.js';
import { category, facts, inputFixture, monthlyForPeriod, samInput } from './fixtures.js';

const emptyHistory: PlanHistory = { moneyCommitOutcomes: [], missedCaps: [], discoveryPeriodsDone: 0 };

function typesOf(input: ShortlistInput) {
  return buildShortlist(input).plan.map((candidate) => candidate.definition.type);
}

describe("the walkthrough: Sam, $2,200 biweekly, balanced, building a cushion", () => {
  const shortlist = buildShortlist(samInput());

  test('plan: move $112 to savings, keep eating out under $136, have $1,472 set aside by Sep 29', () => {
    expect(shortlist.freeCash.freeCash).toBe(448);
    expect(shortlist.shelf.total).toBe(1472);
    expect(shortlist.pace).toMatchObject({ chosen: 'balanced', effective: 'balanced', commitShare: 0.25, capReduction: 0.2 });

    expect(shortlist.plan.map((candidate) => candidate.definition)).toEqual([
      expect.objectContaining({ type: 'savings_transfer', amount: 112, share: 0.25, freeCash: 448 }),
      expect.objectContaining({ type: 'spend_cap', bucket: 'Eating Out', cap: 136, periodAverage: 170, reduction: 0.2 }),
      expect.objectContaining({ type: 'bill_readiness', amount: 1472, byDate: '2026-09-29' }),
    ]);
  });

  test('alternates are swappable by construction: never bill readiness, never a second money-commit', () => {
    expect(shortlist.alternates).toHaveLength(2);
    for (const alternate of shortlist.alternates) {
      expect(alternate.definition.type).not.toBe('bill_readiness');
      expect(MONEY_COMMIT_TYPES.has(alternate.definition.type)).toBe(false);
    }
  });

  test('a frequency cap of 4 on small frequent purchases is among the candidates', () => {
    const frequency = shortlist.candidates.find((candidate) => candidate.definition.type === 'frequency_cap');
    expect(frequency?.definition).toMatchObject({ bucket: 'Shopping', maxCount: 4, periodCount: 5, averageTicket: 20 });
  });

  test('the "why" for the insurance accrual carries the running total (§10.7)', () => {
    const bills = shortlist.plan.find((candidate) => candidate.definition.type === 'bill_readiness')!;
    expect(bills.reasons).toContainEqual({
      code: 'accrual',
      displayName: 'GEICO',
      accruedAfter: 55,
      totalAmount: 712,
      expectedDate: '2027-03-14',
    });
  });

  test('no plan-level reasons: not the first period, not tight, not shared', () => {
    expect(shortlist.reasons).toEqual([]);
  });
});

describe('ranking by main goal (§4, decision 4)', () => {
  test('stop overspending: two caps first, then bill readiness', () => {
    const input = inputFixture({ profile: { ...samInput().profile, primaryGoal: 'stop_overspending' } });
    const plan = buildShortlist(input).plan.map((candidate) => candidate.definition);
    expect(plan.map((target) => target.type)).toEqual(['spend_cap', 'spend_cap', 'bill_readiness']);
    // The two largest discretionary categories.
    expect(plan.slice(0, 2).map((target) => (target as { bucket: string }).bucket)).toEqual(['Eating Out', 'Shopping']);
  });

  test('pay down debt: the debt payment first, capped at what is owed', () => {
    const input = inputFixture({
      profile: { ...samInput().profile, primaryGoal: 'pay_down_debt' },
      facts: { ...samInput().facts, balances: { ...samInput().facts.balances, totalLiabilities: 60 } },
    });
    const plan = buildShortlist(input).plan.map((candidate) => candidate.definition);
    expect(plan[0]).toMatchObject({ type: 'debt_payment', amount: 60, balance: 60 });
    expect(plan.map((target) => target.type)).toEqual(['debt_payment', 'spend_cap', 'bill_readiness']);
  });

  test('understand my spending: awareness first, one gentle cap, bill readiness', () => {
    const input = inputFixture({
      profile: { ...samInput().profile, primaryGoal: 'understand_spending' },
      facts: facts({ categoryTotals: samInput().facts.spend.categoryTotals, unknownShareOfOutflow: 0.08 }),
    });
    const plan = buildShortlist(input).plan.map((candidate) => candidate.definition);
    expect(plan[0]).toMatchObject({ type: 'awareness', kind: 'tag_unknowns', unknownShare: 0.08 });
    // One awareness ask, not both kinds.
    expect(plan.map((target) => target.type)).toEqual(['awareness', 'spend_cap', 'bill_readiness']);
  });

  test('not sure: the discovery plan — bill readiness, awareness, one cap — and the reason says so (§9)', () => {
    const input = inputFixture({ profile: { ...samInput().profile, primaryGoal: 'not_sure' } });
    const shortlist = buildShortlist(input);
    expect(shortlist.plan.map((candidate) => candidate.definition.type)).toEqual([
      'bill_readiness',
      'awareness',
      'spend_cap',
    ]);
    expect(shortlist.reasons).toContainEqual({ code: 'discovery_plan' });

    const afterDiscovery = buildShortlist(inputFixture({ ...input, history: { ...emptyHistory, discoveryPeriodsDone: 2 } }));
    expect(afterDiscovery.reasons).not.toContainEqual({ code: 'discovery_plan' });
  });

  test('save for something specific: the transfer is sized to remaining ÷ periods left, within free cash', () => {
    const input = inputFixture({
      profile: {
        ...samInput().profile,
        primaryGoal: 'save_for_specific',
        goalDetail: { description: 'a trip', targetAmount: 1200, targetMonth: '2026-10' },
      },
    });
    const plan = buildShortlist(input).plan.map((candidate) => candidate.definition);
    // Three biweekly periods reach the end of October: $400 a period beats
    // the 25 % share ($112) and fits inside the $448 of free cash.
    expect(plan[0]).toMatchObject({
      type: 'savings_transfer',
      amount: 400,
      goal: { targetAmount: 1200, remaining: 1200, periodsLeft: 3, perPeriodNeeded: 400 },
    });
    expect(periodsUntilMonthEnd('2026-09-25', '2026-12', 14)).toBe(7);

    // A target that cannot be reached in time asks for all the free cash, never more.
    const rushed = inputFixture({
      profile: {
        ...samInput().profile,
        primaryGoal: 'save_for_specific',
        goalDetail: { description: 'a trip', targetAmount: 3000, targetMonth: '2026-10' },
      },
    });
    expect(buildShortlist(rushed).plan[0]!.definition).toMatchObject({ type: 'savings_transfer', amount: 448 });
  });

  test('secondary goals break ties, never lead', () => {
    const input = inputFixture({ profile: { ...samInput().profile, secondaryGoals: ['pay_down_debt'] } });
    // Still a cushion-first plan; the secondary goal cannot put debt first.
    expect(typesOf(input)[0]).toBe('savings_transfer');
  });
});

describe('feasibility (§2)', () => {
  test('a tight cash check removes the money-commit and puts bill readiness first, naming the bills', () => {
    const input = inputFixture({
      facts: { ...samInput().facts, balances: { ...samInput().facts.balances, availableToSpend: 900 } },
    });
    const shortlist = buildShortlist(input);

    expect(shortlist.plan[0]!.definition.type).toBe('bill_readiness');
    expect(shortlist.plan.some((candidate) => MONEY_COMMIT_TYPES.has(candidate.definition.type))).toBe(false);
    expect(shortlist.candidates.some((candidate) => MONEY_COMMIT_TYPES.has(candidate.definition.type))).toBe(false);
    expect(shortlist.reasons).toContainEqual({
      code: 'tight_cash_check',
      cashCheck: -572,
      uncoveredBills: ['Oak Street Lofts', 'City Power', 'Comcast', 'GEICO'],
    });
  });

  test('no free cash: bills and caps only, and the why says so', () => {
    const shortlist = buildShortlist(inputFixture({ openingPaycheck: 1700 }));
    expect(shortlist.plan.some((candidate) => MONEY_COMMIT_TYPES.has(candidate.definition.type))).toBe(false);
    expect(shortlist.reasons).toContainEqual({ code: 'no_free_cash', freeCash: -52 });
  });

  test('a money-commit under the minimum useful amount is not generated (decision 6)', () => {
    // $60 of free cash at a 25 % share is $15: under $25, so no transfer.
    const shortlist = buildShortlist(inputFixture({ openingPaycheck: 1812 }));
    expect(shortlist.freeCash.freeCash).toBe(60);
    expect(shortlist.candidates.some((candidate) => candidate.definition.type === 'savings_transfer')).toBe(false);
    expect(MIN_USEFUL_COMMIT).toBe(25);
  });

  test('bills that do not fit the income: the plan says so and asks which can move (§6)', () => {
    const shortlist = buildShortlist(inputFixture({ openingPaycheck: 1000 }));
    expect(shortlist.reasons).toContainEqual({ code: 'bills_infeasible', shelf: 1472, incomeInPeriod: 1000 });
    expect(shortlist.plan.map((candidate) => candidate.definition.type)).toContain('bill_readiness');
    expect(shortlist.plan.find((candidate) => candidate.definition.type === 'awareness')?.definition).toMatchObject({
      kind: 'which_can_move',
    });
  });

  test('a cap is never below 50 % of the category average, and never on an essential', () => {
    const shortlist = buildShortlist(inputFixture({ profile: { ...samInput().profile, coachingPace: 'push' } }));
    for (const candidate of shortlist.candidates) {
      if (candidate.definition.type !== 'spend_cap') continue;
      expect(candidate.definition.cap).toBeGreaterThanOrEqual(candidate.definition.periodAverage * 0.5);
      expect(['Groceries', 'Fuel', 'Transportation', 'Housing & Utilities']).not.toContain(candidate.definition.bucket);
    }
  });

  test('shared accounts: caps carry the caveat', () => {
    const shortlist = buildShortlist(inputFixture({ profile: { ...samInput().profile, sharedAccounts: true } }));
    const cap = shortlist.plan.find((candidate) => candidate.definition.type === 'spend_cap')!;
    expect(cap.definition).toMatchObject({ sharedAccounts: true });
    expect(cap.reasons).toContainEqual({ code: 'shared_accounts' });
    expect(shortlist.reasons).toContainEqual({ code: 'shared_accounts' });
  });
});

describe('pace (§3, §9, decision 3)', () => {
  test('the table is 10/10 · 20/25 · 30/40', () => {
    expect(PACE_TABLE).toEqual({
      ease_in: { capReduction: 0.1, commitShare: 0.1 },
      balanced: { capReduction: 0.2, commitShare: 0.25 },
      push: { capReduction: 0.3, commitShare: 0.4 },
    });
  });

  test('the first period is one notch easier than chosen', () => {
    const shortlist = buildShortlist(inputFixture({ firstPeriod: true }));
    expect(shortlist.pace).toMatchObject({ chosen: 'balanced', effective: 'ease_in' });
    expect(shortlist.plan[0]!.definition).toMatchObject({ type: 'savings_transfer', amount: 45 });
    expect(shortlist.plan[1]!.definition).toMatchObject({ type: 'spend_cap', cap: 153 });
    expect(shortlist.reasons).toContainEqual({ code: 'first_period' });
    expect(shortlist.reasons).toContainEqual({ code: 'pace_eased', from: 'balanced', to: 'ease_in' });
  });

  test('a missed money-commit drops the pace one notch; two consecutive met periods restore it', () => {
    expect(effectivePace('push', { ...emptyHistory, moneyCommitOutcomes: ['missed'] }, false).effective).toBe('balanced');
    expect(effectivePace('push', { ...emptyHistory, moneyCommitOutcomes: ['missed', 'met'] }, false).effective).toBe('balanced');
    expect(effectivePace('push', { ...emptyHistory, moneyCommitOutcomes: ['missed', 'met', 'met'] }, false).effective).toBe('push');
    expect(effectivePace('push', { ...emptyHistory, moneyCommitOutcomes: ['missed', 'met', 'close', 'met'] }, false).effective).toBe('balanced');
    // Ease-in cannot drop further.
    expect(effectivePace('ease_in', { ...emptyHistory, moneyCommitOutcomes: ['missed'] }, false).effective).toBe('ease_in');
  });

  test('push me: 30 % off the average, 40 % of free cash', () => {
    const shortlist = buildShortlist(inputFixture({ profile: { ...samInput().profile, coachingPace: 'push' } }));
    expect(shortlist.plan[0]!.definition).toMatchObject({ type: 'savings_transfer', amount: 179 });
    expect(shortlist.plan[1]!.definition).toMatchObject({ type: 'spend_cap', cap: 119 });
  });
});

describe('what the last grade changes (§5)', () => {
  test('a structural miss re-sets the cap from the observed level; a one-off brings it back unchanged', () => {
    const structural = buildShortlist(
      inputFixture({ history: { ...emptyHistory, missedCaps: [{ bucket: 'Eating Out', observed: 220, attribution: 'structural' }] } }),
    );
    const cap = structural.plan.find((candidate) => candidate.definition.type === 'spend_cap')!;
    expect(cap.definition).toMatchObject({ bucket: 'Eating Out', base: 220, cap: 176 });
    expect(cap.reasons).toContainEqual({ code: 'cap_reset_from_observed', bucket: 'Eating Out', observed: 220, average: 170 });

    const oneOff = buildShortlist(
      inputFixture({ history: { ...emptyHistory, missedCaps: [{ bucket: 'Eating Out', observed: 220, attribution: 'one_off' }] } }),
    );
    expect(oneOff.plan.find((candidate) => candidate.definition.type === 'spend_cap')!.definition).toMatchObject({ cap: 136 });
  });

  test('a relaxed bucket caps at its average (§6)', () => {
    const shortlist = buildShortlist(inputFixture({ relaxedBuckets: ['Eating Out'] }));
    const cap = shortlist.plan.find((candidate) => candidate.definition.type === 'spend_cap')!;
    expect(cap.definition).toMatchObject({ bucket: 'Eating Out', cap: 170, reduction: 0 });
    expect(cap.reasons).toContainEqual({ code: 'cap_relaxed_for_event', bucket: 'Eating Out', from: 136, to: 170 });
  });
});

describe('diversity and swaps', () => {
  test('three of one type never make a plan: with no bills, the third slot changes type', () => {
    const input = inputFixture({
      streams: [],
      profile: { ...samInput().profile, primaryGoal: 'stop_overspending' },
      facts: facts({
        categoryTotals: [
          category('Eating Out', monthlyForPeriod(170)),
          category('Shopping', monthlyForPeriod(100)),
          category('Entertainment', monthlyForPeriod(60)),
        ],
      }),
    });
    const types = typesOf(input);
    expect(types.slice(0, 2)).toEqual(['spend_cap', 'spend_cap']);
    expect(types[2]).not.toBe('spend_cap');
    expect(new Set(types).size).toBeGreaterThanOrEqual(2);
  });

  test('swapping a target for an alternate keeps the plan feasible; bill readiness cannot be swapped out', () => {
    const shortlist = buildShortlist(samInput());
    const cap = shortlist.plan.find((candidate) => candidate.definition.type === 'spend_cap')!;
    const alternate = shortlist.alternates[0]!;

    const swapped = swapTarget(shortlist, cap.id, alternate.id);
    expect(swapped.plan.map((candidate) => candidate.id)).toContain(alternate.id);
    expect(swapped.plan.map((candidate) => candidate.id)).not.toContain(cap.id);
    expect(swapped.alternates.map((candidate) => candidate.id)).toContain(cap.id);

    const bills = shortlist.plan.find((candidate) => candidate.definition.type === 'bill_readiness')!;
    expect(swapTarget(shortlist, bills.id, alternate.id)).toBe(shortlist);
    expect(swapTarget(shortlist, cap.id, 'nonsense')).toBe(shortlist);
  });
});
