/**
 * Periods and anchors (cadence note §2, §6): which day a user's loop turns
 * on, the bounds of each period, when a close, a mid-period grade or a
 * reminder is due, and the scheduler that fires them. The period math is
 * pure; the scheduler and the openers take injected deps so the e2e suite
 * can run them against real Postgres without a queue.
 */

import { addDays, dayNumber, daysBetween } from '../lib/dates.js';
import { logger } from '../lib/logger.js';
import { isStreamStale } from '../lib/streams.js';
import { nextExpectedDate } from '../gameplan/expected-bills.js';
import { isIncomeStream, streamMonthlyAmount } from '../gameplan/free-cash.js';
import type { Period } from '../gameplan/types.js';
import type { FactsRecurringStream } from '../types/financial-facts.js';
import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { loadFactsData } from './financial-facts.service.js';
import { getLatestRun } from './onboarding-lifecycle.service.js';
import {
  getAnchorSettings,
  getLivePeriod,
  insertPeriod,
  listConfirmedUsersWithoutPeriod,
  listLivePeriods,
  markReminderSent,
  type AnchorSettings,
  type GameplanPeriod,
} from './gameplan-store.service.js';

/** A first period shorter than this merges into the next full one (cadence note §2). */
export const MIN_FIRST_PERIOD_DAYS = 4;
/** Payday users: the anchor runs anyway this many days after the expected payday. */
export const PAYDAY_FALLBACK_GRACE_DAYS = 2;
/** Periods at least this long get a mid-period grade (semi-monthly and monthly pay). */
export const MID_PERIOD_GRADE_MIN_DAYS = 21;
/** Hour of day (server clock) each preference maps to. */
export const ANCHOR_HOURS: Record<AnchorSettings['anchorTimeOfDay'], number> = {
  morning: 8,
  midday: 12,
  evening: 18,
};
/** A missed anchor gets one reminder the next morning at this hour. */
export const REMINDER_HOUR = 8;

/** Cadences stable enough to anchor a period on. */
const STABLE_CADENCES: ReadonlySet<string> = new Set(['weekly', 'biweekly', 'monthly']);

export type AnchorDetection =
  | {
      mode: 'payday';
      stream: FactsRecurringStream;
      nextExpectedPayday: string;
      basis: 'detected' | 'setting';
    }
  | {
      mode: 'fixed_day';
      anchorDay: number;
      basis: 'setting' | 'no_stable_stream';
    };

/**
 * The primary income stream: the largest income stream with a stable
 * cadence that has not gone stale. Secondary streams never open a period.
 */
export function primaryIncomeStream(
  streams: readonly FactsRecurringStream[],
  today: string,
): FactsRecurringStream | null {
  let best: FactsRecurringStream | null = null;
  let bestMonthly = 0;

  for (const stream of streams) {
    if (!isIncomeStream(stream) || !STABLE_CADENCES.has(stream.cadence)) continue;
    if (isStreamStale(stream, today)) continue;
    const monthly = streamMonthlyAmount(stream.averageAmount, stream.cadenceDays);
    if (monthly > bestMonthly) {
      best = stream;
      bestMonthly = monthly;
    }
  }

  return best;
}

/** Payday when a stable income stream exists (or the user chose it and one exists); otherwise the fixed day. */
export function detectAnchor(
  streams: readonly FactsRecurringStream[],
  settings: AnchorSettings,
  today: string,
): AnchorDetection {
  if (settings.anchorMode === 'fixed_day') {
    return { mode: 'fixed_day', anchorDay: settings.anchorDay, basis: 'setting' };
  }

  const stream = primaryIncomeStream(streams, today);
  if (stream) {
    return {
      mode: 'payday',
      stream,
      nextExpectedPayday: nextExpectedDate(stream),
      basis: settings.anchorMode === 'payday' ? 'setting' : 'detected',
    };
  }

  return { mode: 'fixed_day', anchorDay: settings.anchorDay, basis: 'no_stable_stream' };
}

/** The next occurrence of a weekday (0 = Sunday) strictly after `iso`. */
export function nextWeekday(iso: string, weekday: number): string {
  const current = new Date(`${iso}T00:00:00Z`).getUTCDay();
  const ahead = ((weekday - current + 7) % 7) || 7;
  return addDays(iso, ahead);
}

/**
 * The end of a period that starts on `start`: the day before the next
 * expected payday, or the day before the next anchor day.
 */
export function periodEnd(anchor: AnchorDetection, start: string): string {
  if (anchor.mode === 'payday') {
    // The next payday after the one that opened this period.
    const next = nextExpectedDate({ ...anchor.stream, lastDate: start });
    const end = addDays(next, -1);
    if (dayNumber(end) >= dayNumber(start)) return end;
    return addDays(start, Math.max(6, Math.round(anchor.stream.cadenceDays) - 1));
  }

  return addDays(nextWeekday(start, anchor.anchorDay), -1);
}

/**
 * The first period runs from review confirmation to the next boundary —
 * the day before the stream's next expected payday, or the next anchor
 * day; under four days away it merges into the following full period.
 * Confirmation day is not a payday, so the payday boundary comes from the
 * stream's own history rather than from the start date.
 */
export function firstPeriodBounds(anchor: AnchorDetection, today: string): Period {
  let end =
    anchor.mode === 'payday' ? addDays(anchor.nextExpectedPayday, -1) : periodEnd(anchor, today);

  for (let guard = 0; guard < 6 && daysBetween(today, end) + 1 < MIN_FIRST_PERIOD_DAYS; guard += 1) {
    end = periodEnd(anchor, addDays(end, 1));
  }

  return { start: today, end, trigger: 'first' };
}

/** When the final grade is due: payday users get the fallback grace; fixed-day users grade on the anchor day. */
export function closeDueDate(period: Pick<GameplanPeriod, 'end' | 'anchorMode'>): string {
  return period.anchorMode === 'payday'
    ? addDays(period.end, 1 + PAYDAY_FALLBACK_GRACE_DAYS)
    : addDays(period.end, 1);
}

/** Long pay periods get a lightweight grade halfway through (cadence note §2). */
export function midPeriodDueDate(period: Pick<GameplanPeriod, 'start' | 'end'>): string | null {
  const length = daysBetween(period.start, period.end) + 1;
  if (length < MID_PERIOD_GRADE_MIN_DAYS) return null;
  return addDays(period.start, Math.floor(length / 2));
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** True once the clock has reached `hour` on `date` (server time). */
function reached(now: Date, date: string, hour: number): boolean {
  const today = isoDate(now);
  if (dayNumber(today) > dayNumber(date)) return true;
  if (dayNumber(today) < dayNumber(date)) return false;
  return now.getUTCHours() >= hour;
}

export type DueAction = 'final_grade' | 'mid_period_grade' | 'reminder';

/** What the scheduler should do for a live period right now. */
export function dueActions(
  period: GameplanPeriod,
  settings: AnchorSettings,
  now: Date,
): DueAction[] {
  const actions: DueAction[] = [];
  const hour = ANCHOR_HOURS[settings.anchorTimeOfDay];

  if (reached(now, closeDueDate(period), hour)) {
    actions.push('final_grade');
    return actions;
  }

  const midpoint = midPeriodDueDate(period);
  if (midpoint && period.midPeriodGradedAt === null && reached(now, midpoint, hour)) {
    actions.push('mid_period_grade');
  }

  if (
    period.status === 'planned' &&
    period.anchorReadyAt !== null &&
    period.reminderSentAt === null &&
    reached(now, addDays(period.anchorReadyAt.slice(0, 10), 1), REMINDER_HOUR)
  ) {
    actions.push('reminder');
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Opening periods
// ---------------------------------------------------------------------------

export type PeriodDeps = {
  db: Queryable;
  loadStreams(userId: string): Promise<FactsRecurringStream[]>;
  enqueueBuild(payload: { userId: string; periodId: string }): Promise<unknown>;
  enqueueGrade(payload: {
    userId: string;
    periodId: string;
    kind: 'mid_period' | 'final';
    reason: 'payday' | 'schedule' | 'fallback';
  }): Promise<unknown>;
  sendReminder(period: GameplanPeriod): Promise<unknown>;
  now(): Date;
};

async function defaultDeps(): Promise<PeriodDeps> {
  const [enqueue, push] = await Promise.all([
    import('../jobs/enqueue.js'),
    import('./gameplan-push.service.js'),
  ]);

  return {
    db: pool,
    loadStreams: async (userId) => (await loadFactsData(userId)).streams,
    enqueueBuild: (payload) => enqueue.enqueueBuildGameplan(payload),
    enqueueGrade: (payload) => enqueue.enqueueGradePeriod(payload),
    sendReminder: (period) =>
      push.sendGameplanPush({
        userId: period.userId,
        periodId: period.id,
        notificationKey: `reminder:${period.id}`,
        type: push.GAMEPLAN_PUSH.reminder,
        body: 'Your plan for this period is waiting.',
      }),
    now: () => new Date(),
  };
}

/**
 * Open the first period at review confirmation (cadence note §2). Idempotent:
 * a user with a live period gets nothing new. Best-effort by design — the
 * caller's confirmation must not fail because a period could not open, and
 * the scheduler opens one later for any finished user without it.
 */
export async function openFirstPeriod(
  userId: string,
  depsOverride?: Partial<PeriodDeps>,
): Promise<GameplanPeriod | null> {
  const deps: PeriodDeps = { ...(await defaultDeps()), ...depsOverride };

  const existing = await getLivePeriod(userId, deps.db);
  if (existing) return existing;

  const latest = await getLatestRun(userId, deps.db);
  if (latest?.status !== 'confirmed') return null;

  const today = isoDate(deps.now());
  const [streams, settings] = await Promise.all([deps.loadStreams(userId), getAnchorSettings(userId, deps.db)]);
  const anchor = detectAnchor(streams, settings, today);
  const bounds = firstPeriodBounds(anchor, today);

  const period = await insertPeriod(
    {
      userId,
      start: bounds.start,
      end: bounds.end,
      trigger: 'first',
      anchorMode: anchor.mode,
      firstPeriod: true,
      openingPaycheck: null,
      primaryIncomeStreamKey: anchor.mode === 'payday' ? anchor.stream.streamKey : null,
    },
    deps.db,
  );

  logger.info('first gameplan period opened', {
    userId,
    periodId: period.id,
    start: period.start,
    end: period.end,
    anchorMode: period.anchorMode,
  });

  await deps.enqueueBuild({ userId, periodId: period.id });
  return period;
}

export type RolloverInput = {
  closed: GameplanPeriod;
  reason: 'payday' | 'schedule' | 'fallback';
  paydayDate?: string;
  paydayAmount?: number;
};

/**
 * Open the period that follows a closed one. A detected payday starts it
 * on the posting date with that paycheck; the anchor day starts it the day
 * after the last one ended; the payday fallback starts it today, since the
 * expected paycheck never came and the plan must say so.
 */
export async function rolloverPeriod(
  input: RolloverInput,
  depsOverride?: Partial<PeriodDeps>,
): Promise<GameplanPeriod> {
  const deps: PeriodDeps = { ...(await defaultDeps()), ...depsOverride };
  const { closed } = input;
  const today = isoDate(deps.now());

  const [streams, settings] = await Promise.all([
    deps.loadStreams(closed.userId),
    getAnchorSettings(closed.userId, deps.db),
  ]);
  const anchor = detectAnchor(streams, settings, today);

  let start: string;
  if (input.reason === 'payday' && input.paydayDate) {
    start = input.paydayDate;
  } else if (input.reason === 'fallback') {
    start = today;
  } else {
    start = addDays(closed.end, 1);
  }
  if (dayNumber(start) <= dayNumber(closed.end) && input.reason !== 'payday') {
    start = addDays(closed.end, 1);
  }

  const period = await insertPeriod(
    {
      userId: closed.userId,
      start,
      end: periodEnd(anchor, start),
      trigger: anchor.mode === 'payday' && input.reason === 'payday' ? 'payday' : anchor.mode === 'payday' ? 'payday' : 'fixed_day',
      anchorMode: anchor.mode,
      firstPeriod: false,
      openingPaycheck: input.reason === 'payday' ? (input.paydayAmount ?? null) : null,
      primaryIncomeStreamKey: anchor.mode === 'payday' ? anchor.stream.streamKey : null,
    },
    deps.db,
  );

  logger.info('gameplan period rolled over', {
    userId: closed.userId,
    closedPeriodId: closed.id,
    periodId: period.id,
    reason: input.reason,
    start: period.start,
    end: period.end,
    anchorMode: period.anchorMode,
  });

  await deps.enqueueBuild({ userId: closed.userId, periodId: period.id });
  return period;
}

// ---------------------------------------------------------------------------
// Scheduler (RUN_GAMEPLAN_SCHEDULER, hourly)
// ---------------------------------------------------------------------------

export type SchedulerResult = { finalGrades: number; midPeriodGrades: number; reminders: number; opened: number };

/**
 * Walk every live period and fire what is due: the final grade on the
 * anchor day (or the payday fallback), the mid-period grade for long
 * periods, the one reminder for a missed anchor. Finished users with no
 * live period get their first one.
 */
export async function runGameplanScheduler(depsOverride?: Partial<PeriodDeps>): Promise<SchedulerResult> {
  const deps: PeriodDeps = { ...(await defaultDeps()), ...depsOverride };
  const now = deps.now();
  const result: SchedulerResult = { finalGrades: 0, midPeriodGrades: 0, reminders: 0, opened: 0 };

  for (const period of await listLivePeriods(deps.db)) {
    const settings = await getAnchorSettings(period.userId, deps.db);

    for (const action of dueActions(period, settings, now)) {
      if (action === 'final_grade') {
        await deps.enqueueGrade({
          userId: period.userId,
          periodId: period.id,
          kind: 'final',
          reason: period.anchorMode === 'payday' ? 'fallback' : 'schedule',
        });
        result.finalGrades += 1;
      } else if (action === 'mid_period_grade') {
        await deps.enqueueGrade({ userId: period.userId, periodId: period.id, kind: 'mid_period', reason: 'schedule' });
        result.midPeriodGrades += 1;
      } else {
        await deps.sendReminder(period);
        await markReminderSent(period.id, now, deps.db);
        result.reminders += 1;
      }
    }
  }

  for (const userId of await listConfirmedUsersWithoutPeriod(deps.db)) {
    const opened = await openFirstPeriod(userId, deps);
    if (opened) result.opened += 1;
  }

  return result;
}
