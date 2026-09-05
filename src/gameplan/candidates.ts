/**
 * Candidates, pace and ranking (§1, §3, §4, §9 of the gameplan note), and
 * the shortlist builder that runs the whole pure pipeline: expected bills →
 * free cash → candidates → rank → plan of three plus two alternates.
 *
 * Every number a target carries is computed here from the facts. The model
 * only ever narrates them.
 */

import { daysBetween, daysInMonth, toIsoDate } from '../lib/dates.js';
import {
  COACHING_PACES,
  type CoachingPace,
  type PrimaryGoal,
  type SecondaryGoal,
} from '../types/manual-profile.js';
import { expectedBills, periodLengthDays } from './expected-bills.js';
import { NEVER_CAPPED_BUCKETS, computeFreeCash, scaleMonthlyToPeriod } from './free-cash.js';
import {
  MONEY_COMMIT_TYPES,
  type AwarenessTarget,
  type BillShelf,
  type Candidate,
  type EffectivePace,
  type FreeCash,
  type PaceNumbers,
  type PlanHistory,
  type PlanReason,
  type PlannerProfile,
  type Shortlist,
  type ShortlistInput,
  type TargetDefinition,
  type TargetType,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants (decisions 2, 3, 4, 6, 9)
// ---------------------------------------------------------------------------

/** Cap reduction · share of free cash committed (decision 3). */
export const PACE_TABLE: Record<CoachingPace, PaceNumbers> = {
  ease_in: { capReduction: 0.1, commitShare: 0.1 },
  balanced: { capReduction: 0.2, commitShare: 0.25 },
  push: { capReduction: 0.3, commitShare: 0.4 },
};

/** A money-commit under this moves to the next period instead (decision 6). */
export const MIN_USEFUL_COMMIT = 25;
/** A cap is never set below this share of the category's period average (decision 2). */
export const CAP_FLOOR_SHARE = 0.5;
/** A cap on a category this small is noise, not a target. */
export const MIN_CAP_PERIOD_AVERAGE = 20;
/** Frequency caps target small, frequent purchases (§1). */
export const FREQUENCY_MAX_TICKET = 25;
export const FREQUENCY_MIN_PERIOD_COUNT = 4;
/** Awareness on unknowns when they are this share of outflow, or this much in the period. */
export const UNKNOWN_SHARE_THRESHOLD = 0.05;
export const UNKNOWN_AMOUNT_THRESHOLD = 50;
export const BIGGEST_PURCHASES_COUNT = 3;
/** "Not sure" runs this many discovery periods before a proposal (decision 9). */
export const DISCOVERY_PERIODS = 2;
export const PLAN_SIZE = 3;
export const ALTERNATE_COUNT = 2;

/** Which types come first for each main goal (§4). Ties within a type break on size. */
const GOAL_TYPE_ORDER: Record<PrimaryGoal, TargetType[]> = {
  stop_overspending: ['spend_cap', 'bill_readiness', 'frequency_cap', 'awareness', 'savings_transfer', 'debt_payment'],
  pay_down_debt: ['debt_payment', 'spend_cap', 'bill_readiness', 'frequency_cap', 'awareness', 'savings_transfer'],
  build_cushion: ['savings_transfer', 'spend_cap', 'bill_readiness', 'frequency_cap', 'awareness', 'debt_payment'],
  save_for_specific: ['savings_transfer', 'spend_cap', 'bill_readiness', 'frequency_cap', 'awareness', 'debt_payment'],
  understand_spending: ['awareness', 'spend_cap', 'bill_readiness', 'frequency_cap', 'savings_transfer', 'debt_payment'],
  not_sure: ['bill_readiness', 'awareness', 'spend_cap', 'frequency_cap', 'savings_transfer', 'debt_payment'],
};

/** Secondary goals break ties only (§4). */
const SECONDARY_GOAL_TYPE: Record<SecondaryGoal, TargetType> = {
  stop_overspending: 'spend_cap',
  pay_down_debt: 'debt_payment',
  build_cushion: 'savings_transfer',
  save_for_specific: 'savings_transfer',
  understand_spending: 'awareness',
};

const TYPE_STEP = 10;
const SECONDARY_BONUS = 3;
const SIZE_BONUS_CAP = 5;
const TIGHT_BILL_BONUS = 50;
const INFEASIBLE_BILLS_BONUS = 60;

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function dollars(value: number): number {
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// Pace (§3, decision 3, cadence note §4)
// ---------------------------------------------------------------------------

/**
 * The pace the plan is sized at. The first period is one notch easier than
 * chosen (§9); a missed money-commit drops the pace one notch until two
 * consecutive met periods restore it (§3). Pace never changes the voice.
 */
export function effectivePace(
  chosen: CoachingPace,
  history: PlanHistory,
  firstPeriod: boolean,
): EffectivePace {
  let notch = 0;

  if (firstPeriod) {
    notch = -1;
  } else {
    let metStreak = 0;
    for (const outcome of history.moneyCommitOutcomes) {
      if (outcome === 'missed') {
        notch = -1;
        metStreak = 0;
      } else if (outcome === 'met') {
        metStreak += 1;
        if (metStreak >= 2) notch = 0;
      } else {
        metStreak = 0;
      }
    }
  }

  const index = COACHING_PACES.indexOf(chosen);
  const effective = COACHING_PACES[Math.max(0, Math.min(COACHING_PACES.length - 1, index + notch))]!;

  return { chosen, effective, ...PACE_TABLE[effective] };
}

// ---------------------------------------------------------------------------
// Generation (§1, §2)
// ---------------------------------------------------------------------------

export type GenerationContext = {
  input: ShortlistInput;
  shelf: BillShelf;
  freeCash: FreeCash;
  pace: EffectivePace;
  /** The shelf cannot be covered by the period's income (§6). */
  billsInfeasible: boolean;
};

function spendCapCandidates(ctx: GenerationContext): Candidate[] {
  const { input, pace } = ctx;
  const { facts, period, profile, history } = input;
  const candidates: Candidate[] = [];

  for (const entry of facts.spend.categoryTotals) {
    if (NEVER_CAPPED_BUCKETS.has(entry.bucket)) continue;

    const periodAverage = scaleMonthlyToPeriod(entry.monthlyAverage, period);
    if (periodAverage < MIN_CAP_PERIOD_AVERAGE) continue;

    const reasons: PlanReason[] = [];
    let base = periodAverage;

    // A cap missed last period for a structural reason re-sets from what
    // was actually spent, so it is reachable; a one-off event brings it
    // back at its normal level (§5).
    const missed = history.missedCaps.find((miss) => miss.bucket === entry.bucket);
    if (missed && missed.attribution === 'structural' && missed.observed > periodAverage) {
      base = round2(missed.observed);
      reasons.push({
        code: 'cap_reset_from_observed',
        bucket: entry.bucket,
        observed: base,
        average: periodAverage,
      });
    }

    const reduced = dollars(base * (1 - pace.capReduction));
    const floor = dollars(periodAverage * CAP_FLOOR_SHARE);
    let cap = Math.max(reduced, floor);
    let reduction = pace.capReduction;

    // A spend event on this category relaxes the cap to the average (§6).
    if (input.relaxedBuckets.includes(entry.bucket)) {
      reasons.push({ code: 'cap_relaxed_for_event', bucket: entry.bucket, from: cap, to: dollars(periodAverage) });
      cap = dollars(periodAverage);
      reduction = 0;
    }

    if (profile.sharedAccounts) reasons.push({ code: 'shared_accounts' });

    candidates.push({
      id: `spend_cap:${entry.bucket}`,
      definition: {
        type: 'spend_cap',
        bucket: entry.bucket,
        cap,
        periodAverage,
        base,
        reduction,
        sharedAccounts: profile.sharedAccounts,
      },
      score: 0,
      reasons,
    });
  }

  return candidates;
}

function frequencyCapCandidates(ctx: GenerationContext): Candidate[] {
  const { input, pace } = ctx;
  const { facts, period } = input;
  const windowDays = facts.period.spendWindowDays;
  if (windowDays <= 0) return [];

  const periodDays = periodLengthDays(period);
  const candidates: Candidate[] = [];

  for (const entry of facts.spend.categoryTotals) {
    if (NEVER_CAPPED_BUCKETS.has(entry.bucket) || entry.transactionCount === 0) continue;

    const periodCount = round2(entry.transactionCount * (periodDays / windowDays));
    const averageTicket = round2(entry.total / entry.transactionCount);
    if (periodCount < FREQUENCY_MIN_PERIOD_COUNT || averageTicket > FREQUENCY_MAX_TICKET) continue;

    const maxCount = Math.max(1, Math.floor(periodCount * (1 - pace.capReduction)));
    if (maxCount >= Math.round(periodCount)) continue;

    candidates.push({
      id: `frequency_cap:${entry.bucket}`,
      definition: { type: 'frequency_cap', bucket: entry.bucket, maxCount, periodCount, averageTicket },
      score: 0,
      reasons: [],
    });
  }

  return candidates;
}

function billReadinessCandidate(ctx: GenerationContext): Candidate | null {
  const { shelf, freeCash } = ctx;
  if (shelf.bills.length === 0) return null;

  const reasons: PlanReason[] = [];

  for (const bill of shelf.bills) {
    if (bill.accrual) {
      reasons.push({
        code: 'accrual',
        displayName: bill.displayName,
        accruedAfter: bill.accrual.accruedAfter,
        totalAmount: bill.accrual.totalAmount,
        expectedDate: bill.expectedDate,
      });
    }
  }

  if (freeCash.tightReason === 'cash_check' && freeCash.cashCheck !== null) {
    reasons.push({
      code: 'tight_cash_check',
      cashCheck: freeCash.cashCheck,
      uncoveredBills: shelf.bills.map((bill) => bill.displayName),
    });
  }

  if (ctx.billsInfeasible) {
    reasons.push({ code: 'bills_infeasible', shelf: shelf.total, incomeInPeriod: freeCash.incomeInPeriod });
  }

  return {
    id: 'bill_readiness',
    definition: {
      type: 'bill_readiness',
      amount: shelf.total,
      byDate: shelf.earliestWindowStart,
      bills: shelf.bills,
    },
    score: 0,
    reasons,
  };
}

/** Periods between the period start and the end of a YYYY-MM target month, at least one. */
export function periodsUntilMonthEnd(periodStart: string, targetMonth: string, periodDays: number): number {
  const year = Number(targetMonth.slice(0, 4));
  const month = Number(targetMonth.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 1;

  const monthEnd = toIsoDate({ year, month, day: daysInMonth(year, month) });
  return Math.max(1, Math.ceil((daysBetween(periodStart, monthEnd) + 1) / periodDays));
}

function moneyCommitCandidates(ctx: GenerationContext): Candidate[] {
  const { input, freeCash, pace } = ctx;
  if (freeCash.tight || ctx.billsInfeasible) return [];

  const candidates: Candidate[] = [];
  const shareAmount = dollars(freeCash.freeCash * pace.commitShare);

  // Savings transfer, sized to the goal when there is one (§4).
  let savingsAmount = shareAmount;
  let goal: Extract<TargetDefinition, { type: 'savings_transfer' }>['goal'] = null;
  const detail = input.profile.goalDetail;

  if (input.profile.primaryGoal === 'save_for_specific' && detail && detail.targetAmount !== null) {
    const periodDays = periodLengthDays(input.period);
    const periodsLeft = detail.targetMonth
      ? periodsUntilMonthEnd(input.period.start, detail.targetMonth, periodDays)
      : 1;
    // Nothing tracks what has been saved toward the goal yet; the whole
    // target is treated as remaining, which over-asks rather than under.
    const remaining = round2(detail.targetAmount);
    const perPeriodNeeded = Math.ceil(remaining / periodsLeft);
    savingsAmount = Math.min(dollars(freeCash.freeCash), Math.max(shareAmount, perPeriodNeeded));
    goal = { description: detail.description, targetAmount: detail.targetAmount, remaining, periodsLeft, perPeriodNeeded };
  }

  if (savingsAmount >= MIN_USEFUL_COMMIT) {
    candidates.push({
      id: 'savings_transfer',
      definition: {
        type: 'savings_transfer',
        amount: savingsAmount,
        share: pace.commitShare,
        freeCash: freeCash.freeCash,
        goal,
      },
      score: 0,
      reasons: [],
    });
  }

  // Debt payment, capped at what is owed (§1). Without Plaid Liabilities the
  // minimum and due date are unknown, so the amount is the pace share.
  const balance = input.facts.balances.totalLiabilities;
  if (balance > 0) {
    const debtAmount = Math.min(shareAmount, dollars(balance));
    if (debtAmount >= MIN_USEFUL_COMMIT) {
      candidates.push({
        id: 'debt_payment',
        definition: {
          type: 'debt_payment',
          amount: debtAmount,
          share: pace.commitShare,
          freeCash: freeCash.freeCash,
          balance: round2(balance),
        },
        score: 0,
        reasons: [],
      });
    }
  }

  return candidates;
}

function awarenessCandidates(ctx: GenerationContext): Candidate[] {
  const { input, shelf } = ctx;
  const { facts, period } = input;
  const candidates: Candidate[] = [];

  if (ctx.billsInfeasible && shelf.bills.length > 0) {
    // The bills do not fit this period's income: bill readiness never
    // yields, so the question becomes which of them can move (§6).
    candidates.push({
      id: 'awareness:which_can_move',
      definition: {
        type: 'awareness',
        kind: 'which_can_move',
        unknownAmount: null,
        unknownShare: null,
        count: null,
        bills: shelf.bills,
      },
      score: 0,
      reasons: [{ code: 'bills_infeasible', shelf: shelf.total, incomeInPeriod: ctx.freeCash.incomeInPeriod }],
    });
  }

  const windowDays = facts.period.spendWindowDays;
  const unknownAmount =
    windowDays > 0
      ? round2(facts.unknowns.unknownOutflowTotal * (periodLengthDays(period) / windowDays))
      : 0;
  const unknownShare = facts.unknowns.unknownShareOfOutflow;

  if (unknownShare >= UNKNOWN_SHARE_THRESHOLD || unknownAmount >= UNKNOWN_AMOUNT_THRESHOLD) {
    candidates.push({
      id: 'awareness:tag_unknowns',
      definition: {
        type: 'awareness',
        kind: 'tag_unknowns',
        unknownAmount,
        unknownShare,
        count: null,
        bills: null,
      },
      score: 0,
      reasons: [],
    });
  }

  candidates.push({
    id: 'awareness:biggest_purchases',
    definition: {
      type: 'awareness',
      kind: 'biggest_purchases',
      unknownAmount: null,
      unknownShare: null,
      count: BIGGEST_PURCHASES_COUNT,
      bills: null,
    },
    score: 0,
    reasons: [],
  });

  return candidates;
}

/** Every candidate the facts support, unscored. */
export function generateCandidates(ctx: GenerationContext): Candidate[] {
  const bill = billReadinessCandidate(ctx);

  return [
    ...(bill ? [bill] : []),
    ...spendCapCandidates(ctx),
    ...frequencyCapCandidates(ctx),
    ...moneyCommitCandidates(ctx),
    ...awarenessCandidates(ctx),
  ];
}

// ---------------------------------------------------------------------------
// Ranking (§4)
// ---------------------------------------------------------------------------

function sizeOf(definition: TargetDefinition): number {
  switch (definition.type) {
    case 'spend_cap':
      return definition.periodAverage;
    case 'frequency_cap':
      return definition.periodCount * definition.averageTicket;
    case 'bill_readiness':
      return definition.amount;
    case 'savings_transfer':
    case 'debt_payment':
      return definition.amount;
    case 'awareness':
      return definition.kind === 'which_can_move' ? 1000 : definition.kind === 'tag_unknowns' ? 100 : 0;
  }
}

/**
 * Score and sort: main goal decides the type order, secondary goals break
 * ties, size breaks ties within a type. Tight periods pull bill readiness
 * to the top; infeasible bills pull "which can move?" above everything.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  profile: PlannerProfile,
  freeCash: FreeCash,
  billsInfeasible = false,
): Candidate[] {
  const order = GOAL_TYPE_ORDER[profile.primaryGoal];
  const secondaryTypes = new Set(profile.secondaryGoals.map((goal) => SECONDARY_GOAL_TYPE[goal]));

  const scored = candidates.map((candidate) => {
    const type = candidate.definition.type;
    const typeIndex = order.indexOf(type);
    let score = 100 - TYPE_STEP * (typeIndex < 0 ? order.length : typeIndex);

    if (secondaryTypes.has(type)) score += SECONDARY_BONUS;
    score += Math.min(SIZE_BONUS_CAP, sizeOf(candidate.definition) / 100);

    if (type === 'awareness') {
      const kind = (candidate.definition as AwarenessTarget).kind;
      if (kind === 'biggest_purchases') score -= 2;
      if (kind === 'which_can_move' && billsInfeasible) score += INFEASIBLE_BILLS_BONUS;
    }

    if (type === 'bill_readiness' && (freeCash.tight || billsInfeasible)) score += TIGHT_BILL_BONUS;

    return { ...candidate, score: round2(score) };
  });

  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Selection: three in the plan, two alternates (§4 diversity rules)
// ---------------------------------------------------------------------------

function isMoneyCommit(candidate: Candidate): boolean {
  return MONEY_COMMIT_TYPES.has(candidate.definition.type);
}

/**
 * Top three under the diversity rules: at least two types, at most one
 * money-commit, bill readiness always present when any bill is due. The
 * alternates are the next-ranked candidates a swap can never break: never
 * bill readiness, never a second money-commit.
 */
export function selectPlan(
  ranked: readonly Candidate[],
  hasBills: boolean,
): { plan: Candidate[]; alternates: Candidate[] } {
  const plan: Candidate[] = [];
  const bill = ranked.find((candidate) => candidate.definition.type === 'bill_readiness');
  if (hasBills && bill) plan.push(bill);

  for (const candidate of ranked) {
    if (plan.length >= PLAN_SIZE) break;
    if (plan.includes(candidate)) continue;
    if (isMoneyCommit(candidate) && plan.some(isMoneyCommit)) continue;
    // One awareness ask per period: "tag these" or "look at these", not both (§4).
    if (
      candidate.definition.type === 'awareness' &&
      plan.some((entry) => entry.definition.type === 'awareness')
    ) {
      continue;
    }

    const types = new Set(plan.map((entry) => entry.definition.type));
    const wouldBeLast = plan.length === PLAN_SIZE - 1;
    if (wouldBeLast && types.size === 1 && types.has(candidate.definition.type)) continue;

    plan.push(candidate);
  }

  plan.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const planHasCommit = plan.some(isMoneyCommit);
  const alternates: Candidate[] = [];

  for (const candidate of ranked) {
    if (alternates.length >= ALTERNATE_COUNT) break;
    if (plan.includes(candidate)) continue;
    if (candidate.definition.type === 'bill_readiness') continue;
    if (isMoneyCommit(candidate) && planHasCommit) continue;
    alternates.push(candidate);
  }

  return { plan, alternates };
}

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

export function buildShortlist(input: ShortlistInput): Shortlist {
  const shelf = expectedBills(input.streams, input.declaredObligations, input.period, input.today, {
    accruedToDate: input.accruedToDate,
    billOverrides: input.billOverrides,
  });
  const freeCash = computeFreeCash(input, shelf);
  const pace = effectivePace(input.profile.coachingPace, input.history, input.firstPeriod);
  const billsInfeasible = shelf.bills.length > 0 && shelf.total > freeCash.incomeInPeriod;

  const ctx: GenerationContext = { input, shelf, freeCash, pace, billsInfeasible };
  const ranked = rankCandidates(generateCandidates(ctx), input.profile, freeCash, billsInfeasible);
  const { plan, alternates } = selectPlan(ranked, shelf.bills.length > 0);

  const reasons: PlanReason[] = [];
  if (input.firstPeriod) reasons.push({ code: 'first_period' });
  if (pace.effective !== pace.chosen) reasons.push({ code: 'pace_eased', from: pace.chosen, to: pace.effective });
  if (freeCash.tightReason === 'cash_check' && freeCash.cashCheck !== null) {
    reasons.push({
      code: 'tight_cash_check',
      cashCheck: freeCash.cashCheck,
      uncoveredBills: shelf.bills.map((bill) => bill.displayName),
    });
  }
  if (freeCash.tightReason === 'no_free_cash') reasons.push({ code: 'no_free_cash', freeCash: freeCash.freeCash });
  if (billsInfeasible) reasons.push({ code: 'bills_infeasible', shelf: shelf.total, incomeInPeriod: freeCash.incomeInPeriod });
  if (input.profile.sharedAccounts) reasons.push({ code: 'shared_accounts' });
  if (input.profile.primaryGoal === 'not_sure' && input.history.discoveryPeriodsDone < DISCOVERY_PERIODS) {
    reasons.push({ code: 'discovery_plan' });
  }

  return { period: input.period, pace, freeCash, shelf, plan, alternates, candidates: ranked, reasons };
}

/**
 * Exchange one plan target for one alternate (cadence note §5). Both came
 * from the generator, so the result is feasible by construction; the
 * swapped-out target becomes an alternate.
 */
export function swapTarget(shortlist: Shortlist, outId: string, inId: string): Shortlist {
  const out = shortlist.plan.find((candidate) => candidate.id === outId);
  const incoming = shortlist.alternates.find((candidate) => candidate.id === inId);
  if (!out || !incoming) return shortlist;
  if (out.definition.type === 'bill_readiness') return shortlist;

  return {
    ...shortlist,
    plan: shortlist.plan.map((candidate) => (candidate.id === outId ? incoming : candidate)),
    alternates: shortlist.alternates.map((candidate) => (candidate.id === inId ? out : candidate)),
  };
}
