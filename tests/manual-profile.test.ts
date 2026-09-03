import { describe, expect, it } from '@jest/globals';

import { onboardingPayloadSchema, onboardingSchema } from '../src/routes/onboarding.js';
import {
  buildProfileSummary,
  declaredObligationsMonthly,
  type ManualProfile,
} from '../src/types/manual-profile.js';

const base: ManualProfile = {
  firstName: 'Sam',
  dependentsCount: 2,
  sharedAccounts: true,
  incomePattern: 'varies',
  declaredObligations: [
    { kind: 'rent_to_person', label: null, amount: 600, cadence: 'monthly' },
    { kind: 'other', label: 'Storage unit, cash', amount: 50, cadence: 'weekly' },
    { kind: 'medical_plan', label: null, amount: 900, cadence: 'one_time' },
  ],
  upcomingEvents: ['moving', 'tuition'],
  upcomingEventNote: null,
  primaryGoal: 'build_cushion',
  secondaryGoals: ['pay_down_debt'],
  goalDetail: null,
  coachingPace: 'balanced',
  additionalContext: 'I send money to my parents every month.',
};

describe('manual profile v2 schema', () => {
  it('accepts a complete payload and echoes it unchanged', () => {
    const result = onboardingSchema.safeParse(base);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(base);
  });

  it('asks nothing the bank connection can answer', () => {
    const keys = Object.keys(onboardingPayloadSchema.shape);

    for (const derived of [
      'monthlyTakeHomeIncome',
      'monthlyHousingCosts',
      'monthlyFoodSpend',
      'monthlyTransportationCosts',
      'savingsAndEmergencyFunds',
      'totalDebt',
      'subscriptions',
      'riskComfort',
      'dateOfBirth',
      'maritalStatus',
    ]) {
      expect(keys).not.toContain(derived);
    }
  });

  it('requires a goal detail when saving for something specific', () => {
    const result = onboardingSchema.safeParse({
      ...base,
      primaryGoal: 'save_for_specific',
      goalDetail: null,
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join('.'))).toContain(
      'goalDetail',
    );
  });

  it('accepts a goal detail with optional target amount and month', () => {
    const result = onboardingSchema.safeParse({
      ...base,
      primaryGoal: 'save_for_specific',
      goalDetail: { description: 'A used car', targetAmount: 3000, targetMonth: '2027-03' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects a goal detail attached to any other goal', () => {
    const result = onboardingSchema.safeParse({
      ...base,
      goalDetail: { description: 'A used car', targetAmount: null, targetMonth: null },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a secondary goal that repeats the main goal, and duplicates', () => {
    expect(
      onboardingSchema.safeParse({ ...base, secondaryGoals: ['build_cushion'] }).success,
    ).toBe(false);
    expect(
      onboardingSchema.safeParse({
        ...base,
        secondaryGoals: ['pay_down_debt', 'pay_down_debt'],
      }).success,
    ).toBe(false);
  });

  it('never allows "not sure" as a secondary goal', () => {
    expect(
      onboardingSchema.safeParse({ ...base, secondaryGoals: ['not_sure'] }).success,
    ).toBe(false);
  });

  it('rejects negative amounts and malformed months', () => {
    expect(
      onboardingSchema.safeParse({
        ...base,
        declaredObligations: [{ kind: 'other', label: 'x', amount: -1, cadence: 'monthly' }],
      }).success,
    ).toBe(false);
    expect(
      onboardingSchema.safeParse({
        ...base,
        primaryGoal: 'save_for_specific',
        goalDetail: { description: 'x', targetAmount: null, targetMonth: '03/2027' },
      }).success,
    ).toBe(false);
  });

  it('accepts a "something else" note only when other is among the events', () => {
    expect(
      onboardingSchema.safeParse({
        ...base,
        upcomingEvents: ['other'],
        upcomingEventNote: 'My lease renews at a higher rent',
      }).success,
    ).toBe(true);
    expect(
      onboardingSchema.safeParse({ ...base, upcomingEventNote: 'Stray note' }).success,
    ).toBe(false);
  });

  it('treats an empty "what we cannot see" step as a real answer', () => {
    const result = onboardingSchema.safeParse({
      ...base,
      declaredObligations: [],
      upcomingEvents: [],
      additionalContext: '',
    });

    expect(result.success).toBe(true);
  });
});

describe('declaredObligationsMonthly', () => {
  it('normalizes weekly to monthly and excludes one-time amounts', () => {
    // 600 monthly + 50 weekly × 52/12 = 816.67; the 900 one-time is excluded.
    expect(declaredObligationsMonthly(base.declaredObligations)).toBe(816.67);
  });

  it('is zero with nothing declared', () => {
    expect(declaredObligationsMonthly([])).toBe(0);
  });
});

describe('buildProfileSummary', () => {
  it('renders every answer as plain sentences the model can ground on', () => {
    const summary = buildProfileSummary(base);

    expect(summary).toContain("The user's name is Sam.");
    expect(summary).toContain('2 people depend on their income');
    expect(summary).toContain('Someone else');
    expect(summary).toContain('varies from month to month');
    expect(summary).toContain('rent paid to a person, $600 a month');
    expect(summary).toContain('Storage unit, cash, $50 a week');
    expect(summary).toContain('a medical payment plan, $900 one time');
    expect(summary).toContain('moving, tuition');
    expect(summary).toContain('build up a cushion');
    expect(summary).toContain('also want to pay down what they owe');
    expect(summary).toContain('Coaching pace: balanced.');
  });

  it('says so explicitly when nothing is off-book', () => {
    const summary = buildProfileSummary({
      ...base,
      declaredObligations: [],
      upcomingEvents: [],
      secondaryGoals: [],
      sharedAccounts: false,
      dependentsCount: 0,
    });

    expect(summary).toContain('No one else depends on their income.');
    expect(summary).toContain('only person who spends');
    expect(summary).toContain('reported no bills or debts outside the connected accounts');
    expect(summary).not.toContain('Coming up');
  });

  it('names the "something else" event in the user\'s words', () => {
    const summary = buildProfileSummary({
      ...base,
      upcomingEvents: ['moving', 'other'],
      upcomingEventNote: 'my lease renews at a higher rent',
    });

    expect(summary).toContain('moving, my lease renews at a higher rent.');
  });

  it('includes the savings target when there is one', () => {
    const summary = buildProfileSummary({
      ...base,
      primaryGoal: 'save_for_specific',
      goalDetail: { description: 'A used car', targetAmount: 3000, targetMonth: '2027-03' },
    });

    expect(summary).toContain('saving for: A used car, about $3,000, by 2027-03.');
  });
});
