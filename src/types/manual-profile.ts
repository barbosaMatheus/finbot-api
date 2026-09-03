/**
 * Manual profile v2 — the onboarding wizard's output.
 *
 * The wizard asks only what connected accounts cannot answer. Every money
 * figure the old wizard collected (take-home pay, housing, food, transport,
 * savings, debt, subscriptions) is derived by the facts engine and confirmed
 * on the review instead, so none of it lives here. The one exception is
 * `income_override` on user_info, which is written only by review
 * corrections and is deliberately absent from this payload.
 *
 * Vocabulary is fixed at build time; the label maps are what the plain
 * English profile summary (embedded for chat context) and the client both
 * render from, so the two never disagree.
 */

export const INCOME_PATTERNS = ['steady', 'varies', 'unpredictable', 'none'] as const;
export type IncomePattern = (typeof INCOME_PATTERNS)[number];

export const OBLIGATION_KINDS = [
  'rent_to_person',
  'family_loan',
  'medical_plan',
  'child_support',
  'owe_friend',
  'other',
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export const OBLIGATION_CADENCES = ['monthly', 'weekly', 'one_time'] as const;
export type ObligationCadence = (typeof OBLIGATION_CADENCES)[number];

/** A bill or debt paid in cash or from an account the user did not connect. */
export type DeclaredObligation = {
  kind: ObligationKind;
  /** Free text, used when kind is 'other' or to name a specific payee. */
  label: string | null;
  amount: number;
  cadence: ObligationCadence;
};

export const UPCOMING_EVENTS = [
  'moving',
  'wedding',
  'new_baby',
  'car',
  'tuition',
  'big_trip',
  'medical',
  'other',
] as const;
export type UpcomingEvent = (typeof UPCOMING_EVENTS)[number];

export const PRIMARY_GOALS = [
  'stop_overspending',
  'pay_down_debt',
  'build_cushion',
  'save_for_specific',
  'understand_spending',
  'not_sure',
] as const;
export type PrimaryGoal = (typeof PRIMARY_GOALS)[number];

/** Everything but "not sure", which only makes sense as the main goal. */
export const SECONDARY_GOALS = [
  'stop_overspending',
  'pay_down_debt',
  'build_cushion',
  'save_for_specific',
  'understand_spending',
] as const;
export type SecondaryGoal = (typeof SECONDARY_GOALS)[number];

/** Only present when the main goal is 'save_for_specific'. */
export type GoalDetail = {
  description: string;
  targetAmount: number | null;
  /** YYYY-MM. */
  targetMonth: string | null;
};

export const COACHING_PACES = ['ease_in', 'balanced', 'push'] as const;
export type CoachingPace = (typeof COACHING_PACES)[number];

export type ManualProfile = {
  firstName: string;
  dependentsCount: number;
  sharedAccounts: boolean;
  incomePattern: IncomePattern;
  declaredObligations: DeclaredObligation[];
  upcomingEvents: UpcomingEvent[];
  primaryGoal: PrimaryGoal;
  secondaryGoals: SecondaryGoal[];
  goalDetail: GoalDetail | null;
  coachingPace: CoachingPace;
  /** Free text — embedded for chat context, not stored on user_info. */
  additionalContext: string;
};

// ---------------------------------------------------------------------------
// Labels (plain language, no budgeting vocabulary)
// ---------------------------------------------------------------------------

export const INCOME_PATTERN_LABELS: Record<IncomePattern, string> = {
  steady: 'about the same every month',
  varies: 'varies from month to month',
  unpredictable: 'unpredictable',
  none: 'no regular income right now',
};

export const OBLIGATION_KIND_LABELS: Record<ObligationKind, string> = {
  rent_to_person: 'rent paid to a person',
  family_loan: 'a family loan',
  medical_plan: 'a medical payment plan',
  child_support: 'child support',
  owe_friend: 'money owed to a friend',
  other: 'another bill or debt',
};

export const OBLIGATION_CADENCE_LABELS: Record<ObligationCadence, string> = {
  monthly: 'a month',
  weekly: 'a week',
  one_time: 'one time',
};

export const UPCOMING_EVENT_LABELS: Record<UpcomingEvent, string> = {
  moving: 'moving',
  wedding: 'a wedding',
  new_baby: 'a new baby',
  car: 'a car repair or replacement',
  tuition: 'tuition',
  big_trip: 'a big trip',
  medical: 'a medical expense',
  other: 'something else',
};

export const GOAL_LABELS: Record<PrimaryGoal, string> = {
  stop_overspending: 'stop spending more than they make',
  pay_down_debt: 'pay down what they owe',
  build_cushion: 'build up a cushion so surprises do not wreck them',
  save_for_specific: 'save for something specific',
  understand_spending: 'understand where their money goes',
  not_sure: 'not sure yet — wants help figuring it out',
};

export const COACHING_PACE_LABELS: Record<CoachingPace, string> = {
  ease_in: 'ease in — small changes they are confident they can hit',
  balanced: 'balanced',
  push: 'push — they want this to move fast',
};

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

const WEEKS_PER_MONTH = 52 / 12;

/**
 * Monthly-normalized total of declared obligations. One-time amounts are
 * excluded — they are surfaced separately, never smeared across months.
 */
export function declaredObligationsMonthly(obligations: DeclaredObligation[]): number {
  let total = 0;

  for (const obligation of obligations) {
    if (obligation.cadence === 'monthly') {
      total += obligation.amount;
    } else if (obligation.cadence === 'weekly') {
      total += obligation.amount * WEEKS_PER_MONTH;
    }
  }

  return Math.round(total * 100) / 100;
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The profile as a few plain sentences, for embedding as chat context.
 * Every fact here is something the user told us; nothing is derived, so the
 * model can never mistake it for a bank-observed number.
 */
export function buildProfileSummary(profile: ManualProfile): string {
  const lines: string[] = [];
  const name = profile.firstName.trim();

  lines.push(name ? `The user's name is ${name}.` : 'The user did not give a name.');

  if (profile.dependentsCount === 0) {
    lines.push('No one else depends on their income.');
  } else if (profile.dependentsCount === 1) {
    lines.push('One person depends on their income besides them.');
  } else {
    lines.push(`${profile.dependentsCount} people depend on their income besides them.`);
  }

  lines.push(
    profile.sharedAccounts
      ? 'Someone else (a partner or family member) also spends from the connected accounts, so not every transaction is theirs.'
      : 'They are the only person who spends from the connected accounts.',
  );

  lines.push(`Their income is ${INCOME_PATTERN_LABELS[profile.incomePattern]}.`);

  if (profile.declaredObligations.length === 0) {
    lines.push('They reported no bills or debts outside the connected accounts.');
  } else {
    const parts = profile.declaredObligations.map((obligation) => {
      const what =
        obligation.label?.trim() || OBLIGATION_KIND_LABELS[obligation.kind];
      return `${what}, ${formatMoney(obligation.amount)} ${OBLIGATION_CADENCE_LABELS[obligation.cadence]}`;
    });
    lines.push(
      `Bills and debts not visible in the connected accounts: ${parts.join('; ')}.`,
    );
  }

  if (profile.upcomingEvents.length > 0) {
    lines.push(
      `Coming up in the next six months: ${profile.upcomingEvents
        .map((event) => UPCOMING_EVENT_LABELS[event])
        .join(', ')}.`,
    );
  }

  lines.push(`Their main goal is to ${GOAL_LABELS[profile.primaryGoal]}.`);

  if (profile.goalDetail) {
    const detail = profile.goalDetail;
    const pieces = [detail.description.trim()];
    if (detail.targetAmount !== null) {
      pieces.push(`about ${formatMoney(detail.targetAmount)}`);
    }
    if (detail.targetMonth) {
      pieces.push(`by ${detail.targetMonth}`);
    }
    lines.push(`Specifically, they are saving for: ${pieces.join(', ')}.`);
  }

  if (profile.secondaryGoals.length > 0) {
    lines.push(
      `They also want to ${profile.secondaryGoals
        .map((goal) => GOAL_LABELS[goal])
        .join(' and ')}.`,
    );
  }

  lines.push(`Coaching pace: ${COACHING_PACE_LABELS[profile.coachingPace]}.`);

  return lines.join(' ');
}
