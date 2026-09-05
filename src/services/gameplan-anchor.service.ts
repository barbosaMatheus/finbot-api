/**
 * The anchor (cadence note §1, §5): what the app reads once per period and
 * the few things the user can do there. The user never writes a target —
 * they acknowledge, swap one for an alternate, give one heads-up line the
 * plan re-proposes from, and answer "what got in the way?".
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { addDays, dayNumber } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { applyAdjustment, diffPlans, validateAdjustment, vocabularyFor } from '../gameplan/adjustment.js';
import { swapTarget } from '../gameplan/candidates.js';
import type {
  Adjustment,
  AdjustmentKind,
  AdjustmentOutcome,
  EffectivePace,
  ExpectedBill,
  FreeCash,
  PlanDiffEntry,
  PlanReason,
  Shortlist,
  TargetDefinition,
  TargetOutcome,
  TargetResult,
} from '../gameplan/types.js';
import { llmProviderFromEnv } from '../llm/provider.js';
import type { LlmProvider, NarrationFallbackReason } from '../llm/types.js';
import { GameplanError } from '../types/gameplan.js';
import { persistUserTextEmbeddings } from './embedding.service.js';
import {
  computeFinancialFacts,
  loadFactsData,
  summarizeBalances,
  type FactsData,
} from './financial-facts.service.js';
import { assembleShortlistInput, silentAnchorStreak, REENGAGE_AFTER_SILENT } from './gameplan-build.service.js';
import { buildActuals, listGradeTransactions, type GradeTransaction } from './gameplan-grade.service.js';
import {
  getAnchorSettings,
  getGrade,
  getLastSwap,
  getLivePeriod,
  insertReflection,
  insertRevision,
  listClosedPeriods,
  listTargets,
  markAnchorOpened,
  markAwarenessCompleted,
  markReflectionEmbedded,
  markSwapUsed,
  savePlan,
  updateAnchorSettings,
  updateHeadsUp,
  type AnchorSettings,
  type GameplanPeriod,
  type NarrationProvenance,
  type NarrationSource,
  type StoredTarget,
} from './gameplan-store.service.js';

/** The source tag reflections are embedded under, for chat retrieval. */
export const REFLECTION_EMBEDDING_SOURCE = 'gameplan_reflection';
/** Kinds whose heads-up needs a number before the plan can move (§5a). */
export const AMOUNT_KINDS: ReadonlySet<AdjustmentKind> = new Set(['cost', 'income_change', 'bill_change']);
/** Postings this far before the period may belong to a carry-over bill. */
const LOOKBACK_DAYS = 14;

export type AnchorDeps = {
  db: Queryable;
  loadData(userId: string): Promise<FactsData>;
  provider: LlmProvider;
  embed(input: { userId: string; text: string; source: string }): Promise<unknown>;
  listTransactions(userId: string, since: string): Promise<GradeTransaction[]>;
  now(): Date;
};

async function defaultDeps(): Promise<AnchorDeps> {
  return {
    db: pool,
    loadData: (userId) => loadFactsData(userId),
    provider: llmProviderFromEnv(),
    embed: (input) => persistUserTextEmbeddings(input),
    listTransactions: (userId, since) => listGradeTransactions(userId, since),
    now: () => new Date(),
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type AnchorTarget = {
  id: string;
  rank: number;
  role: 'plan' | 'alternate';
  definition: TargetDefinition;
  reasons: PlanReason[];
  why: string | null;
  whySource: NarrationSource | null;
};

export type LiveFreeCash = {
  /** The opening figure less what posted bills came in over (or under) their planning amounts. */
  freeCash: number;
  /** Available balance less the bills still expected; null with no balance. */
  cashCheck: number | null;
  postedBills: number;
  remainingShelf: number;
};

export type AnchorPlanView = {
  targets: AnchorTarget[];
  alternates: AnchorTarget[];
  freeCash: FreeCash;
  live: LiveFreeCash | null;
  shelf: { total: number; byDate: string | null; bills: ExpectedBill[] };
  pace: EffectivePace;
  reasons: PlanReason[];
  narration: NarrationProvenance | null;
  swapUsed: boolean;
};

export type AnchorGradeView = {
  periodId: string;
  period: { start: string; end: string };
  results: TargetResult[];
  lines: string[];
  improvements: string | null;
  moneyCommitOutcome: TargetOutcome | null;
  billOverrunTotal: number;
  narration: NarrationProvenance | null;
};

export type AnchorPeriodView = {
  id: string;
  start: string;
  end: string;
  trigger: GameplanPeriod['trigger'];
  anchorMode: GameplanPeriod['anchorMode'];
  status: GameplanPeriod['status'];
  firstPeriod: boolean;
  openingPaycheck: number | null;
  anchorReadyAt: string | null;
  anchorOpenedAt: string | null;
  swapUsed: boolean;
  awarenessCompletedAt: string | null;
};

export type AnchorResponse = {
  status: 'no_period' | 'building' | 'ready';
  period: AnchorPeriodView | null;
  plan: AnchorPlanView | null;
  previousGrade: AnchorGradeView | null;
  /** Two silent anchors: the next touch is a question, not a plan (cadence note §6). */
  reengage: boolean;
  settings: AnchorSettings;
};

function periodView(period: GameplanPeriod): AnchorPeriodView {
  return {
    id: period.id,
    start: period.start,
    end: period.end,
    trigger: period.trigger,
    anchorMode: period.anchorMode,
    status: period.status,
    firstPeriod: period.firstPeriod,
    openingPaycheck: period.openingPaycheck,
    anchorReadyAt: period.anchorReadyAt,
    anchorOpenedAt: period.anchorOpenedAt,
    swapUsed: period.swapUsed,
    awarenessCompletedAt: period.awarenessCompletedAt,
  };
}

function targetView(target: StoredTarget, role: 'plan' | 'alternate'): AnchorTarget {
  return {
    id: target.candidateId,
    rank: target.rank,
    role,
    definition: target.definition,
    reasons: target.reasons,
    why: target.why,
    whySource: target.whySource,
  };
}

function planView(period: GameplanPeriod, shortlist: Shortlist, targets: StoredTarget[], live: LiveFreeCash | null): AnchorPlanView {
  return {
    targets: targets.filter((t) => t.role === 'plan').map((t) => targetView(t, 'plan')),
    alternates: targets.filter((t) => t.role === 'alternate').map((t) => targetView(t, 'alternate')),
    freeCash: shortlist.freeCash,
    live,
    shelf: { total: shortlist.shelf.total, byDate: shortlist.shelf.earliestWindowStart, bills: shortlist.shelf.bills },
    pace: shortlist.pace,
    reasons: shortlist.reasons,
    narration: period.planNarration,
    swapUsed: period.swapUsed,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

/**
 * Free cash as it stands now (§2, "the shelf is live"): the opening figure
 * moves by what posted bills came in over or under their planning amounts,
 * and the cash check reads the balance against the bills still expected.
 */
export async function liveFreeCash(
  userId: string,
  period: GameplanPeriod,
  shortlist: Shortlist,
  targets: readonly TargetDefinition[],
  deps: Pick<AnchorDeps, 'loadData' | 'listTransactions' | 'now'>,
): Promise<LiveFreeCash | null> {
  try {
    const today = deps.now().toISOString().slice(0, 10);
    const [data, transactions] = await Promise.all([
      deps.loadData(userId),
      deps.listTransactions(userId, addDays(period.start, -LOOKBACK_DAYS)),
    ]);
    const actuals = buildActuals({
      period,
      through: today,
      targets,
      transactions,
      streams: data.streams,
      balanceAtClose: null,
      awarenessCompleted: false,
    });

    const planningOf = new Map(shortlist.shelf.bills.map((bill) => [bill.key, bill.planningAmount]));
    let delta = 0;
    const postedKeys = new Set<string>();
    for (const posted of actuals.postedBills) {
      const planning = planningOf.get(posted.key);
      if (planning === undefined) continue;
      delta += posted.amount - planning;
      postedKeys.add(posted.key);
    }

    const remainingShelf = round2(
      shortlist.shelf.bills.filter((bill) => !postedKeys.has(bill.key)).reduce((sum, bill) => sum + bill.shelfAmount, 0),
    );
    const balance = data.accounts.length > 0 ? summarizeBalances(data.accounts).availableToSpend : null;

    return {
      freeCash: round2(shortlist.freeCash.freeCash - delta),
      cashCheck: balance === null ? null : round2(balance - remainingShelf),
      postedBills: postedKeys.size,
      remainingShelf,
    };
  } catch (err) {
    logger.warn('live free cash unavailable', { userId, error: err instanceof Error ? err : String(err) });
    return null;
  }
}

async function previousGradeView(userId: string, db: Queryable): Promise<{ grade: AnchorGradeView | null; reengage: boolean }> {
  const closed = await listClosedPeriods(userId, 3, db);
  const reengage = silentAnchorStreak(closed) >= REENGAGE_AFTER_SILENT;
  const last = closed[0];
  if (!last) return { grade: null, reengage };

  const stored = await getGrade(last.period.id, 'final', db);
  if (!stored) return { grade: null, reengage };

  return {
    grade: {
      periodId: last.period.id,
      period: { start: last.period.start, end: last.period.end },
      results: stored.grade.results,
      lines: stored.lines,
      improvements: stored.improvements,
      moneyCommitOutcome: stored.grade.moneyCommitOutcome,
      billOverrunTotal: stored.grade.billOverrunTotal,
      narration: stored.narration,
    },
    reengage,
  };
}

/** Everything the anchor screen shows, in one read. */
export async function getAnchor(userId: string, depsOverride?: Partial<AnchorDeps>): Promise<AnchorResponse> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };

  const [period, settings, previous] = await Promise.all([
    getLivePeriod(userId, deps.db),
    getAnchorSettings(userId, deps.db),
    previousGradeView(userId, deps.db),
  ]);

  if (!period) {
    return { status: 'no_period', period: null, plan: null, previousGrade: previous.grade, reengage: previous.reengage, settings };
  }

  if (!period.plan) {
    return { status: 'building', period: periodView(period), plan: null, previousGrade: previous.grade, reengage: previous.reengage, settings };
  }

  const targets = await listTargets(period.id, deps.db);
  const live = await liveFreeCash(
    userId,
    period,
    period.plan,
    targets.filter((t) => t.role === 'plan').map((t) => t.definition),
    deps,
  );

  return {
    status: 'ready',
    period: periodView(period),
    plan: planView(period, period.plan, targets, live),
    previousGrade: previous.grade,
    reengage: previous.reengage,
    settings,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function requirePlan(userId: string, db: Queryable): Promise<GameplanPeriod & { plan: Shortlist }> {
  const period = await getLivePeriod(userId, db);
  if (!period) throw new GameplanError('No period is open yet', 409, 'NO_LIVE_PERIOD');
  if (!period.plan) throw new GameplanError('The plan is still being built', 409, 'PLAN_NOT_READY');
  return period as GameplanPeriod & { plan: Shortlist };
}

/** "Got it": the anchor was read and the period is open. Idempotent. */
export async function acknowledgeAnchor(
  userId: string,
  depsOverride?: Partial<AnchorDeps>,
): Promise<{ periodId: string; status: GameplanPeriod['status']; anchorOpenedAt: string | null }> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  const period = await getLivePeriod(userId, deps.db);
  if (!period) throw new GameplanError('No period is open yet', 409, 'NO_LIVE_PERIOD');

  await markAnchorOpened(period.id, deps.now(), deps.db);
  const updated = await getLivePeriod(userId, deps.db);
  return { periodId: period.id, status: updated?.status ?? 'open', anchorOpenedAt: updated?.anchorOpenedAt ?? null };
}

export type SwapInput = { outId: string; inId: string };

export type PlanChangeResult = {
  plan: AnchorPlanView;
  diff: PlanDiffEntry[];
};

/** Exchange one plan target for one alternate, once per period (cadence note §5). */
export async function swapAnchorTarget(
  userId: string,
  input: SwapInput,
  depsOverride?: Partial<AnchorDeps>,
): Promise<PlanChangeResult> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  const period = await requirePlan(userId, deps.db);

  if (period.swapUsed) throw new GameplanError('One swap per period', 409, 'SWAP_ALREADY_USED');

  const before = period.plan;
  const after = swapTarget(before, input.outId, input.inId);
  if (after === before) {
    throw new GameplanError('That swap is not available', 422, 'INVALID_SWAP');
  }

  const targets = await listTargets(period.id, deps.db);
  const why: Record<string, string> = {};
  for (const target of targets) if (target.why) why[target.candidateId] = target.why;

  await savePlan(
    period.id,
    userId,
    after,
    {
      why,
      source: period.planNarration?.source ?? 'template',
      fallbackReason: period.planNarration?.fallbackReason ?? null,
      model: period.planNarration?.model ?? null,
    },
    deps.db,
  );
  await markSwapUsed(period.id, deps.db);

  const diff = diffPlans(before, after);
  await insertRevision(
    {
      periodId: period.id,
      userId,
      kind: 'swap',
      reasonText: null,
      adjustment: { outId: input.outId, inId: input.inId },
      before,
      after,
      diff,
      reply: null,
      replySource: null,
    },
    deps.db,
  );

  logger.info('anchor target swapped', { userId, periodId: period.id, outId: input.outId, inId: input.inId });

  const updated = await getLivePeriod(userId, deps.db);
  const refreshed = await listTargets(period.id, deps.db);
  return { plan: planView(updated ?? period, after, refreshed, null), diff };
}

function categoriesOf(data: FactsData, today: string): string[] {
  return computeFinancialFacts(data, today).spend.categoryTotals.map((entry) => entry.bucket);
}

export type HeadsUpParseResult = {
  adjustment: Adjustment | null;
  /** True for cost, income change and bill change: the amount box follows (§5a). */
  needsAmount: boolean;
  /** The model's extraction, shown as a proposal the user confirms or edits. */
  proposedAmount: number | null;
  amountDropped: boolean;
  problems: string[];
  source: 'model' | 'none';
  fallbackReason: NarrationFallbackReason | null;
};

/** Step one of a heads-up: the line becomes a structured proposal. Nothing is applied. */
export async function parseHeadsUp(
  userId: string,
  text: string,
  depsOverride?: Partial<AnchorDeps>,
): Promise<HeadsUpParseResult> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  const period = await requirePlan(userId, deps.db);
  const today = deps.now().toISOString().slice(0, 10);

  const data = await deps.loadData(userId);
  const vocabulary = vocabularyFor(period.plan, categoriesOf(data, today));
  const parsed = await deps.provider.parseAdjustment(text, vocabulary);

  return {
    adjustment: parsed.adjustment,
    needsAmount: parsed.adjustment !== null && AMOUNT_KINDS.has(parsed.adjustment.kind),
    proposedAmount: parsed.adjustment?.amount ?? null,
    amountDropped: parsed.amountDropped,
    problems: parsed.problems,
    source: parsed.source,
    fallbackReason: parsed.fallbackReason,
  };
}

export type HeadsUpInput = {
  text: string;
  adjustment: {
    kind: AdjustmentKind;
    affectedCategory: string | null;
    affectedStream: string | null;
    timing: { start: string; end: string } | null;
  };
  /** What the user confirmed in the box; null when skipped (§5a). */
  amount: number | null;
};

export type HeadsUpResult = {
  outcome: AdjustmentOutcome;
  applied: boolean;
  reply: string;
  replySource: NarrationSource;
  diff: PlanDiffEntry[];
  plan: AnchorPlanView;
};

async function storeReflection(
  userId: string,
  periodId: string | null,
  kind: 'got_in_the_way' | 'heads_up' | 'whats_been_hard',
  text: string,
  attribution: 'one_off' | 'structural' | null,
  deps: AnchorDeps,
): Promise<string> {
  const id = await insertReflection({ userId, periodId, kind, text, attribution }, deps.db);
  try {
    await deps.embed({ userId, text, source: REFLECTION_EMBEDDING_SOURCE });
    await markReflectionEmbedded(id, deps.db);
  } catch (err) {
    logger.warn('reflection embedding failed; text kept', { userId, kind, error: err instanceof Error ? err : String(err) });
  }
  return id;
}

/**
 * Step two of a heads-up: the record plus the confirmed amount go through
 * the engine's yield order, the plan is re-narrated, the diff is narrated,
 * and the line is kept as context either way. A skipped box applies
 * nothing and the reply says so.
 */
export async function applyHeadsUp(
  userId: string,
  input: HeadsUpInput,
  depsOverride?: Partial<AnchorDeps>,
): Promise<HeadsUpResult> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  const period = await requirePlan(userId, deps.db);

  const shortlistInput = await assembleShortlistInput(period, deps);
  const vocabulary = vocabularyFor(period.plan, shortlistInput.facts.spend.categoryTotals.map((c) => c.bucket));
  const validated = validateAdjustment({ ...input.adjustment, amount: input.amount, text: input.text }, vocabulary);
  if (!validated) throw new GameplanError('That heads-up could not be understood', 422, 'INVALID_ADJUSTMENT');

  const result = applyAdjustment(shortlistInput, validated.adjustment);
  await storeReflection(userId, period.id, 'heads_up', input.text, null, deps);

  let after = result.after;

  if (result.applied) {
    await updateHeadsUp(
      period.id,
      {
        oneTimeCosts: result.input.oneTimeCosts,
        billOverrides: result.input.billOverrides,
        relaxedBuckets: result.input.relaxedBuckets,
        incomeAdjustment: result.input.incomeAdjustment,
      },
      deps.db,
    );

    // A swap made earlier this period survives the rebuild when both
    // targets still exist.
    const swap = await getLastSwap(period.id, deps.db);
    if (swap) after = swapTarget(after, swap.outId, swap.inId);

    const narration = await deps.provider.explain({ kind: 'plan', shortlist: after });
    await savePlan(
      period.id,
      userId,
      after,
      { why: narration.output.why, source: narration.source, fallbackReason: narration.fallbackReason, model: narration.model },
      deps.db,
    );
  }

  const reply = await deps.provider.explain({ kind: 'diff', result, adjustment: validated.adjustment });

  await insertRevision(
    {
      periodId: period.id,
      userId,
      kind: 'heads_up',
      reasonText: input.text,
      adjustment: validated.adjustment,
      before: result.before,
      after,
      diff: result.diff,
      reply: reply.output.reply,
      replySource: reply.source,
    },
    deps.db,
  );

  logger.info('heads-up applied', {
    userId,
    periodId: period.id,
    kind: validated.adjustment.kind,
    outcome: result.outcome,
    applied: result.applied,
    replySource: reply.source,
  });

  const updated = await getLivePeriod(userId, deps.db);
  const targets = await listTargets(period.id, deps.db);
  return {
    outcome: result.outcome,
    applied: result.applied,
    reply: reply.output.reply,
    replySource: reply.source,
    diff: result.diff,
    plan: planView(updated ?? period, after, targets, null),
  };
}

export type ReflectionInput = {
  kind: 'got_in_the_way' | 'whats_been_hard';
  text: string;
  /** Optional explicit attribution; otherwise the port reads it from the text. */
  category?: string | null;
  start?: string | null;
  end?: string | null;
  structural?: boolean;
};

export type ReflectionResult = {
  id: string;
  periodId: string | null;
  kind: ReflectionInput['kind'];
  attribution: 'one_off' | 'structural' | null;
  /** For got_in_the_way: the named category inside the named dates, summed by the engine (§5). */
  attributed: { category: string; start: string; end: string; amount: number; periodAmount: number } | null;
};

/**
 * "What got in the way?" and "what's been hard?": stored and embedded for
 * chat. For a miss, the engine sums the named category inside the named
 * dates; a named event makes the miss a one-off, anything else structural,
 * which decides how the next cap is set.
 */
export async function addReflection(
  userId: string,
  input: ReflectionInput,
  depsOverride?: Partial<AnchorDeps>,
): Promise<ReflectionResult> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  const today = deps.now().toISOString().slice(0, 10);

  if (input.kind === 'whats_been_hard') {
    const live = await getLivePeriod(userId, deps.db);
    const id = await storeReflection(userId, live?.id ?? null, 'whats_been_hard', input.text, null, deps);
    return { id, periodId: live?.id ?? null, kind: input.kind, attribution: null, attributed: null };
  }

  const [last] = await listClosedPeriods(userId, 1, deps.db);
  const periodId = last?.period.id ?? null;

  let category = input.category ?? null;
  let start = input.start ?? null;
  let end = input.end ?? null;

  if (!input.structural && category === null && last?.period.plan) {
    const data = await deps.loadData(userId);
    const vocabulary = vocabularyFor(last.period.plan, categoriesOf(data, today));
    vocabulary.period = { start: last.period.start, end: last.period.end, trigger: last.period.trigger };
    const parsed = await deps.provider.parseAdjustment(input.text, vocabulary);
    if (parsed.adjustment && (parsed.adjustment.kind === 'spend_event' || parsed.adjustment.kind === 'cost')) {
      category = parsed.adjustment.affectedCategory;
      start = parsed.adjustment.timing?.start ?? null;
      end = parsed.adjustment.timing?.end ?? null;
    }
  }

  let attributed: ReflectionResult['attributed'] = null;
  let attribution: 'one_off' | 'structural' = 'structural';

  if (!input.structural && category !== null && last) {
    const from = start ?? last.period.start;
    const to = end ?? last.period.end;
    const transactions = await deps.listTransactions(userId, last.period.start);
    const inBucket = transactions.filter(
      (txn) => !txn.pending && txn.amount > 0 && txn.role === 'expense' && txn.displayBucket === category,
    );
    const within = (date: string, a: string, b: string) => dayNumber(date) >= dayNumber(a) && dayNumber(date) <= dayNumber(b);
    const amount = round2(inBucket.filter((txn) => within(txn.date, from, to)).reduce((s, t) => s + t.amount, 0));
    const periodAmount = round2(
      inBucket.filter((txn) => within(txn.date, last.period.start, last.period.end)).reduce((s, t) => s + t.amount, 0),
    );
    attributed = { category, start: from, end: to, amount, periodAmount };
    attribution = 'one_off';
  }

  const id = await storeReflection(userId, periodId, 'got_in_the_way', input.text, attribution, deps);
  return { id, periodId, kind: input.kind, attribution, attributed };
}

/** The awareness target was done (tagged, looked at, decided). */
export async function completeAwareness(
  userId: string,
  depsOverride?: Partial<AnchorDeps>,
): Promise<{ periodId: string; awarenessCompletedAt: string | null }> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  const period = await getLivePeriod(userId, deps.db);
  if (!period) throw new GameplanError('No period is open yet', 409, 'NO_LIVE_PERIOD');
  await markAwarenessCompleted(period.id, deps.now(), deps.db);
  const updated = await getLivePeriod(userId, deps.db);
  return { periodId: period.id, awarenessCompletedAt: updated?.awarenessCompletedAt ?? null };
}

export type SettingsResult = { settings: AnchorSettings; effectiveFrom: 'next_period' };

export async function getSettings(userId: string, depsOverride?: Partial<AnchorDeps>): Promise<SettingsResult> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  return { settings: await getAnchorSettings(userId, deps.db), effectiveFrom: 'next_period' };
}

/** Anchor settings change the next period, never the one under way. */
export async function updateSettings(
  userId: string,
  patch: Partial<AnchorSettings>,
  depsOverride?: Partial<AnchorDeps>,
): Promise<SettingsResult> {
  const deps: AnchorDeps = { ...(await defaultDeps()), ...depsOverride };
  return { settings: await updateAnchorSettings(userId, patch, deps.db), effectiveFrom: 'next_period' };
}
