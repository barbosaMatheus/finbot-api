/**
 * Heads-up adjustments (§5, §5a, §6 of the gameplan note).
 *
 * The model turns a line of text into a structured record that can only
 * point at things the engine knows; this module validates that record
 * against the closed vocabulary, applies it deterministically through the
 * yield order, and computes the diff the model then narrates. An amount
 * reaches here only after the user confirmed it in the box (§5a).
 */

import { z } from 'zod';

import { dayNumber } from '../lib/dates.js';
import { buildShortlist } from './candidates.js';
import {
  MONEY_COMMIT_TYPES,
  type Adjustment,
  type AdjustmentResult,
  type AdjustmentVocabulary,
  type Candidate,
  type PlanDiffEntry,
  type Shortlist,
  type ShortlistInput,
  type TargetDefinition,
} from './types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** The shape the model must return (§5). Anything else is dropped. */
export const adjustmentSchema = z.object({
  kind: z.enum(['cost', 'spend_event', 'income_change', 'bill_change', 'other']),
  amount: z.number().nullable().default(null),
  affectedCategory: z.string().nullable().default(null),
  affectedStream: z.string().nullable().default(null),
  timing: z.object({ start: isoDate, end: isoDate }).nullable().default(null),
  text: z.string().default(''),
});

export type AdjustmentProblem = 'unknown_category' | 'unknown_bill' | 'timing_outside_period';

/** The closed lists a heads-up may reference, from the plan it adjusts. */
export function vocabularyFor(shortlist: Shortlist, categories: readonly string[]): AdjustmentVocabulary {
  const seen = new Set<string>();
  const bills: AdjustmentVocabulary['bills'] = [];

  for (const bill of shortlist.shelf.bills) {
    if (seen.has(bill.key)) continue;
    seen.add(bill.key);
    bills.push({ key: bill.key, displayName: bill.displayName });
  }

  return { categories: [...categories], bills, period: shortlist.period };
}

/**
 * Validate a raw record against the schema and the vocabulary. Malformed
 * input returns null. A pointer the vocabulary does not contain is nulled
 * and reported; the kind survives so the line can still be kept as
 * context. Matching is case-insensitive; the vocabulary's spelling wins.
 */
export function validateAdjustment(
  raw: unknown,
  vocabulary: AdjustmentVocabulary,
): { adjustment: Adjustment; problems: AdjustmentProblem[] } | null {
  const parsed = adjustmentSchema.safeParse(raw);
  if (!parsed.success) return null;

  const problems: AdjustmentProblem[] = [];
  const record = parsed.data;

  let affectedCategory: string | null = null;
  if (record.affectedCategory !== null) {
    const match = vocabulary.categories.find(
      (category) => category.toLowerCase() === record.affectedCategory!.trim().toLowerCase(),
    );
    if (match) affectedCategory = match;
    else problems.push('unknown_category');
  }

  let affectedStream: string | null = null;
  if (record.affectedStream !== null) {
    const needle = record.affectedStream.trim().toLowerCase();
    const match = vocabulary.bills.find(
      (bill) => bill.key.toLowerCase() === needle || bill.displayName.toLowerCase() === needle,
    );
    if (match) affectedStream = match.key;
    else problems.push('unknown_bill');
  }

  let timing: Adjustment['timing'] = null;
  if (record.timing !== null) {
    const { start, end } = record.timing;
    const inside =
      dayNumber(start) <= dayNumber(end) &&
      dayNumber(start) >= dayNumber(vocabulary.period.start) &&
      dayNumber(end) <= dayNumber(vocabulary.period.end);
    if (inside) timing = { start, end };
    else problems.push('timing_outside_period');
  }

  const amount =
    record.amount !== null && Number.isFinite(record.amount) && record.amount !== 0
      ? Math.round(record.amount * 100) / 100
      : null;

  return {
    adjustment: {
      kind: record.kind,
      amount,
      affectedCategory,
      affectedStream,
      timing,
      text: record.text,
    },
    problems,
  };
}

function definitionsEqual(a: TargetDefinition, b: TargetDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What changed between two plans, by candidate id: shrunk commits, relaxed
 * caps, targets that moved to the next period, replacements. Computed
 * here, never by the model (§5).
 */
export function diffPlans(before: Shortlist, after: Shortlist): PlanDiffEntry[] {
  const entries: PlanDiffEntry[] = [];
  const afterById = new Map(after.plan.map((candidate) => [candidate.id, candidate]));
  const beforeIds = new Set(before.plan.map((candidate) => candidate.id));
  const removed: Candidate[] = [];

  for (const candidate of before.plan) {
    const next = afterById.get(candidate.id);

    if (!next) {
      removed.push(candidate);
      continue;
    }

    const a = candidate.definition;
    const b = next.definition;

    if (definitionsEqual(a, b)) {
      entries.push({ change: 'unchanged', before: a, after: b });
    } else if (a.type === 'spend_cap' && b.type === 'spend_cap' && b.cap > a.cap) {
      entries.push({ change: 'relaxed', before: a, after: b });
    } else if (
      (a.type === 'savings_transfer' || a.type === 'debt_payment') &&
      b.type === a.type &&
      b.amount < a.amount
    ) {
      entries.push({ change: 'shrunk', before: a, after: b });
    } else if (a.type === 'bill_readiness' && b.type === 'bill_readiness') {
      // Bill readiness never yields; a bill_change or a new expected bill
      // resizes it, and the words say by how much.
      entries.push({ change: 'resized', before: a, after: b });
    } else {
      entries.push({ change: 'replaced', before: a, after: b });
    }
  }

  const added = after.plan.filter((candidate) => !beforeIds.has(candidate.id));
  const afterHasCommit = after.plan.some((candidate) => MONEY_COMMIT_TYPES.has(candidate.definition.type));

  for (const candidate of removed) {
    const replacement = added.shift() ?? null;
    const wasCommit = MONEY_COMMIT_TYPES.has(candidate.definition.type);

    if (wasCommit && !afterHasCommit) {
      // The money-commit fell under the minimum useful amount and moves to
      // the next period; whatever took its slot is the same entry.
      entries.push({ change: 'moved_to_next_period', before: candidate.definition, after: replacement?.definition ?? null });
    } else {
      entries.push({ change: 'replaced', before: candidate.definition, after: replacement?.definition ?? null });
    }
  }

  for (const candidate of added) {
    entries.push({ change: 'added', before: null, after: candidate.definition });
  }

  if (after.reasons.some((reason) => reason.code === 'bills_infeasible')) {
    entries.push({ change: 'bills_infeasible', before: null, after: null });
  }

  return entries;
}

function unchangedResult(input: ShortlistInput, before: Shortlist, outcome: AdjustmentResult['outcome']): AdjustmentResult {
  return { outcome, applied: false, input, before, after: before, diff: diffPlans(before, before) };
}

/**
 * Apply a validated adjustment (§6). The plan is rebuilt from the adjusted
 * input, so the yield order falls out of the same arithmetic every time:
 * the money-commit shrinks to the new pace share of the reduced free cash
 * and moves to the next period under $25; a cap on the affected category
 * relaxes to its average for a spend event; bill readiness never yields,
 * and when the bills no longer fit the plan says so and asks which can
 * move. `other`, or a kind that needed a number the user skipped, changes
 * nothing and says so.
 */
export function applyAdjustment(input: ShortlistInput, adjustment: Adjustment): AdjustmentResult {
  const before = buildShortlist(input);

  switch (adjustment.kind) {
    case 'other':
      return unchangedResult(input, before, 'context_only');

    case 'spend_event': {
      const bucket = adjustment.affectedCategory;
      if (bucket === null) return unchangedResult(input, before, 'unknown_category');

      const hasCap = [...before.plan, ...before.alternates].some(
        (candidate) => candidate.definition.type === 'spend_cap' && candidate.definition.bucket === bucket,
      );
      if (!hasCap) return unchangedResult(input, before, 'no_cap_on_category');

      const next: ShortlistInput = {
        ...input,
        relaxedBuckets: input.relaxedBuckets.includes(bucket)
          ? input.relaxedBuckets
          : [...input.relaxedBuckets, bucket],
      };
      return applied(next, before);
    }

    case 'cost': {
      if (adjustment.amount === null || adjustment.amount <= 0) {
        return unchangedResult(input, before, 'no_amount');
      }
      const next: ShortlistInput = {
        ...input,
        oneTimeCosts: [...input.oneTimeCosts, { label: adjustment.text, amount: adjustment.amount }],
      };
      return applied(next, before);
    }

    case 'income_change': {
      if (adjustment.amount === null) return unchangedResult(input, before, 'no_amount');
      const next: ShortlistInput = {
        ...input,
        incomeAdjustment: (input.incomeAdjustment ?? 0) + adjustment.amount,
      };
      return applied(next, before);
    }

    case 'bill_change': {
      if (adjustment.amount === null || adjustment.amount < 0) {
        return unchangedResult(input, before, 'no_amount');
      }
      const key = adjustment.affectedStream;
      if (key === null) return unchangedResult(input, before, 'unknown_bill');

      const next: ShortlistInput = {
        ...input,
        billOverrides: { ...input.billOverrides, [key]: adjustment.amount },
      };
      return applied(next, before);
    }
  }
}

function applied(next: ShortlistInput, before: Shortlist): AdjustmentResult {
  const after = buildShortlist(next);
  const diff = diffPlans(before, after);
  const changed = diff.some((entry) => entry.change !== 'unchanged');

  return { outcome: 'applied', applied: changed, input: next, before, after, diff };
}
