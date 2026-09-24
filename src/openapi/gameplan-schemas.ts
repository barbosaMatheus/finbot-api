/**
 * Contract schemas for the gameplan routes: the engine's types, mirrored in
 * Zod so the OpenAPI document and the generated client see exactly the
 * shapes the anchor returns.
 */

import { z } from 'zod';

const nullableNumber = z.number().nullable();

export const amountClassSchema = z.enum(['fixed', 'variable', 'erratic']);
export const targetOutcomeSchema = z.enum(['met', 'close', 'missed', 'unresolved']);
export const narrationSourceSchema = z.enum(['model', 'template']);
export const coachingPaceSchema = z.enum(['ease_in', 'balanced', 'push']);

export const narrationProvenanceSchema = z.object({
  source: narrationSourceSchema,
  fallbackReason: z.string().nullable(),
  model: z.string().nullable(),
});

export const accrualSchema = z.object({
  totalAmount: z.number(),
  share: z.number(),
  accruedBefore: z.number(),
  accruedAfter: z.number(),
  periodsUntilExpected: z.number().int(),
});

export const expectedBillSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  source: z.enum(['stream', 'declared']),
  status: z.enum(['expected', 'carry_over', 'accruing']),
  basis: z.enum(['confirmed', 'high_confidence', 'declared']),
  cadence: z.string(),
  amountClass: amountClassSchema.nullable(),
  shelfAmount: z.number(),
  planningAmount: z.number(),
  amountRange: z.object({ low: z.number(), high: z.number() }).nullable(),
  expectedDate: z.string().nullable(),
  windowStart: z.string().nullable(),
  windowEnd: z.string().nullable(),
  accrual: accrualSchema.nullable(),
});

export const targetDefinitionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('spend_cap'),
    bucket: z.string(),
    cap: z.number(),
    periodAverage: z.number(),
    bucketAverage: z.number(),
    billShare: z.number(),
    excludedBillStreams: z.array(z.string()),
    base: z.number(),
    reduction: z.number(),
    sharedAccounts: z.boolean(),
  }),
  z.object({
    type: z.literal('frequency_cap'),
    bucket: z.string(),
    maxCount: z.number().int(),
    periodCount: z.number(),
    averageTicket: z.number(),
  }),
  z.object({
    type: z.literal('bill_readiness'),
    amount: z.number(),
    byDate: z.string().nullable(),
    bills: z.array(expectedBillSchema),
  }),
  z.object({
    type: z.literal('savings_transfer'),
    amount: z.number(),
    share: z.number(),
    freeCash: z.number(),
    goal: z
      .object({
        description: z.string(),
        targetAmount: z.number(),
        remaining: z.number(),
        periodsLeft: z.number().int(),
        perPeriodNeeded: z.number(),
      })
      .nullable(),
  }),
  z.object({
    type: z.literal('debt_payment'),
    amount: z.number(),
    share: z.number(),
    freeCash: z.number(),
    balance: z.number(),
  }),
  z.object({
    type: z.literal('awareness'),
    kind: z.enum(['tag_unknowns', 'biggest_purchases', 'which_can_move']),
    unknownAmount: nullableNumber,
    unknownShare: nullableNumber,
    count: z.number().int().nullable(),
    bills: z.array(expectedBillSchema).nullable(),
  }),
]);

/** Structured reasons the model narrates; the code is the discriminator, the rest depends on it. */
export const planReasonSchema = z.looseObject({ code: z.string() });
export const gradeDetailSchema = z.looseObject({ code: z.string() });

export const freeCashSchema = z.object({
  incomeInPeriod: z.number(),
  incomeSource: z.enum(['opening_paycheck', 'streams', 'estimate', 'none']),
  shelf: z.number(),
  essentialFloor: z.number(),
  essentialBuckets: z.array(z.object({ bucket: z.string(), periodAverage: z.number() })),
  essentialStreams: z.array(z.object({ streamKey: z.string(), displayName: z.string(), periodAverage: z.number() })),
  oneTimeCosts: z.number(),
  freeCash: z.number(),
  availableBalance: nullableNumber,
  cashCheck: nullableNumber,
  tight: z.boolean(),
  tightReason: z.enum(['cash_check', 'no_free_cash']).nullable(),
});

export const liveFreeCashSchema = z.object({
  freeCash: z.number(),
  cashCheck: nullableNumber,
  postedBills: z.number().int(),
  remainingShelf: z.number(),
});

export const effectivePaceSchema = z.object({
  chosen: coachingPaceSchema,
  effective: coachingPaceSchema,
  capReduction: z.number(),
  commitShare: z.number(),
});

export const anchorTargetSchema = z.object({
  id: z.string(),
  rank: z.number().int(),
  role: z.enum(['plan', 'alternate']),
  definition: targetDefinitionSchema,
  reasons: z.array(planReasonSchema),
  why: z.string().nullable(),
  whySource: narrationSourceSchema.nullable(),
});

export const anchorPlanSchema = z.object({
  targets: z.array(anchorTargetSchema),
  alternates: z.array(anchorTargetSchema),
  freeCash: freeCashSchema,
  live: liveFreeCashSchema.nullable(),
  shelf: z.object({ total: z.number(), byDate: z.string().nullable(), bills: z.array(expectedBillSchema) }),
  pace: effectivePaceSchema,
  reasons: z.array(planReasonSchema),
  narration: narrationProvenanceSchema.nullable(),
  swapUsed: z.boolean(),
});

export const targetResultSchema = z.object({
  target: targetDefinitionSchema,
  outcome: targetOutcomeSchema,
  details: z.array(gradeDetailSchema),
});

export const anchorGradeSchema = z.object({
  periodId: z.string(),
  period: z.object({ start: z.string(), end: z.string() }),
  results: z.array(targetResultSchema),
  lines: z.array(z.string()),
  improvements: z.string().nullable(),
  moneyCommitOutcome: targetOutcomeSchema.nullable(),
  billOverrunTotal: z.number(),
  narration: narrationProvenanceSchema.nullable(),
});

export const anchorPeriodSchema = z.object({
  id: z.string(),
  start: z.string(),
  end: z.string(),
  trigger: z.enum(['payday', 'fixed_day', 'first']),
  anchorMode: z.enum(['payday', 'fixed_day']),
  status: z.enum(['planned', 'open', 'closed']),
  firstPeriod: z.boolean(),
  openingPaycheck: nullableNumber,
  anchorReadyAt: z.string().nullable(),
  anchorOpenedAt: z.string().nullable(),
  swapUsed: z.boolean(),
  awarenessCompletedAt: z.string().nullable(),
});

export const anchorSettingsSchema = z.object({
  anchorMode: z.enum(['auto', 'payday', 'fixed_day']),
  anchorDay: z.number().int().min(0).max(6),
  anchorTimeOfDay: z.enum(['morning', 'midday', 'evening']),
});

export const anchorResponseSchema = z.object({
  status: z.enum(['no_period', 'building', 'ready']),
  period: anchorPeriodSchema.nullable(),
  plan: anchorPlanSchema.nullable(),
  previousGrade: anchorGradeSchema.nullable(),
  reengage: z.boolean(),
  settings: anchorSettingsSchema,
});

export const gotItResultSchema = z.object({
  periodId: z.string(),
  status: z.enum(['planned', 'open', 'closed']),
  anchorOpenedAt: z.string().nullable(),
});

export const planDiffEntrySchema = z.object({
  change: z.enum(['unchanged', 'shrunk', 'moved_to_next_period', 'relaxed', 'resized', 'replaced', 'added', 'bills_infeasible']),
  before: targetDefinitionSchema.nullable(),
  after: targetDefinitionSchema.nullable(),
});

export const planChangeResultSchema = z.object({
  plan: anchorPlanSchema,
  diff: z.array(planDiffEntrySchema),
});

export const adjustmentRecordSchema = z.object({
  kind: z.enum(['cost', 'spend_event', 'income_change', 'bill_change', 'other']),
  amount: nullableNumber,
  affectedCategory: z.string().nullable(),
  affectedStream: z.string().nullable(),
  timing: z.object({ start: z.string(), end: z.string() }).nullable(),
  text: z.string(),
});

export const headsUpParseResultSchema = z.object({
  adjustment: adjustmentRecordSchema.nullable(),
  needsAmount: z.boolean(),
  proposedAmount: nullableNumber,
  amountDropped: z.boolean(),
  problems: z.array(z.string()),
  source: z.enum(['model', 'none']),
  fallbackReason: z.string().nullable(),
});

export const headsUpResultSchema = z.object({
  outcome: z.enum(['applied', 'context_only', 'no_amount', 'unknown_category', 'unknown_bill', 'no_cap_on_category']),
  applied: z.boolean(),
  reply: z.string(),
  replySource: narrationSourceSchema,
  diff: z.array(planDiffEntrySchema),
  plan: anchorPlanSchema,
});

export const reflectionResultSchema = z.object({
  id: z.string(),
  periodId: z.string().nullable(),
  kind: z.enum(['got_in_the_way', 'whats_been_hard', 'heads_up']),
  attribution: z.enum(['one_off', 'structural']).nullable(),
  attributed: z
    .object({
      category: z.string(),
      start: z.string(),
      end: z.string(),
      amount: z.number(),
      periodAmount: z.number(),
    })
    .nullable(),
});

export const awarenessResultSchema = z.object({
  periodId: z.string(),
  awarenessCompletedAt: z.string().nullable(),
});

export const settingsResultSchema = z.object({
  settings: anchorSettingsSchema,
  effectiveFrom: z.literal('next_period'),
});
