import { pool } from '../db.js';
import {
  buildProfileSummary,
  COACHING_PACES,
  INCOME_PATTERNS,
  OBLIGATION_CADENCES,
  OBLIGATION_KINDS,
  PRIMARY_GOALS,
  SECONDARY_GOALS,
  UPCOMING_EVENTS,
  type CoachingPace,
  type DeclaredObligation,
  type GoalDetail,
  type IncomePattern,
  type ManualProfile,
  type PrimaryGoal,
  type SecondaryGoal,
  type UpcomingEvent,
} from '../types/manual-profile.js';
import {
  ONBOARDING_CONTEXT_SOURCE,
  ONBOARDING_PROFILE_SOURCE,
  replaceUserTextEmbeddings,
  type PersistedEmbeddingResult,
} from './embedding.service.js';
import {
  markManualProfileComplete,
  recomputeOnboardingComplete,
} from './onboarding-lifecycle.service.js';

/**
 * Manual profile persistence (v2).
 *
 * `user_info` holds only what the wizard asks — nothing the facts engine
 * derives. The one money column on the table, `income_override`, is written
 * by review corrections alone and is deliberately not part of the payload,
 * so saving the wizard can never clobber a value the user set on the review.
 */

export type OnboardingPayload = ManualProfile;

type UserInfoRow = {
  id: string;
  user_id: string;
  first_name: string;
  dependents_count: number;
  shared_accounts: boolean;
  income_pattern: string;
  declared_obligations: unknown;
  upcoming_events: string[];
  upcoming_event_note: string | null;
  primary_goal: string;
  secondary_goals: string[];
  goal_detail: unknown;
  coaching_pace: string;
  income_override: string | null;
  created_at: Date;
  updated_at: Date;
};

export type PublicUserInfo = {
  id: string;
  userId: string;
  firstName: string;
  dependentsCount: number;
  sharedAccounts: boolean;
  incomePattern: IncomePattern;
  declaredObligations: DeclaredObligation[];
  upcomingEvents: UpcomingEvent[];
  upcomingEventNote: string | null;
  primaryGoal: PrimaryGoal;
  secondaryGoals: SecondaryGoal[];
  goalDetail: GoalDetail | null;
  coachingPace: CoachingPace;
  /** Set only by review corrections; null until then. */
  incomeOverride: number | null;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Row → domain (defensive: JSONB and TEXT[] columns are validated on read)
// ---------------------------------------------------------------------------

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function onlyOf<T extends string>(allowed: readonly T[], values: unknown): T[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.filter(
    (value): value is T =>
      typeof value === 'string' && (allowed as readonly string[]).includes(value),
  );
}

export function parseObligations(value: unknown): DeclaredObligation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: DeclaredObligation[] = [];

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const amount = Number(record.amount);

    if (!Number.isFinite(amount) || amount < 0) {
      continue;
    }

    parsed.push({
      kind: oneOf(OBLIGATION_KINDS, record.kind, 'other'),
      label: typeof record.label === 'string' && record.label.trim() ? record.label : null,
      amount,
      cadence: oneOf(OBLIGATION_CADENCES, record.cadence, 'monthly'),
    });
  }

  return parsed;
}

function parseGoalDetail(value: unknown): GoalDetail | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (typeof record.description !== 'string' || !record.description.trim()) {
    return null;
  }

  const targetAmount = Number(record.targetAmount);

  return {
    description: record.description,
    targetAmount:
      record.targetAmount !== null &&
      record.targetAmount !== undefined &&
      Number.isFinite(targetAmount) &&
      targetAmount >= 0
        ? targetAmount
        : null,
    targetMonth:
      typeof record.targetMonth === 'string' && /^\d{4}-\d{2}$/.test(record.targetMonth)
        ? record.targetMonth
        : null,
  };
}

function toProfile(row: UserInfoRow, additionalContext: string): ManualProfile {
  return {
    firstName: row.first_name,
    dependentsCount: row.dependents_count,
    sharedAccounts: row.shared_accounts,
    incomePattern: oneOf(INCOME_PATTERNS, row.income_pattern, 'steady'),
    declaredObligations: parseObligations(row.declared_obligations),
    upcomingEvents: onlyOf(UPCOMING_EVENTS, row.upcoming_events),
    upcomingEventNote:
      typeof row.upcoming_event_note === 'string' && row.upcoming_event_note.trim()
        ? row.upcoming_event_note
        : null,
    primaryGoal: oneOf(PRIMARY_GOALS, row.primary_goal, 'not_sure'),
    secondaryGoals: onlyOf(SECONDARY_GOALS, row.secondary_goals),
    goalDetail: parseGoalDetail(row.goal_detail),
    coachingPace: oneOf(COACHING_PACES, row.coaching_pace, 'balanced'),
    additionalContext,
  };
}

function toPublicUserInfo(row: UserInfoRow): PublicUserInfo {
  const profile = toProfile(row, '');

  return {
    id: row.id,
    userId: row.user_id,
    firstName: profile.firstName,
    dependentsCount: profile.dependentsCount,
    sharedAccounts: profile.sharedAccounts,
    incomePattern: profile.incomePattern,
    declaredObligations: profile.declaredObligations,
    upcomingEvents: profile.upcomingEvents,
    upcomingEventNote: profile.upcomingEventNote,
    primaryGoal: profile.primaryGoal,
    secondaryGoals: profile.secondaryGoals,
    goalDetail: profile.goalDetail,
    coachingPace: profile.coachingPace,
    incomeOverride: row.income_override === null ? null : Number(row.income_override),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export async function upsertUserOnboarding(
  userId: string,
  payload: OnboardingPayload,
): Promise<{
  userInfo: PublicUserInfo;
  additionalContextEmbedding: PersistedEmbeddingResult | null;
}> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // income_override is intentionally absent from both lists: the wizard
    // never sets it and re-saving the wizard must not reset it.
    const { rows } = await client.query<UserInfoRow>(
      `
        INSERT INTO user_info (
          user_id,
          first_name,
          dependents_count,
          shared_accounts,
          income_pattern,
          declared_obligations,
          upcoming_events,
          upcoming_event_note,
          primary_goal,
          secondary_goals,
          goal_detail,
          coaching_pace,
          updated_at
        )
        VALUES (
          $1::uuid, $2, $3, $4, $5,
          $6::jsonb, $7::text[], $8, $9, $10::text[], $11::jsonb, $12,
          NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          first_name = EXCLUDED.first_name,
          dependents_count = EXCLUDED.dependents_count,
          shared_accounts = EXCLUDED.shared_accounts,
          income_pattern = EXCLUDED.income_pattern,
          declared_obligations = EXCLUDED.declared_obligations,
          upcoming_events = EXCLUDED.upcoming_events,
          upcoming_event_note = EXCLUDED.upcoming_event_note,
          primary_goal = EXCLUDED.primary_goal,
          secondary_goals = EXCLUDED.secondary_goals,
          goal_detail = EXCLUDED.goal_detail,
          coaching_pace = EXCLUDED.coaching_pace,
          updated_at = NOW()
        RETURNING *
      `,
      [
        userId,
        payload.firstName,
        payload.dependentsCount,
        payload.sharedAccounts,
        payload.incomePattern,
        JSON.stringify(payload.declaredObligations),
        payload.upcomingEvents,
        payload.upcomingEvents.includes('other') ? payload.upcomingEventNote : null,
        payload.primaryGoal,
        payload.secondaryGoals,
        payload.goalDetail === null ? null : JSON.stringify(payload.goalDetail),
        payload.coachingPace,
      ],
    );

    // Saving manual answers completes the manual gate only. The final
    // on_boarding_complete flag is derived and stays false until the
    // financial review is confirmed (see onboarding-lifecycle.service).
    await markManualProfileComplete(client, userId);
    await recomputeOnboardingComplete(client, userId);

    await client.query('COMMIT');

    // Two context documents, replaced per source so a re-save is idempotent:
    // the structured answers as plain sentences, and the user's own words.
    await replaceUserTextEmbeddings({
      userId,
      text: buildProfileSummary(payload),
      source: ONBOARDING_PROFILE_SOURCE,
    });

    const additionalContextEmbedding = await replaceUserTextEmbeddings({
      userId,
      text: payload.additionalContext,
      source: ONBOARDING_CONTEXT_SOURCE,
    });

    return {
      userInfo: toPublicUserInfo(rows[0]),
      additionalContextEmbedding,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export type SavedOnboarding = {
  payload: OnboardingPayload;
  updatedAt: string;
};

/**
 * The saved manual answers in the exact shape the wizard submits, so the
 * client can resume without re-mapping. Returns null when the user has not
 * saved anything yet.
 */
export async function getUserOnboarding(
  userId: string,
): Promise<SavedOnboarding | null> {
  const { rows } = await pool.query<UserInfoRow>(
    `SELECT * FROM user_info WHERE user_id = $1::uuid`,
    [userId],
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  const { rows: contextRows } = await pool.query<{ context: string }>(
    `SELECT context
     FROM context_documents
     WHERE user_id = $1::uuid AND source = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, ONBOARDING_CONTEXT_SOURCE],
  );

  return {
    payload: toProfile(row, contextRows[0]?.context ?? ''),
    updatedAt: row.updated_at.toISOString(),
  };
}
