/**
 * Gameplan engine — domain types.
 *
 * The planner is pure: facts, streams, profile and a period go in; a ranked
 * shortlist of targets with every number computed comes out. Nothing here
 * touches the database or a model. The design is the venture note
 * `gameplan-generation.md` (locked 2026-09-04); section numbers in comments
 * refer to it.
 */

import type { AmountClass, FactsRecurringStream, FinancialFacts } from '../types/financial-facts.js';
import type {
  CoachingPace,
  DeclaredObligation,
  GoalDetail,
  PrimaryGoal,
  SecondaryGoal,
} from '../types/manual-profile.js';

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

/** Why this period opened (cadence note §2). */
export type PeriodTrigger = 'payday' | 'fixed_day' | 'first';

/** The span one plan covers. Dates are YYYY-MM-DD, both ends inclusive. */
export type Period = {
  start: string;
  end: string;
  trigger: PeriodTrigger;
};

// ---------------------------------------------------------------------------
// Expected bills (§10)
// ---------------------------------------------------------------------------

export type ExpectedBillSource = 'stream' | 'declared';

/**
 * expected   — the window overlaps this period; the full planning amount
 *              sits on the shelf.
 * carry_over — the window closed before the period opened and the bill has
 *              not posted; it stays on the shelf until it posts or the
 *              stream goes stale (§10.2).
 * accruing   — cadence longer than the period; this period's share sits on
 *              the shelf (§10.7).
 */
export type ExpectedBillStatus = 'expected' | 'carry_over' | 'accruing';

/** Why the bill counts (§10.1). */
export type ExpectedBillBasis = 'confirmed' | 'high_confidence' | 'declared';

export type Accrual = {
  /** The bill's full planning amount. */
  totalAmount: number;
  /** What this period reserves. */
  share: number;
  /** Running total before this period. */
  accruedBefore: number;
  /** Running total after this period's share. */
  accruedAfter: number;
  periodsUntilExpected: number;
};

export type ExpectedBill = {
  /** Stream key, or `declared:<n>` for an onboarding obligation. */
  key: string;
  displayName: string;
  source: ExpectedBillSource;
  status: ExpectedBillStatus;
  basis: ExpectedBillBasis;
  cadence: string;
  amountClass: AmountClass | null;
  /** What sits on the shelf for this bill this period. */
  shelfAmount: number;
  /** The full planning amount of one posting (equals shelfAmount unless accruing). */
  planningAmount: number;
  amountRange: { low: number; high: number } | null;
  /** Null for declared obligations, which carry no day (§10.6). */
  expectedDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  accrual: Accrual | null;
};

export type BillShelf = {
  bills: ExpectedBill[];
  /** Σ shelfAmount — what this period's income must cover. */
  total: number;
  /**
   * What the balance must hold: the shelf plus what earlier periods already
   * accrued for long-cadence bills, which is still sitting in the balance
   * (§10.7). The cash check reads this.
   */
  cashRequired: number;
  /** Earliest window start among dated bills, clamped to the period start. */
  earliestWindowStart: string | null;
  /** Streams left off the shelf and why, so the "why" can be honest. */
  excluded: Array<{ streamKey: string; displayName: string; reason: BillExclusionReason }>;
};

export type BillExclusionReason =
  | 'dismissed'
  | 'low_confidence'
  | 'stale'
  | 'erratic'
  | 'no_planning_amount'
  | 'posted_this_period'
  | 'outside_period';

// ---------------------------------------------------------------------------
// Free cash (§2)
// ---------------------------------------------------------------------------

export type IncomeSource = 'opening_paycheck' | 'streams' | 'estimate' | 'none';

export type FreeCash = {
  incomeInPeriod: number;
  incomeSource: IncomeSource;
  shelf: number;
  essentialFloor: number;
  essentialBuckets: Array<{ bucket: string; periodAverage: number }>;
  /** Erratic streams in essential buckets that join the floor (§10.3). */
  essentialStreams: Array<{ streamKey: string; displayName: string; periodAverage: number }>;
  oneTimeCosts: number;
  freeCash: number;
  availableBalance: number | null;
  /** availableBalance − shelf; null when no balance is known. */
  cashCheck: number | null;
  /** No money-commit this period (§2). */
  tight: boolean;
  tightReason: 'cash_check' | 'no_free_cash' | null;
};

export type OneTimeCost = {
  label: string;
  amount: number;
};

// ---------------------------------------------------------------------------
// Pace (§3)
// ---------------------------------------------------------------------------

export type PaceNumbers = {
  /** Cap reduction from the historical period average, 0–1. */
  capReduction: number;
  /** Share of free cash a money-commit target takes, 0–1. */
  commitShare: number;
};

export type EffectivePace = PaceNumbers & {
  chosen: CoachingPace;
  effective: CoachingPace;
};

// ---------------------------------------------------------------------------
// Targets (§1)
// ---------------------------------------------------------------------------

export type TargetType =
  | 'spend_cap'
  | 'frequency_cap'
  | 'bill_readiness'
  | 'savings_transfer'
  | 'debt_payment'
  | 'awareness';

export type SpendCapTarget = {
  type: 'spend_cap';
  bucket: string;
  cap: number;
  /**
   * Historical discretionary spend in this bucket scaled to the period:
   * the bucket average less the bill streams that live in it.
   */
  periodAverage: number;
  /** The bucket's whole period average, bills included. */
  bucketAverage: number;
  /** Period-scaled planning amounts of the bill streams left out of the base. */
  billShare: number;
  /** Stream keys whose postings the grade leaves out of the bucket's spend. */
  excludedBillStreams: string[];
  /** The base the cap was cut from: the average, or last period's observed spend after a structural miss (§5). */
  base: number;
  reduction: number;
  /** Caps on a shared account carry a caveat and grade softer (§2). */
  sharedAccounts: boolean;
};

export type FrequencyCapTarget = {
  type: 'frequency_cap';
  bucket: string;
  maxCount: number;
  /** Historical count in this bucket scaled to the period. */
  periodCount: number;
  averageTicket: number;
};

export type BillReadinessTarget = {
  type: 'bill_readiness';
  /** Σ shelf amounts, the one figure the target states (§10.5). */
  amount: number;
  /** Earliest window start; the date the figure is "by". */
  byDate: string | null;
  bills: ExpectedBill[];
};

export type SavingsTransferTarget = {
  type: 'savings_transfer';
  amount: number;
  share: number;
  freeCash: number;
  /** Present for save_for_specific with a target amount (§4). */
  goal: {
    description: string;
    targetAmount: number;
    remaining: number;
    periodsLeft: number;
    perPeriodNeeded: number;
  } | null;
};

export type DebtPaymentTarget = {
  type: 'debt_payment';
  amount: number;
  share: number;
  freeCash: number;
  /** Total liabilities the amount was capped at. */
  balance: number;
};

export type AwarenessTarget = {
  type: 'awareness';
  kind: 'tag_unknowns' | 'biggest_purchases' | 'which_can_move';
  /** Unknown outflow scaled to the period, for tag_unknowns. */
  unknownAmount: number | null;
  unknownShare: number | null;
  /** How many purchases to look at, for biggest_purchases. */
  count: number | null;
  /** The bills that do not fit, for which_can_move (§6). */
  bills: ExpectedBill[] | null;
};

export type TargetDefinition =
  | SpendCapTarget
  | FrequencyCapTarget
  | BillReadinessTarget
  | SavingsTransferTarget
  | DebtPaymentTarget
  | AwarenessTarget;

/** Targets that spend free cash (§1). */
export const MONEY_COMMIT_TYPES: ReadonlySet<TargetType> = new Set([
  'savings_transfer',
  'debt_payment',
]);

/**
 * Structured reasons the model narrates (§5). Every number a "why" may use
 * is in the target definition or here; the model adds none.
 */
export type PlanReason =
  | { code: 'first_period' }
  | { code: 'tight_cash_check'; cashCheck: number; uncoveredBills: string[] }
  | { code: 'no_free_cash'; freeCash: number }
  | { code: 'shared_accounts' }
  | { code: 'discovery_plan' }
  | { code: 'pace_eased'; from: CoachingPace; to: CoachingPace }
  | { code: 'cap_reset_from_observed'; bucket: string; observed: number; average: number }
  | { code: 'cap_relaxed_for_event'; bucket: string; from: number; to: number }
  | { code: 'accrual'; displayName: string; accruedAfter: number; totalAmount: number; expectedDate: string | null }
  | { code: 'bills_infeasible'; shelf: number; incomeInPeriod: number };

export type Candidate = {
  /** Stable within a shortlist: `${type}:${discriminator}`. */
  id: string;
  definition: TargetDefinition;
  score: number;
  reasons: PlanReason[];
};

export type Shortlist = {
  period: Period;
  pace: EffectivePace;
  freeCash: FreeCash;
  shelf: BillShelf;
  /** Ranks 1–3. */
  plan: Candidate[];
  /** Ranks 4–5; each is a feasible swap for a plan target. */
  alternates: Candidate[];
  /** Every candidate generated, ranked. */
  candidates: Candidate[];
  /** Plan-level reasons (tight period, discovery, first period). */
  reasons: PlanReason[];
};

// ---------------------------------------------------------------------------
// Planner input
// ---------------------------------------------------------------------------

/** The profile fields the planner reads (profile v2). */
export type PlannerProfile = {
  primaryGoal: PrimaryGoal;
  secondaryGoals: SecondaryGoal[];
  coachingPace: CoachingPace;
  sharedAccounts: boolean;
  goalDetail: GoalDetail | null;
};

/** The last period's grade, as the planner needs it. */
export type PlanHistory = {
  /** Money-commit outcomes, oldest first; drives the pace notch (§3). */
  moneyCommitOutcomes: TargetOutcome[];
  /**
   * Caps missed last period and whether "what got in the way?" attributed
   * the miss to a one-off event; structural misses re-set the cap from the
   * observed level (§5).
   */
  missedCaps: Array<{ bucket: string; observed: number; attribution: 'one_off' | 'structural' }>;
  /** Discovery periods already run for a "not sure" user (§9). */
  discoveryPeriodsDone: number;
};

export type ShortlistInput = {
  facts: FinancialFacts;
  streams: FactsRecurringStream[];
  declaredObligations: DeclaredObligation[];
  profile: PlannerProfile;
  period: Period;
  /** YYYY-MM-DD; the build date, injected for reproducibility. */
  today: string;
  /** The paycheck that opened a payday period; null otherwise. */
  openingPaycheck: number | null;
  /** The stream the opening paycheck came from, excluded from "other" income. */
  primaryIncomeStreamKey: string | null;
  firstPeriod: boolean;
  history: PlanHistory;
  /** Running accrual totals per stream key from earlier periods (§10.7). */
  accruedToDate: Record<string, number>;
  /** Confirmed heads-up costs already applied to this period (§5a). */
  oneTimeCosts: OneTimeCost[];
  /** Planning-amount overrides for this period from bill_change heads-ups (§10.5). */
  billOverrides: Record<string, number>;
  /** Buckets whose cap relaxed to the average for a spend event (§6). */
  relaxedBuckets: string[];
  /** Signed income adjustment for this period from an income_change heads-up. */
  incomeAdjustment: number;
};

// ---------------------------------------------------------------------------
// Adjustment (§5, §5a, §6)
// ---------------------------------------------------------------------------

export type AdjustmentKind = 'cost' | 'spend_event' | 'income_change' | 'bill_change' | 'other';

/**
 * The structured record a heads-up becomes. `amount` is whatever the user
 * confirmed in the box (§5a) — the model's extraction is only a proposal
 * and never reaches here on its own. Its meaning by kind: cost → the cost;
 * income_change → the signed change to income in this period; bill_change
 * → the new planning amount for the named bill.
 */
export type Adjustment = {
  kind: AdjustmentKind;
  amount: number | null;
  /** A bucket name from the vocabulary. */
  affectedCategory: string | null;
  /** An expected-bill key from the vocabulary. */
  affectedStream: string | null;
  timing: { start: string; end: string } | null;
  /** The user's own words, for the reply. */
  text: string;
};

/** The closed lists the model may point at (§5). */
export type AdjustmentVocabulary = {
  categories: string[];
  bills: Array<{ key: string; displayName: string }>;
  period: Period;
};

export type PlanDiffChange =
  | 'unchanged'
  | 'shrunk'
  | 'moved_to_next_period'
  | 'relaxed'
  | 'resized'
  | 'replaced'
  | 'added'
  | 'bills_infeasible';

export type PlanDiffEntry = {
  change: PlanDiffChange;
  before: TargetDefinition | null;
  after: TargetDefinition | null;
};

export type AdjustmentOutcome =
  | 'applied'
  | 'context_only'
  | 'no_amount'
  | 'unknown_category'
  | 'unknown_bill'
  | 'no_cap_on_category';

export type AdjustmentResult = {
  outcome: AdjustmentOutcome;
  /** True when the plan changed. */
  applied: boolean;
  input: ShortlistInput;
  before: Shortlist;
  after: Shortlist;
  diff: PlanDiffEntry[];
};

// ---------------------------------------------------------------------------
// Grading (§7)
// ---------------------------------------------------------------------------

/** `unresolved` is a bill that never posted in its window: neither met nor missed (§10.4). */
export type TargetOutcome = 'met' | 'close' | 'missed' | 'unresolved';

export type PostedBill = {
  key: string;
  amount: number;
  date: string;
  feeOrOverdraft: boolean;
};

export type PeriodActuals = {
  spendByBucket: Record<string, number>;
  countByBucket: Record<string, number>;
  postedBills: PostedBill[];
  /** Largest single savings-transfer-role transaction in the period. */
  largestSavingsTransfer: number;
  /** Largest single card-payment-role transaction in the period. */
  largestDebtPayment: number;
  balanceAtClose: number | null;
  awarenessCompleted: boolean;
};

export type GradeDetail =
  | { code: 'within'; measured: number; threshold: number }
  | { code: 'over_by'; measured: number; threshold: number; overBy: number; overByShare: number }
  | { code: 'shared_softened'; overByShare: number }
  | { code: 'commit_short'; measured: number; threshold: number; shortBy: number }
  | { code: 'bill_overrun_covered'; shortBy: number; overrun: number; bills: string[] }
  | { code: 'bill_posted'; key: string; displayName: string; amount: number; planningAmount: number }
  | { code: 'bill_fee'; key: string; displayName: string }
  | { code: 'bill_unresolved'; key: string; displayName: string; windowEnd: string | null }
  | { code: 'balance_covers'; balance: number; remaining: number }
  | { code: 'balance_short'; balance: number; remaining: number }
  | { code: 'awareness'; completed: boolean };

export type TargetResult = {
  target: TargetDefinition;
  outcome: TargetOutcome;
  details: GradeDetail[];
};

export type PeriodGrade = {
  /** Ordered met → close → unresolved → missed, so positives lead. */
  results: TargetResult[];
  moneyCommitOutcome: TargetOutcome | null;
  /** Missed targets, the ones "what got in the way?" asks about. */
  misses: TargetResult[];
  /** Σ (actual − planning) over bills that posted high, for the commit rule. */
  billOverrunTotal: number;
};
