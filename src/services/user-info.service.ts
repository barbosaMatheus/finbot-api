import { pool } from '../db.js';
import {
  ONBOARDING_CONTEXT_SOURCE,
  replaceUserTextEmbeddings,
  type PersistedEmbeddingResult,
} from './embedding.service.js';
import {
  markManualProfileComplete,
  recomputeOnboardingComplete,
} from './onboarding-lifecycle.service.js';

export type OnboardingPayload = {
  fullName: string;
  dateOfBirth: string;
  maritalStatus:
    | 'single'
    | 'married'
    | 'domestic_partnership'
    | 'divorced'
    | 'widowed'
    | 'prefer_not_to_say';
  dependentsCount: number;
  employmentStatus:
    | 'full_time'
    | 'part_time'
    | 'self_employed'
    | 'unemployed'
    | 'retired'
    | 'student';
  monthlyTakeHomeIncome: number;
  monthlyHousingCosts: number;
  monthlyFoodSpend: number;
  monthlyTransportationCosts: number;
  subscriptions: Array<
    | 'netflix'
    | 'disney_hulu'
    | 'amazon_prime'
    | 'paramount'
    | 'apple'
    | 'xbox'
    | 'playstation'
    | 'nintendo'
    | 'none'
  >;
  monthlyEntertainmentSubscriptionsCosts?: number;
  savingsAndEmergencyFunds: number;
  totalDebt: number;
  factorInDebtInterest: boolean;
  financialGoals: Array<
    | 'emergency_fund'
    | 'pay_off_debt'
    | 'save_for_retirement'
    | 'save_for_home'
    | 'invest_more'
    | 'reduce_spending'
  >;
  additionalMoneyPools: Array<
    'vacation' | 'miscellaneous' | 'emergency' | 'savings' | 'investing'
  >;
  riskComfort: 'conservative' | 'moderate' | 'aggressive';
  /** Free-text final question — embedded, not stored on user_info. */
  additionalContext: string;
};

type UserInfoRow = {
  id: string;
  user_id: string;
  full_name: string;
  date_of_birth: Date | null;
  marital_status: string;
  dependents_count: number;
  employment_status: string;
  monthly_take_home_income: string;
  monthly_housing_costs: string;
  monthly_food_grocery_costs: string;
  monthly_transportation_costs: string;
  savings_emergency_funds: string;
  total_debt: string;
  debt_interest_factor: boolean;
  monthly_entertainment_subscriptions_costs: string;
  entertainment_subscriptions: string[];
  financial_goals: string[];
  additional_money_pools: string[];
  investment_risk_comfort: string;
  created_at: Date;
  updated_at: Date;
};

const MARITAL_STATUS_LABELS: Record<OnboardingPayload['maritalStatus'], string> = {
  single: 'Single',
  married: 'Married',
  domestic_partnership: 'Domestic Partnership',
  divorced: 'Divorced',
  widowed: 'Widowed',
  prefer_not_to_say: 'Prefer not to say',
};

const EMPLOYMENT_STATUS_LABELS: Record<OnboardingPayload['employmentStatus'], string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  self_employed: 'Self-employed',
  unemployed: 'Unemployed',
  retired: 'Retired',
  student: 'Student',
};

const SUBSCRIPTION_LABELS: Record<OnboardingPayload['subscriptions'][number], string> = {
  netflix: 'Netflix',
  disney_hulu: 'Disney / Hulu',
  amazon_prime: 'Amazon Prime',
  paramount: 'Paramount+',
  apple: 'Apple',
  xbox: 'Xbox',
  playstation: 'PlayStation',
  nintendo: 'Nintendo',
  none: 'None of these',
};

const FINANCIAL_GOAL_LABELS: Record<OnboardingPayload['financialGoals'][number], string> = {
  emergency_fund: 'Build emergency fund',
  pay_off_debt: 'Pay off debt',
  save_for_retirement: 'Save for retirement',
  save_for_home: 'Save for a home',
  invest_more: 'Invest more',
  reduce_spending: 'Reduce spending',
};

const MONEY_POOL_LABELS: Record<OnboardingPayload['additionalMoneyPools'][number], string> = {
  vacation: 'Vacation',
  miscellaneous: 'Miscellaneous',
  emergency: 'Emergency',
  savings: 'Savings',
  investing: 'Investing',
};

const RISK_COMFORT_LABELS: Record<OnboardingPayload['riskComfort'], string> = {
  conservative: 'Conservative',
  moderate: 'Moderate',
  aggressive: 'Aggressive',
};

function toPublicUserInfo(row: UserInfoRow) {
  return {
    id: row.id,
    userId: row.user_id,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth,
    maritalStatus: row.marital_status,
    dependentsCount: row.dependents_count,
    employmentStatus: row.employment_status,
    monthlyTakeHomeIncome: Number(row.monthly_take_home_income),
    monthlyHousingCosts: Number(row.monthly_housing_costs),
    monthlyFoodGroceryCosts: Number(row.monthly_food_grocery_costs),
    monthlyTransportationCosts: Number(row.monthly_transportation_costs),
    savingsEmergencyFunds: Number(row.savings_emergency_funds),
    totalDebt: Number(row.total_debt),
    debtInterestFactor: row.debt_interest_factor,
    monthlyEntertainmentSubscriptionsCosts: Number(
      row.monthly_entertainment_subscriptions_costs,
    ),
    entertainmentSubscriptions: row.entertainment_subscriptions,
    financialGoals: row.financial_goals,
    additionalMoneyPools: row.additional_money_pools,
    investmentRiskComfort: row.investment_risk_comfort,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertUserOnboarding(
  userId: string,
  payload: OnboardingPayload,
): Promise<{
  userInfo: ReturnType<typeof toPublicUserInfo>;
  additionalContextEmbedding: PersistedEmbeddingResult | null;
}> {
  const entertainmentSubscriptions = payload.subscriptions.includes('none')
    ? []
    : payload.subscriptions.map((value) => SUBSCRIPTION_LABELS[value]);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<UserInfoRow>(
      `
        INSERT INTO user_info (
          user_id,
          full_name,
          date_of_birth,
          marital_status,
          dependents_count,
          employment_status,
          monthly_take_home_income,
          monthly_housing_costs,
          monthly_food_grocery_costs,
          monthly_transportation_costs,
          savings_emergency_funds,
          total_debt,
          debt_interest_factor,
          monthly_entertainment_subscriptions_costs,
          entertainment_subscriptions,
          financial_goals,
          additional_money_pools,
          investment_risk_comfort,
          updated_at
        )
        VALUES (
          $1::uuid, $2, $3::date, $4, $5, $6,
          $7, $8, $9, $10, $11, $12, $13, $14,
          $15::text[], $16::text[], $17::text[], $18,
          NOW()
        )
        ON CONFLICT (user_id) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          date_of_birth = EXCLUDED.date_of_birth,
          marital_status = EXCLUDED.marital_status,
          dependents_count = EXCLUDED.dependents_count,
          employment_status = EXCLUDED.employment_status,
          monthly_take_home_income = EXCLUDED.monthly_take_home_income,
          monthly_housing_costs = EXCLUDED.monthly_housing_costs,
          monthly_food_grocery_costs = EXCLUDED.monthly_food_grocery_costs,
          monthly_transportation_costs = EXCLUDED.monthly_transportation_costs,
          savings_emergency_funds = EXCLUDED.savings_emergency_funds,
          total_debt = EXCLUDED.total_debt,
          debt_interest_factor = EXCLUDED.debt_interest_factor,
          monthly_entertainment_subscriptions_costs = EXCLUDED.monthly_entertainment_subscriptions_costs,
          entertainment_subscriptions = EXCLUDED.entertainment_subscriptions,
          financial_goals = EXCLUDED.financial_goals,
          additional_money_pools = EXCLUDED.additional_money_pools,
          investment_risk_comfort = EXCLUDED.investment_risk_comfort,
          updated_at = NOW()
        RETURNING *
      `,
      [
        userId,
        payload.fullName,
        payload.dateOfBirth,
        MARITAL_STATUS_LABELS[payload.maritalStatus],
        payload.dependentsCount,
        EMPLOYMENT_STATUS_LABELS[payload.employmentStatus],
        payload.monthlyTakeHomeIncome,
        payload.monthlyHousingCosts,
        payload.monthlyFoodSpend,
        payload.monthlyTransportationCosts,
        payload.savingsAndEmergencyFunds,
        payload.totalDebt,
        payload.factorInDebtInterest,
        payload.monthlyEntertainmentSubscriptionsCosts ?? 0,
        entertainmentSubscriptions,
        payload.financialGoals.map((value) => FINANCIAL_GOAL_LABELS[value]),
        payload.additionalMoneyPools.map((value) => MONEY_POOL_LABELS[value]),
        RISK_COMFORT_LABELS[payload.riskComfort],
      ],
    );

    // Saving manual answers completes the manual gate only. The final
    // on_boarding_complete flag is derived and stays false until the
    // financial review is confirmed (see onboarding-lifecycle.service).
    await markManualProfileComplete(client, userId);
    await recomputeOnboardingComplete(client, userId);

    await client.query('COMMIT');

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

function invert<K extends string, V extends string>(
  record: Record<K, V>,
): Record<V, K> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [value, key]),
  ) as Record<V, K>;
}

const MARITAL_STATUS_KEYS = invert(MARITAL_STATUS_LABELS);
const EMPLOYMENT_STATUS_KEYS = invert(EMPLOYMENT_STATUS_LABELS);
const SUBSCRIPTION_KEYS = invert(SUBSCRIPTION_LABELS);
const FINANCIAL_GOAL_KEYS = invert(FINANCIAL_GOAL_LABELS);
const MONEY_POOL_KEYS = invert(MONEY_POOL_LABELS);
const RISK_COMFORT_KEYS = invert(RISK_COMFORT_LABELS);

export type SavedOnboarding = {
  payload: OnboardingPayload;
  updatedAt: string;
};

/**
 * The saved manual answers in the exact shape the wizard submits, so the
 * client can resume without re-mapping labels. Returns null when the user has
 * not saved anything yet.
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

  const subscriptions = row.entertainment_subscriptions
    .map((label) => SUBSCRIPTION_KEYS[label])
    .filter((key): key is NonNullable<typeof key> => Boolean(key));

  const payload: OnboardingPayload = {
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth
      ? row.date_of_birth.toISOString().slice(0, 10)
      : '',
    maritalStatus: MARITAL_STATUS_KEYS[row.marital_status] ?? 'prefer_not_to_say',
    dependentsCount: row.dependents_count,
    employmentStatus: EMPLOYMENT_STATUS_KEYS[row.employment_status] ?? 'unemployed',
    monthlyTakeHomeIncome: Number(row.monthly_take_home_income),
    monthlyHousingCosts: Number(row.monthly_housing_costs),
    monthlyFoodSpend: Number(row.monthly_food_grocery_costs),
    monthlyTransportationCosts: Number(row.monthly_transportation_costs),
    subscriptions: subscriptions.length > 0 ? subscriptions : ['none'],
    monthlyEntertainmentSubscriptionsCosts: Number(
      row.monthly_entertainment_subscriptions_costs,
    ),
    savingsAndEmergencyFunds: Number(row.savings_emergency_funds),
    totalDebt: Number(row.total_debt),
    factorInDebtInterest: row.debt_interest_factor,
    financialGoals: row.financial_goals
      .map((label) => FINANCIAL_GOAL_KEYS[label])
      .filter((key): key is NonNullable<typeof key> => Boolean(key)),
    additionalMoneyPools: row.additional_money_pools
      .map((label) => MONEY_POOL_KEYS[label])
      .filter((key): key is NonNullable<typeof key> => Boolean(key)),
    riskComfort: RISK_COMFORT_KEYS[row.investment_risk_comfort] ?? 'moderate',
    additionalContext: contextRows[0]?.context ?? '',
  };

  return {
    payload,
    updatedAt: row.updated_at.toISOString(),
  };
}
