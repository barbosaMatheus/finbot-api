/**
 * Grading (§7 of the gameplan note, decision 7): met / close / missed per
 * target from the period's actuals, with the deciding numbers carried as
 * structured detail for the model to narrate. Positives lead: results are
 * ordered met → close → unresolved → missed.
 */

import type {
  BillReadinessTarget,
  GradeDetail,
  PeriodActuals,
  PeriodGrade,
  TargetDefinition,
  TargetOutcome,
  TargetResult,
} from './types.js';

/** A cap is "close" when over by no more than this share of it. */
export const CLOSE_OVER_SHARE = 0.1;
/** A money-commit is "close" from this share of its amount. */
export const CLOSE_COMMIT_SHARE = 0.8;
/** On shared accounts a cap miss reads as close up to this overage (§2). */
export const SHARED_SOFTENED_OVER_SHARE = 0.25;

const OUTCOME_ORDER: Record<TargetOutcome, number> = { met: 0, close: 1, unresolved: 2, missed: 3 };

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

/** Σ (actual − planning) over postings that came in high, per bill readiness target. */
export function billOverruns(
  target: BillReadinessTarget,
  actuals: PeriodActuals,
): { total: number; bills: string[] } {
  let total = 0;
  const bills: string[] = [];

  for (const bill of target.bills) {
    for (const posted of actuals.postedBills) {
      if (posted.key !== bill.key) continue;
      const overrun = posted.amount - bill.planningAmount;
      if (overrun > 0) {
        total += overrun;
        if (!bills.includes(bill.displayName)) bills.push(bill.displayName);
      }
    }
  }

  return { total: round2(total), bills };
}

export type GradeContext = {
  billOverrunTotal: number;
  overrunBills: string[];
};

function gradeCap(
  cap: number,
  measured: number,
  sharedAccounts: boolean,
): { outcome: TargetOutcome; details: GradeDetail[] } {
  const overBy = round2(measured - cap);

  if (overBy <= 0) {
    return { outcome: 'met', details: [{ code: 'within', measured, threshold: cap }] };
  }

  const overByShare = cap > 0 ? round2(overBy / cap) : 1;
  const details: GradeDetail[] = [{ code: 'over_by', measured, threshold: cap, overBy, overByShare }];

  if (overByShare <= CLOSE_OVER_SHARE) return { outcome: 'close', details };

  if (sharedAccounts && overByShare <= SHARED_SOFTENED_OVER_SHARE) {
    details.push({ code: 'shared_softened', overByShare });
    return { outcome: 'close', details };
  }

  return { outcome: 'missed', details };
}

function gradeCommit(
  amount: number,
  measured: number,
  ctx: GradeContext,
): { outcome: TargetOutcome; details: GradeDetail[] } {
  if (measured >= amount) {
    return { outcome: 'met', details: [{ code: 'within', measured, threshold: amount }] };
  }

  const shortBy = round2(amount - measured);
  const details: GradeDetail[] = [{ code: 'commit_short', measured, threshold: amount, shortBy }];

  if (measured >= amount * CLOSE_COMMIT_SHARE) return { outcome: 'close', details };

  // The user did what was asked and a bill's estimate was short (§7).
  if (ctx.billOverrunTotal > 0 && shortBy <= ctx.billOverrunTotal) {
    details.push({ code: 'bill_overrun_covered', shortBy, overrun: ctx.billOverrunTotal, bills: ctx.overrunBills });
    return { outcome: 'close', details };
  }

  return { outcome: 'missed', details };
}

function gradeBills(
  target: BillReadinessTarget,
  actuals: PeriodActuals,
): { outcome: TargetOutcome; details: GradeDetail[] } {
  const details: GradeDetail[] = [];
  let fee = false;
  let anyPosted = false;
  let remaining = 0;

  for (const bill of target.bills) {
    const postings = actuals.postedBills.filter((posted) => posted.key === bill.key);

    if (bill.accrual && bill.status === 'accruing') {
      // Nothing lands this period; the share stays in the balance.
      remaining += bill.shelfAmount;
      continue;
    }

    if (postings.length === 0) {
      remaining += bill.shelfAmount;
      details.push({ code: 'bill_unresolved', key: bill.key, displayName: bill.displayName, windowEnd: bill.windowEnd });
      continue;
    }

    anyPosted = true;
    for (const posted of postings) {
      if (posted.feeOrOverdraft) {
        fee = true;
        details.push({ code: 'bill_fee', key: bill.key, displayName: bill.displayName });
      } else {
        details.push({
          code: 'bill_posted',
          key: bill.key,
          displayName: bill.displayName,
          amount: posted.amount,
          planningAmount: bill.planningAmount,
        });
      }
    }
  }

  remaining = round2(remaining);
  let balanceShort = false;

  if (remaining > 0 && actuals.balanceAtClose !== null) {
    if (actuals.balanceAtClose >= remaining) {
      details.push({ code: 'balance_covers', balance: actuals.balanceAtClose, remaining });
    } else {
      balanceShort = true;
      details.push({ code: 'balance_short', balance: actuals.balanceAtClose, remaining });
    }
  }

  if (fee || balanceShort) return { outcome: 'missed', details };
  if (anyPosted || actuals.balanceAtClose !== null) return { outcome: 'met', details };
  // Nothing posted and no balance to check: neither met nor missed (§10.4).
  return { outcome: 'unresolved', details };
}

export function gradeTarget(
  target: TargetDefinition,
  actuals: PeriodActuals,
  ctx: GradeContext,
): TargetResult {
  switch (target.type) {
    case 'spend_cap': {
      const measured = round2(actuals.spendByBucket[target.bucket] ?? 0);
      return { target, ...gradeCap(target.cap, measured, target.sharedAccounts) };
    }
    case 'frequency_cap': {
      const count = actuals.countByBucket[target.bucket] ?? 0;
      const overBy = count - target.maxCount;
      const outcome: TargetOutcome = overBy <= 0 ? 'met' : overBy === 1 ? 'close' : 'missed';
      const details: GradeDetail[] =
        overBy <= 0
          ? [{ code: 'within', measured: count, threshold: target.maxCount }]
          : [{ code: 'over_by', measured: count, threshold: target.maxCount, overBy, overByShare: round2(overBy / target.maxCount) }];
      return { target, outcome, details };
    }
    case 'bill_readiness':
      return { target, ...gradeBills(target, actuals) };
    case 'savings_transfer':
      return { target, ...gradeCommit(target.amount, actuals.largestSavingsTransfer, ctx) };
    case 'debt_payment':
      return { target, ...gradeCommit(target.amount, actuals.largestDebtPayment, ctx) };
    case 'awareness':
      return {
        target,
        outcome: actuals.awarenessCompleted ? 'met' : 'missed',
        details: [{ code: 'awareness', completed: actuals.awarenessCompleted }],
      };
  }
}

/**
 * Grade a period's targets. Bill overruns are computed first so a
 * money-commit short by no more than the overrun can grade close (§7).
 */
export function gradePeriod(targets: readonly TargetDefinition[], actuals: PeriodActuals): PeriodGrade {
  let billOverrunTotal = 0;
  const overrunBills: string[] = [];

  for (const target of targets) {
    if (target.type !== 'bill_readiness') continue;
    const overruns = billOverruns(target, actuals);
    billOverrunTotal += overruns.total;
    for (const name of overruns.bills) if (!overrunBills.includes(name)) overrunBills.push(name);
  }

  const ctx: GradeContext = { billOverrunTotal: round2(billOverrunTotal), overrunBills };
  const results = targets.map((target) => gradeTarget(target, actuals, ctx));

  const ordered = results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => OUTCOME_ORDER[a.result.outcome] - OUTCOME_ORDER[b.result.outcome] || a.index - b.index)
    .map((entry) => entry.result);

  const commit = results.find(
    (result) => result.target.type === 'savings_transfer' || result.target.type === 'debt_payment',
  );

  return {
    results: ordered,
    moneyCommitOutcome: commit ? commit.outcome : null,
    misses: ordered.filter((result) => result.outcome === 'missed'),
    billOverrunTotal: ctx.billOverrunTotal,
  };
}
