import { describe, expect, test } from '@jest/globals';

import { applyAdjustment, validateAdjustment, vocabularyFor } from '../../src/gameplan/adjustment.js';
import { buildShortlist } from '../../src/gameplan/candidates.js';
import type { Adjustment } from '../../src/gameplan/types.js';
import { samInput } from './fixtures.js';

const CATEGORIES = ['Groceries', 'Fuel', 'Transportation', 'Eating Out', 'Shopping', 'Housing & Utilities', 'Entertainment'];

function adjustment(overrides: Partial<Adjustment>): Adjustment {
  return {
    kind: 'other',
    amount: null,
    affectedCategory: null,
    affectedStream: null,
    timing: null,
    text: '',
    ...overrides,
  };
}

describe('validateAdjustment (§5, decision 5)', () => {
  const vocabulary = vocabularyFor(buildShortlist(samInput()), CATEGORIES);

  test('the vocabulary is the categories, this period’s bills and the period dates', () => {
    expect(vocabulary.bills.map((bill) => bill.displayName)).toEqual(['Oak Street Lofts', 'City Power', 'Comcast', 'GEICO']);
    expect(vocabulary.period).toEqual(samInput().period);
  });

  test('malformed output is dropped', () => {
    expect(validateAdjustment({ kind: 'surprise' }, vocabulary)).toBeNull();
    expect(validateAdjustment('cost 400', vocabulary)).toBeNull();
    expect(validateAdjustment({ kind: 'cost', amount: 'four hundred' }, vocabulary)).toBeNull();
  });

  test('pointers outside the closed lists are nulled and reported; matching is case-insensitive', () => {
    const result = validateAdjustment(
      { kind: 'spend_event', affectedCategory: 'eating out', affectedStream: 'landlord', text: 'sister visiting' },
      vocabulary,
    )!;
    expect(result.adjustment).toMatchObject({ kind: 'spend_event', affectedCategory: 'Eating Out', affectedStream: null });
    expect(result.problems).toEqual(['unknown_bill']);

    const byName = validateAdjustment({ kind: 'bill_change', affectedStream: 'oak street lofts', amount: 1300 }, vocabulary)!;
    expect(byName.adjustment.affectedStream).toBe('outflow:oak street lofts');
  });

  test('timing outside the period is dropped; a zero amount reads as none', () => {
    const result = validateAdjustment(
      { kind: 'cost', amount: 0, timing: { start: '2026-11-01', end: '2026-11-03' } },
      vocabulary,
    )!;
    expect(result.adjustment.timing).toBeNull();
    expect(result.adjustment.amount).toBeNull();
    expect(result.problems).toEqual(['timing_outside_period']);
  });
});

describe('applyAdjustment — the yield order (§6, decision 6)', () => {
  test('a confirmed cost shrinks the money-commit to the new pace share; caps and bills stand', () => {
    const result = applyAdjustment(samInput(), adjustment({ kind: 'cost', amount: 200, text: 'car repair, about $200' }));

    expect(result.outcome).toBe('applied');
    expect(result.applied).toBe(true);
    expect(result.after.freeCash.freeCash).toBe(248);
    expect(result.diff).toContainEqual({
      change: 'shrunk',
      before: expect.objectContaining({ type: 'savings_transfer', amount: 112 }),
      after: expect.objectContaining({ type: 'savings_transfer', amount: 62 }),
    });
    expect(result.diff).toContainEqual({
      change: 'unchanged',
      before: expect.objectContaining({ type: 'spend_cap', cap: 136 }),
      after: expect.objectContaining({ type: 'spend_cap', cap: 136 }),
    });
    expect(result.diff).toContainEqual({
      change: 'unchanged',
      before: expect.objectContaining({ type: 'bill_readiness', amount: 1472 }),
      after: expect.objectContaining({ type: 'bill_readiness', amount: 1472 }),
    });
  });

  test('under $25 the money-commit moves to the next period and a non-commit takes its slot', () => {
    const result = applyAdjustment(samInput(), adjustment({ kind: 'cost', amount: 400, text: 'car repair' }));

    expect(result.after.freeCash.freeCash).toBe(48);
    const moved = result.diff.find((entry) => entry.change === 'moved_to_next_period')!;
    expect(moved.before).toMatchObject({ type: 'savings_transfer', amount: 112 });
    expect(moved.after).not.toBeNull();
    expect(moved.after!.type).not.toBe('savings_transfer');
    expect(result.after.plan.some((candidate) => candidate.definition.type === 'savings_transfer')).toBe(false);
    expect(result.after.plan).toHaveLength(3);
  });

  test('a spend event relaxes the cap on the affected category to its average; the transfer and bills do not change', () => {
    const result = applyAdjustment(
      samInput(),
      adjustment({ kind: 'spend_event', affectedCategory: 'Eating Out', text: "my sister's in town next weekend" }),
    );

    expect(result.outcome).toBe('applied');
    expect(result.diff).toContainEqual({
      change: 'relaxed',
      before: expect.objectContaining({ type: 'spend_cap', bucket: 'Eating Out', cap: 136 }),
      after: expect.objectContaining({ type: 'spend_cap', bucket: 'Eating Out', cap: 170 }),
    });
    expect(result.diff.filter((entry) => entry.change === 'unchanged')).toHaveLength(2);
    expect(result.after.freeCash.freeCash).toBe(448);
  });

  test('a spend event on a category with no cap changes nothing and says why', () => {
    const result = applyAdjustment(samInput(), adjustment({ kind: 'spend_event', affectedCategory: 'Groceries' }));
    expect(result).toMatchObject({ outcome: 'no_cap_on_category', applied: false });
    expect(result.after).toBe(result.before);
  });

  test('a bill change resizes bill readiness and the commit yields; bill readiness never does', () => {
    const result = applyAdjustment(
      samInput(),
      adjustment({ kind: 'bill_change', affectedStream: 'outflow:oak street lofts', amount: 1300, text: 'rent is going up to $1,300' }),
    );

    expect(result.after.shelf.total).toBe(1572);
    expect(result.after.freeCash.freeCash).toBe(348);
    expect(result.diff).toContainEqual({
      change: 'resized',
      before: expect.objectContaining({ type: 'bill_readiness', amount: 1472 }),
      after: expect.objectContaining({ type: 'bill_readiness', amount: 1572 }),
    });
    expect(result.diff).toContainEqual({
      change: 'shrunk',
      before: expect.objectContaining({ amount: 112 }),
      after: expect.objectContaining({ amount: 87 }),
    });
  });

  test('an income change moves free cash by its signed amount', () => {
    const result = applyAdjustment(samInput(), adjustment({ kind: 'income_change', amount: -300, text: 'hours got cut' }));
    expect(result.after.freeCash).toMatchObject({ incomeInPeriod: 1900, freeCash: 148 });
    expect(result.diff).toContainEqual(expect.objectContaining({ change: 'shrunk', after: expect.objectContaining({ amount: 37 }) }));
  });

  test('when the bills no longer fit, the plan says so and asks which can move', () => {
    const result = applyAdjustment(samInput(), adjustment({ kind: 'income_change', amount: -1200, text: 'no shifts this week' }));
    expect(result.after.reasons).toContainEqual({ code: 'bills_infeasible', shelf: 1472, incomeInPeriod: 1000 });
    expect(result.diff).toContainEqual({ change: 'bills_infeasible', before: null, after: null });
    expect(result.after.plan.find((candidate) => candidate.definition.type === 'awareness')?.definition).toMatchObject({
      kind: 'which_can_move',
    });
  });

  test('skipping the amount box, or a line that is only context, leaves the plan unchanged and says so (§5a)', () => {
    const skipped = applyAdjustment(samInput(), adjustment({ kind: 'cost', amount: null, text: 'car trouble' }));
    expect(skipped).toMatchObject({ outcome: 'no_amount', applied: false });
    expect(skipped.diff.every((entry) => entry.change === 'unchanged')).toBe(true);

    const context = applyAdjustment(samInput(), adjustment({ kind: 'other', text: 'busy week' }));
    expect(context).toMatchObject({ outcome: 'context_only', applied: false });

    const unknownBill = applyAdjustment(samInput(), adjustment({ kind: 'bill_change', amount: 900, affectedStream: null }));
    expect(unknownBill.outcome).toBe('unknown_bill');
  });

  test('the same heads-up always produces the same diff', () => {
    const a = applyAdjustment(samInput(), adjustment({ kind: 'cost', amount: 200 }));
    const b = applyAdjustment(samInput(), adjustment({ kind: 'cost', amount: 200 }));
    expect(a.diff).toEqual(b.diff);
    expect(a.after.plan).toEqual(b.after.plan);
  });
});
