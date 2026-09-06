/**
 * BUILD_GAMEPLAN: assemble the engine's input from the database, build the
 * shortlist, have the port narrate it, store both, and tell the user the
 * anchor is ready. Also the place a heads-up or swap rebuilds from, since
 * `assembleShortlistInput` reads the period's stored heads-up state.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import { buildShortlist } from '../gameplan/candidates.js';
import type { PlanHistory, PlannerProfile, ShortlistInput, TargetOutcome } from '../gameplan/types.js';
import type { LlmProvider } from '../llm/types.js';
import { llmProviderFromEnv } from '../llm/provider.js';
import type { CoachingPace, GoalDetail, PrimaryGoal, SecondaryGoal } from '../types/manual-profile.js';
import { computeFinancialFacts, loadFactsData, type FactsData } from './financial-facts.service.js';
import {
  getAccruals,
  getPeriod,
  listClosedPeriods,
  listReflections,
  markAnchorReady,
  savePlan,
  type ClosedPeriodSummary,
  type GameplanPeriod,
} from './gameplan-store.service.js';
import { GAMEPLAN_PUSH, sendGameplanPush, type GameplanPushInput } from './gameplan-push.service.js';

/** How many closed periods feed pace and history. */
const HISTORY_PERIODS = 8;
/** Silent anchors before the next touch becomes a question (cadence note §6). */
export const REENGAGE_AFTER_SILENT = 2;
/** Silent anchors after which only the payday anchor keeps arriving. */
export const QUIET_AFTER_SILENT = 3;

export type BuildDeps = {
  db: Queryable;
  loadData(userId: string): Promise<FactsData>;
  provider: LlmProvider;
  sendPush(input: GameplanPushInput): Promise<unknown>;
  now(): Date;
};

async function defaultDeps(): Promise<BuildDeps> {
  return {
    db: pool,
    loadData: (userId) => loadFactsData(userId),
    provider: llmProviderFromEnv(),
    sendPush: (input) => sendGameplanPush(input),
    now: () => new Date(),
  };
}

const DEFAULT_PROFILE: PlannerProfile = {
  primaryGoal: 'not_sure',
  secondaryGoals: [],
  coachingPace: 'balanced',
  sharedAccounts: false,
  goalDetail: null,
};

/** The profile fields the planner reads, from user_info. */
export async function loadPlannerProfile(userId: string, db: Queryable = pool): Promise<PlannerProfile> {
  const { rows } = await db.query<{
    primary_goal: PrimaryGoal;
    secondary_goals: SecondaryGoal[];
    coaching_pace: CoachingPace;
    shared_accounts: boolean;
    goal_detail: GoalDetail | null;
  }>(
    `SELECT primary_goal, secondary_goals, coaching_pace, shared_accounts, goal_detail
     FROM user_info WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return DEFAULT_PROFILE;

  return {
    primaryGoal: row.primary_goal,
    secondaryGoals: row.secondary_goals ?? [],
    coachingPace: row.coaching_pace,
    sharedAccounts: row.shared_accounts,
    goalDetail: row.goal_detail,
  };
}

/** Consecutive most-recent closed periods whose anchor was never opened. */
export function silentAnchorStreak(closed: readonly ClosedPeriodSummary[]): number {
  let streak = 0;
  for (const entry of closed) {
    if (entry.period.anchorOpenedAt !== null) break;
    streak += 1;
  }
  return streak;
}

/** What the last grades teach the next plan (§3, §5, §9). */
export async function loadPlanHistory(
  userId: string,
  primaryGoal: PrimaryGoal,
  db: Queryable,
): Promise<{ history: PlanHistory; closed: ClosedPeriodSummary[] }> {
  const closed = await listClosedPeriods(userId, HISTORY_PERIODS, db);

  const moneyCommitOutcomes: TargetOutcome[] = [];
  for (const entry of [...closed].reverse()) {
    if (entry.finalGrade?.moneyCommitOutcome) moneyCommitOutcomes.push(entry.finalGrade.moneyCommitOutcome);
  }

  const missedCaps: PlanHistory['missedCaps'] = [];
  const last = closed[0];
  if (last?.finalGrade) {
    // A "what got in the way?" line marks the miss a one-off; silence, or a
    // line judged structural, re-sets the cap from what was spent (§5).
    const reflections = await listReflections(last.period.id, db);
    const explanation = reflections.find((entry) => entry.kind === 'got_in_the_way');
    const attribution: 'one_off' | 'structural' =
      explanation && explanation.attribution !== 'structural' ? 'one_off' : 'structural';

    for (const result of last.finalGrade.results) {
      if (result.target.type !== 'spend_cap' || result.outcome !== 'missed') continue;
      const over = result.details.find((detail) => detail.code === 'over_by');
      const observed = over && over.code === 'over_by' ? over.measured : result.target.cap;
      missedCaps.push({ bucket: result.target.bucket, observed, attribution });
    }
  }

  return {
    history: {
      moneyCommitOutcomes,
      missedCaps,
      discoveryPeriodsDone: primaryGoal === 'not_sure' ? closed.length : 0,
    },
    closed,
  };
}

/** Everything the engine needs for a period, read from the database. */
export async function assembleShortlistInput(
  period: GameplanPeriod,
  deps: Pick<BuildDeps, 'db' | 'loadData' | 'now'>,
): Promise<ShortlistInput> {
  const today = deps.now().toISOString().slice(0, 10);
  const [data, profile, accruedToDate] = await Promise.all([
    deps.loadData(period.userId),
    loadPlannerProfile(period.userId, deps.db),
    getAccruals(period.userId, deps.db),
  ]);
  const { history } = await loadPlanHistory(period.userId, profile.primaryGoal, deps.db);
  const facts = computeFinancialFacts(data, today);

  return {
    facts,
    streams: data.streams,
    declaredObligations: data.declaredObligations,
    profile,
    period: { start: period.start, end: period.end, trigger: period.trigger },
    today,
    openingPaycheck: period.openingPaycheck,
    primaryIncomeStreamKey: period.primaryIncomeStreamKey,
    firstPeriod: period.firstPeriod,
    history,
    accruedToDate,
    oneTimeCosts: period.headsUp.oneTimeCosts,
    billOverrides: period.headsUp.billOverrides,
    relaxedBuckets: period.headsUp.relaxedBuckets,
    incomeAdjustment: period.headsUp.incomeAdjustment,
  };
}

export type BuildResult = { status: 'built' | 'skipped'; periodId: string; pushed: boolean };

export async function buildGameplan(
  payload: { userId: string; periodId: string },
  depsOverride?: Partial<BuildDeps>,
): Promise<BuildResult> {
  const deps: BuildDeps = { ...(await defaultDeps()), ...depsOverride };

  const period = await getPeriod(payload.periodId, deps.db);
  if (!period || period.userId !== payload.userId || period.status === 'closed') {
    logger.info('gameplan build skipped', { periodId: payload.periodId, status: period?.status ?? 'missing' });
    return { status: 'skipped', periodId: payload.periodId, pushed: false };
  }

  const input = await assembleShortlistInput(period, deps);
  const shortlist = buildShortlist(input);
  const narration = await deps.provider.explain({ kind: 'plan', shortlist });

  await savePlan(
    period.id,
    period.userId,
    shortlist,
    {
      why: narration.output.why,
      source: narration.source,
      fallbackReason: narration.fallbackReason,
      model: narration.model,
    },
    deps.db,
  );

  const firstBuild = period.anchorReadyAt === null;
  const now = deps.now();
  await markAnchorReady(period.id, now, deps.db);

  logger.info('gameplan built', {
    userId: period.userId,
    periodId: period.id,
    targets: shortlist.plan.map((candidate) => candidate.id),
    freeCash: shortlist.freeCash.freeCash,
    shelf: shortlist.shelf.total,
    narrationSource: narration.source,
    fallbackReason: narration.fallbackReason,
  });

  // A rebuild (heads-up, swap) never re-announces the anchor.
  if (!firstBuild) return { status: 'built', periodId: period.id, pushed: false };

  const { closed } = await loadPlanHistory(period.userId, input.profile.primaryGoal, deps.db);
  const silent = silentAnchorStreak(closed);

  // Three silent anchors: quiet, except the payday anchor, which stays
  // relevant (cadence note §6).
  if (silent >= QUIET_AFTER_SILENT && period.anchorMode !== 'payday') {
    return { status: 'built', periodId: period.id, pushed: false };
  }

  const reengage = silent >= REENGAGE_AFTER_SILENT;
  await deps.sendPush({
    userId: period.userId,
    periodId: period.id,
    notificationKey: `anchor:${period.id}`,
    type: reengage ? GAMEPLAN_PUSH.reengage : GAMEPLAN_PUSH.anchorReady,
    body: reengage ? 'Want to slow down? Tell us what has been hard.' : 'Your plan for this period is ready.',
  });

  return { status: 'built', periodId: period.id, pushed: true };
}
