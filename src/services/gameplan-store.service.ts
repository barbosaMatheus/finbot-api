/**
 * Persistence for the weekly loop (gameplan step 4): periods, the targets
 * shown in each, revisions, grades, reflections, nudges, accruals and the
 * anchor settings. Every stored plan carries the engine's own JSON so a
 * grade replays from what the user saw.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import type {
  OneTimeCost,
  PeriodActuals,
  PeriodGrade,
  PlanDiffEntry,
  PlanReason,
  Shortlist,
  TargetDefinition,
} from '../gameplan/types.js';

export type PeriodStatus = 'planned' | 'open' | 'closed';
export type PeriodTrigger = 'payday' | 'fixed_day' | 'first';
export type AnchorMode = 'payday' | 'fixed_day';
export type CloseReason = 'payday' | 'schedule' | 'fallback';
export type NarrationSource = 'model' | 'template';

/** The heads-up state a plan is built with (engine input, persisted per period). */
export type HeadsUpState = {
  oneTimeCosts: OneTimeCost[];
  billOverrides: Record<string, number>;
  relaxedBuckets: string[];
  incomeAdjustment: number;
};

export const EMPTY_HEADS_UP: HeadsUpState = {
  oneTimeCosts: [],
  billOverrides: {},
  relaxedBuckets: [],
  incomeAdjustment: 0,
};

export type NarrationProvenance = {
  source: NarrationSource;
  fallbackReason: string | null;
  model: string | null;
};

export type GameplanPeriod = {
  id: string;
  userId: string;
  start: string;
  end: string;
  trigger: PeriodTrigger;
  anchorMode: AnchorMode;
  status: PeriodStatus;
  firstPeriod: boolean;
  openingPaycheck: number | null;
  primaryIncomeStreamKey: string | null;
  plan: Shortlist | null;
  planNarration: NarrationProvenance | null;
  headsUp: HeadsUpState;
  swapUsed: boolean;
  awarenessCompletedAt: string | null;
  anchorReadyAt: string | null;
  anchorOpenedAt: string | null;
  reminderSentAt: string | null;
  midPeriodGradedAt: string | null;
  closedAt: string | null;
  closeReason: CloseReason | null;
};

export type TargetRole = 'plan' | 'alternate' | 'swapped_out' | 'revised_out';

export type StoredTarget = {
  id: string;
  periodId: string;
  candidateId: string;
  rank: number;
  role: TargetRole;
  definition: TargetDefinition;
  reasons: PlanReason[];
  score: number | null;
  why: string | null;
  whySource: NarrationSource | null;
};

export type StoredGrade = {
  id: string;
  periodId: string;
  kind: 'mid_period' | 'final';
  grade: PeriodGrade;
  actuals: PeriodActuals;
  lines: string[];
  improvements: string | null;
  narration: NarrationProvenance | null;
  gradedThrough: string;
  createdAt: string;
};

export type ReflectionKind = 'got_in_the_way' | 'heads_up' | 'whats_been_hard';

export type StoredReflection = {
  id: string;
  periodId: string | null;
  kind: ReflectionKind;
  text: string;
  attribution: 'one_off' | 'structural' | null;
  createdAt: string;
};

export type AnchorSettings = {
  anchorMode: 'auto' | 'payday' | 'fixed_day';
  /** 0–6, Sunday = 0. */
  anchorDay: number;
  anchorTimeOfDay: 'morning' | 'midday' | 'evening';
};

export const DEFAULT_ANCHOR_SETTINGS: AnchorSettings = {
  anchorMode: 'auto',
  anchorDay: 0,
  anchorTimeOfDay: 'evening',
};

type PeriodRow = {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  trigger: PeriodTrigger;
  anchor_mode: AnchorMode;
  status: PeriodStatus;
  first_period: boolean;
  opening_paycheck: string | null;
  primary_income_stream_key: string | null;
  plan: Shortlist | null;
  plan_source: NarrationSource | null;
  plan_fallback_reason: string | null;
  plan_model: string | null;
  heads_up_state: Partial<HeadsUpState> | null;
  swap_used: boolean;
  awareness_completed_at: Date | null;
  anchor_ready_at: Date | null;
  anchor_opened_at: Date | null;
  reminder_sent_at: Date | null;
  mid_period_graded_at: Date | null;
  closed_at: Date | null;
  close_reason: CloseReason | null;
};

const PERIOD_COLUMNS = `id, user_id, start_date::text AS start_date, end_date::text AS end_date,
  trigger, anchor_mode, status, first_period, opening_paycheck::text AS opening_paycheck,
  primary_income_stream_key, plan, plan_source, plan_fallback_reason, plan_model,
  heads_up_state, swap_used, awareness_completed_at, anchor_ready_at, anchor_opened_at,
  reminder_sent_at, mid_period_graded_at, closed_at, close_reason`;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function headsUpFrom(raw: Partial<HeadsUpState> | null): HeadsUpState {
  return {
    oneTimeCosts: Array.isArray(raw?.oneTimeCosts) ? raw!.oneTimeCosts : [],
    billOverrides: raw?.billOverrides && typeof raw.billOverrides === 'object' ? raw.billOverrides : {},
    relaxedBuckets: Array.isArray(raw?.relaxedBuckets) ? raw!.relaxedBuckets : [],
    incomeAdjustment: typeof raw?.incomeAdjustment === 'number' ? raw.incomeAdjustment : 0,
  };
}

function toPeriod(row: PeriodRow): GameplanPeriod {
  return {
    id: row.id,
    userId: row.user_id,
    start: row.start_date,
    end: row.end_date,
    trigger: row.trigger,
    anchorMode: row.anchor_mode,
    status: row.status,
    firstPeriod: row.first_period,
    openingPaycheck: row.opening_paycheck === null ? null : Number(row.opening_paycheck),
    primaryIncomeStreamKey: row.primary_income_stream_key,
    plan: row.plan,
    planNarration: row.plan_source
      ? { source: row.plan_source, fallbackReason: row.plan_fallback_reason, model: row.plan_model }
      : null,
    headsUp: headsUpFrom(row.heads_up_state),
    swapUsed: row.swap_used,
    awarenessCompletedAt: iso(row.awareness_completed_at),
    anchorReadyAt: iso(row.anchor_ready_at),
    anchorOpenedAt: iso(row.anchor_opened_at),
    reminderSentAt: iso(row.reminder_sent_at),
    midPeriodGradedAt: iso(row.mid_period_graded_at),
    closedAt: iso(row.closed_at),
    closeReason: row.close_reason,
  };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The one period per user that is not closed, if any. */
export async function getLivePeriod(userId: string, db: Queryable = pool): Promise<GameplanPeriod | null> {
  const { rows } = await db.query<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM gameplan_periods WHERE user_id = $1 AND status <> 'closed' LIMIT 1`,
    [userId],
  );
  return rows[0] ? toPeriod(rows[0]) : null;
}

export async function getPeriod(periodId: string, db: Queryable = pool): Promise<GameplanPeriod | null> {
  const { rows } = await db.query<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM gameplan_periods WHERE id = $1`,
    [periodId],
  );
  return rows[0] ? toPeriod(rows[0]) : null;
}

export type NewPeriod = {
  userId: string;
  start: string;
  end: string;
  trigger: PeriodTrigger;
  anchorMode: AnchorMode;
  firstPeriod: boolean;
  openingPaycheck: number | null;
  primaryIncomeStreamKey: string | null;
};

export async function insertPeriod(input: NewPeriod, db: Queryable = pool): Promise<GameplanPeriod> {
  const { rows } = await db.query<PeriodRow>(
    `INSERT INTO gameplan_periods (
       user_id, start_date, end_date, trigger, anchor_mode, first_period,
       opening_paycheck, primary_income_stream_key
     )
     VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8)
     RETURNING ${PERIOD_COLUMNS}`,
    [
      input.userId,
      input.start,
      input.end,
      input.trigger,
      input.anchorMode,
      input.firstPeriod,
      input.openingPaycheck,
      input.primaryIncomeStreamKey,
    ],
  );
  return toPeriod(rows[0]!);
}

export type PlanNarration = NarrationProvenance & { why: Record<string, string> };

/**
 * Store a built (or rebuilt) shortlist: the period keeps the whole
 * Shortlist for replay, and the targets table gets one row per candidate
 * with its why line. Rows for candidates no longer in the shortlist are
 * kept as revised_out, so nothing the user was shown is lost.
 */
export async function savePlan(
  periodId: string,
  userId: string,
  shortlist: Shortlist,
  narration: PlanNarration,
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `UPDATE gameplan_periods
     SET plan = $2::jsonb, plan_source = $3, plan_fallback_reason = $4, plan_model = $5,
         updated_at = NOW()
     WHERE id = $1`,
    [periodId, JSON.stringify(shortlist), narration.source, narration.fallbackReason, narration.model],
  );

  const shown = [
    ...shortlist.plan.map((candidate, index) => ({ candidate, rank: index + 1, role: 'plan' as const })),
    ...shortlist.alternates.map((candidate, index) => ({
      candidate,
      rank: shortlist.plan.length + index + 1,
      role: 'alternate' as const,
    })),
  ];

  for (const entry of shown) {
    await db.query(
      `INSERT INTO gameplan_targets (
         period_id, user_id, candidate_id, rank, role, definition, reasons, score, why, why_source
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       ON CONFLICT (period_id, candidate_id) DO UPDATE SET
         rank = EXCLUDED.rank,
         role = EXCLUDED.role,
         definition = EXCLUDED.definition,
         reasons = EXCLUDED.reasons,
         score = EXCLUDED.score,
         why = EXCLUDED.why,
         why_source = EXCLUDED.why_source,
         updated_at = NOW()`,
      [
        periodId,
        userId,
        entry.candidate.id,
        entry.rank,
        entry.role,
        JSON.stringify(entry.candidate.definition),
        JSON.stringify(entry.candidate.reasons),
        entry.candidate.score,
        narration.why[entry.candidate.id] ?? null,
        narration.why[entry.candidate.id] ? narration.source : null,
      ],
    );
  }

  await db.query(
    `UPDATE gameplan_targets
     SET role = 'revised_out', updated_at = NOW()
     WHERE period_id = $1 AND role IN ('plan', 'alternate')
       AND NOT (candidate_id = ANY($2::text[]))`,
    [periodId, shown.map((entry) => entry.candidate.id)],
  );
}

type TargetRow = {
  id: string;
  period_id: string;
  candidate_id: string;
  rank: number;
  role: TargetRole;
  definition: TargetDefinition;
  reasons: PlanReason[];
  score: string | null;
  why: string | null;
  why_source: NarrationSource | null;
};

export async function listTargets(periodId: string, db: Queryable = pool): Promise<StoredTarget[]> {
  const { rows } = await db.query<TargetRow>(
    `SELECT id, period_id, candidate_id, rank, role, definition, reasons, score::text AS score, why, why_source
     FROM gameplan_targets
     WHERE period_id = $1
     ORDER BY rank ASC`,
    [periodId],
  );

  return rows.map((row) => ({
    id: row.id,
    periodId: row.period_id,
    candidateId: row.candidate_id,
    rank: row.rank,
    role: row.role,
    definition: row.definition,
    reasons: row.reasons ?? [],
    score: row.score === null ? null : Number(row.score),
    why: row.why,
    whySource: row.why_source,
  }));
}

export async function updateHeadsUp(periodId: string, state: HeadsUpState, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE gameplan_periods SET heads_up_state = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [periodId, JSON.stringify(state)],
  );
}

export async function markSwapUsed(periodId: string, db: Queryable = pool): Promise<void> {
  await db.query(`UPDATE gameplan_periods SET swap_used = TRUE, updated_at = NOW() WHERE id = $1`, [periodId]);
}

export async function setTargetRoles(
  periodId: string,
  roles: Record<string, TargetRole>,
  db: Queryable = pool,
): Promise<void> {
  for (const [candidateId, role] of Object.entries(roles)) {
    await db.query(
      `UPDATE gameplan_targets SET role = $3, updated_at = NOW() WHERE period_id = $1 AND candidate_id = $2`,
      [periodId, candidateId, role],
    );
  }
}

export async function markAnchorReady(periodId: string, at: Date, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE gameplan_periods SET anchor_ready_at = COALESCE(anchor_ready_at, $2), updated_at = NOW() WHERE id = $1`,
    [periodId, at],
  );
}

/** "Got it": the anchor was acknowledged and the period is open. */
export async function markAnchorOpened(periodId: string, at: Date, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE gameplan_periods
     SET anchor_opened_at = COALESCE(anchor_opened_at, $2),
         status = CASE WHEN status = 'planned' THEN 'open' ELSE status END,
         updated_at = NOW()
     WHERE id = $1`,
    [periodId, at],
  );
}

export async function markReminderSent(periodId: string, at: Date, db: Queryable = pool): Promise<void> {
  await db.query(`UPDATE gameplan_periods SET reminder_sent_at = $2, updated_at = NOW() WHERE id = $1`, [
    periodId,
    at,
  ]);
}

export async function markMidPeriodGraded(periodId: string, at: Date, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE gameplan_periods SET mid_period_graded_at = $2, updated_at = NOW() WHERE id = $1`,
    [periodId, at],
  );
}

export async function markAwarenessCompleted(periodId: string, at: Date, db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE gameplan_periods SET awareness_completed_at = COALESCE(awareness_completed_at, $2), updated_at = NOW() WHERE id = $1`,
    [periodId, at],
  );
}

/** Close a period; returns false when it was already closed (a replayed job). */
export async function closePeriod(
  periodId: string,
  at: Date,
  reason: CloseReason,
  db: Queryable = pool,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE gameplan_periods
     SET status = 'closed', closed_at = $2, close_reason = $3, updated_at = NOW()
     WHERE id = $1 AND status <> 'closed'`,
    [periodId, at, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

export type ClosedPeriodSummary = {
  period: GameplanPeriod;
  finalGrade: PeriodGrade | null;
};

/** Most recent closed periods first, with their final grades, for pace and history. */
export async function listClosedPeriods(
  userId: string,
  limit: number,
  db: Queryable = pool,
): Promise<ClosedPeriodSummary[]> {
  const { rows } = await db.query<PeriodRow & { final_grade: PeriodGrade | null }>(
    `SELECT ${PERIOD_COLUMNS
      .split(',')
      .map((column) => `p.${column.trim()}`)
      .join(', ')},
            g.grade AS final_grade
     FROM gameplan_periods p
     LEFT JOIN period_grades g ON g.period_id = p.id AND g.kind = 'final'
     WHERE p.user_id = $1 AND p.status = 'closed'
     ORDER BY p.start_date DESC
     LIMIT $2`,
    [userId, limit],
  );

  return rows.map((row) => ({ period: toPeriod(row), finalGrade: row.final_grade }));
}

/** Every live period across users, for the scheduler. */
export async function listLivePeriods(db: Queryable = pool): Promise<GameplanPeriod[]> {
  const { rows } = await db.query<PeriodRow>(
    `SELECT ${PERIOD_COLUMNS} FROM gameplan_periods WHERE status <> 'closed' ORDER BY end_date ASC`,
  );
  return rows.map(toPeriod);
}

/** Finished users with no live period: the scheduler opens one for them. */
export async function listConfirmedUsersWithoutPeriod(db: Queryable = pool): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT r.user_id
     FROM financial_analysis_runs r
     WHERE r.status = 'confirmed'
       AND NOT EXISTS (
         SELECT 1 FROM gameplan_periods p WHERE p.user_id = r.user_id AND p.status <> 'closed'
       )`,
  );
  return rows.map((row) => row.user_id);
}

// ---------------------------------------------------------------------------
// Revisions, grades, reflections
// ---------------------------------------------------------------------------

export async function insertRevision(
  input: {
    periodId: string;
    userId: string;
    kind: 'swap' | 'heads_up';
    reasonText: string | null;
    adjustment: unknown | null;
    before: Shortlist;
    after: Shortlist;
    diff: PlanDiffEntry[] | null;
    reply: string | null;
    replySource: NarrationSource | null;
  },
  db: Queryable = pool,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO plan_revisions (
       period_id, user_id, kind, reason_text, adjustment, before_plan, after_plan, diff, reply, reply_source
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
     RETURNING id`,
    [
      input.periodId,
      input.userId,
      input.kind,
      input.reasonText,
      input.adjustment === null ? null : JSON.stringify(input.adjustment),
      JSON.stringify(input.before),
      JSON.stringify(input.after),
      input.diff === null ? null : JSON.stringify(input.diff),
      input.reply,
      input.replySource,
    ],
  );
  return rows[0]!.id;
}

export async function insertGrade(
  input: {
    periodId: string;
    userId: string;
    kind: 'mid_period' | 'final';
    grade: PeriodGrade;
    actuals: PeriodActuals;
    lines: string[];
    improvements: string | null;
    narration: NarrationProvenance;
    gradedThrough: string;
  },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO period_grades (
       period_id, user_id, kind, grade, actuals, lines, improvements,
       narration_source, narration_fallback_reason, graded_through
     )
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10::date)
     ON CONFLICT (period_id, kind) DO UPDATE SET
       grade = EXCLUDED.grade,
       actuals = EXCLUDED.actuals,
       lines = EXCLUDED.lines,
       improvements = EXCLUDED.improvements,
       narration_source = EXCLUDED.narration_source,
       narration_fallback_reason = EXCLUDED.narration_fallback_reason,
       graded_through = EXCLUDED.graded_through`,
    [
      input.periodId,
      input.userId,
      input.kind,
      JSON.stringify(input.grade),
      JSON.stringify(input.actuals),
      JSON.stringify(input.lines),
      input.improvements,
      input.narration.source,
      input.narration.fallbackReason,
      input.gradedThrough,
    ],
  );
}

type GradeRow = {
  id: string;
  period_id: string;
  kind: 'mid_period' | 'final';
  grade: PeriodGrade;
  actuals: PeriodActuals;
  lines: string[];
  improvements: string | null;
  narration_source: NarrationSource | null;
  narration_fallback_reason: string | null;
  graded_through: string;
  created_at: Date;
};

export async function getGrade(
  periodId: string,
  kind: 'mid_period' | 'final',
  db: Queryable = pool,
): Promise<StoredGrade | null> {
  const { rows } = await db.query<GradeRow>(
    `SELECT id, period_id, kind, grade, actuals, lines, improvements, narration_source,
            narration_fallback_reason, graded_through::text AS graded_through, created_at
     FROM period_grades WHERE period_id = $1 AND kind = $2`,
    [periodId, kind],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    periodId: row.period_id,
    kind: row.kind,
    grade: row.grade,
    actuals: row.actuals,
    lines: row.lines ?? [],
    improvements: row.improvements,
    narration: row.narration_source
      ? { source: row.narration_source, fallbackReason: row.narration_fallback_reason, model: null }
      : null,
    gradedThrough: row.graded_through,
    createdAt: row.created_at.toISOString(),
  };
}

export async function insertReflection(
  input: {
    userId: string;
    periodId: string | null;
    kind: ReflectionKind;
    text: string;
    attribution: 'one_off' | 'structural' | null;
  },
  db: Queryable = pool,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO user_reflections (user_id, period_id, kind, text, attribution)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.userId, input.periodId, input.kind, input.text, input.attribution],
  );
  return rows[0]!.id;
}

export async function markReflectionEmbedded(id: string, db: Queryable = pool): Promise<void> {
  await db.query(`UPDATE user_reflections SET embedded_at = NOW() WHERE id = $1`, [id]);
}

export async function listReflections(periodId: string, db: Queryable = pool): Promise<StoredReflection[]> {
  const { rows } = await db.query<{
    id: string;
    period_id: string | null;
    kind: ReflectionKind;
    text: string;
    attribution: 'one_off' | 'structural' | null;
    created_at: Date;
  }>(
    `SELECT id, period_id, kind, text, attribution, created_at
     FROM user_reflections WHERE period_id = $1 ORDER BY created_at ASC`,
    [periodId],
  );
  return rows.map((row) => ({
    id: row.id,
    periodId: row.period_id,
    kind: row.kind,
    text: row.text,
    attribution: row.attribution,
    createdAt: row.created_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Accruals, nudges, settings
// ---------------------------------------------------------------------------

export async function getAccruals(userId: string, db: Queryable = pool): Promise<Record<string, number>> {
  const { rows } = await db.query<{ stream_key: string; accrued: string }>(
    `SELECT stream_key, accrued::text AS accrued FROM gameplan_accruals WHERE user_id = $1`,
    [userId],
  );
  const accruals: Record<string, number> = {};
  for (const row of rows) accruals[row.stream_key] = Number(row.accrued);
  return accruals;
}

export async function setAccruals(
  userId: string,
  entries: Record<string, number>,
  db: Queryable = pool,
): Promise<void> {
  for (const [streamKey, accrued] of Object.entries(entries)) {
    await db.query(
      `INSERT INTO gameplan_accruals (user_id, stream_key, accrued)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, stream_key) DO UPDATE SET accrued = EXCLUDED.accrued, updated_at = NOW()`,
      [userId, streamKey, Math.max(0, accrued)],
    );
  }
}

export type NudgeKind = 'unusual_transaction' | 'target_blown' | 'unexpected_income' | 'bill_overrun';

export async function insertNudge(
  input: {
    userId: string;
    periodId: string | null;
    kind: NudgeKind;
    transactionRowId: string | null;
    payload: Record<string, unknown>;
    body: string;
    sentAt: Date;
  },
  db: Queryable = pool,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO gameplan_nudges (user_id, period_id, kind, transaction_row_id, payload, body, sent_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.userId,
      input.periodId,
      input.kind,
      input.transactionRowId,
      JSON.stringify(input.payload),
      input.body,
      input.sentAt,
    ],
  );
  return rows[0]?.id ?? null;
}

export async function lastNudgeAt(userId: string, db: Queryable = pool): Promise<Date | null> {
  const { rows } = await db.query<{ sent_at: Date }>(
    `SELECT sent_at FROM gameplan_nudges WHERE user_id = $1 ORDER BY sent_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0]?.sent_at ?? null;
}

export async function nudgedTransactionIds(userId: string, db: Queryable = pool): Promise<Set<string>> {
  const { rows } = await db.query<{ transaction_row_id: string }>(
    `SELECT transaction_row_id FROM gameplan_nudges WHERE user_id = $1 AND transaction_row_id IS NOT NULL`,
    [userId],
  );
  return new Set(rows.map((row) => row.transaction_row_id));
}

export async function getAnchorSettings(userId: string, db: Queryable = pool): Promise<AnchorSettings> {
  const { rows } = await db.query<{
    anchor_mode: AnchorSettings['anchorMode'];
    anchor_day: number;
    anchor_time_of_day: AnchorSettings['anchorTimeOfDay'];
  }>(`SELECT anchor_mode, anchor_day, anchor_time_of_day FROM user_info WHERE user_id = $1`, [userId]);
  const row = rows[0];
  if (!row) return DEFAULT_ANCHOR_SETTINGS;
  return { anchorMode: row.anchor_mode, anchorDay: row.anchor_day, anchorTimeOfDay: row.anchor_time_of_day };
}

export async function updateAnchorSettings(
  userId: string,
  settings: Partial<AnchorSettings>,
  db: Queryable = pool,
): Promise<AnchorSettings> {
  const current = await getAnchorSettings(userId, db);
  const next = { ...current, ...settings };
  await db.query(
    `UPDATE user_info SET anchor_mode = $2, anchor_day = $3, anchor_time_of_day = $4, updated_at = NOW()
     WHERE user_id = $1`,
    [userId, next.anchorMode, next.anchorDay, next.anchorTimeOfDay],
  );
  return next;
}
