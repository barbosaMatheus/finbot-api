import { describe, expect, test } from '@jest/globals';

import {
  assertRunTransition,
  canTransitionRun,
  deriveAvailableActions,
  deriveGates,
  derivePhase,
  ensureRunInFlight,
  isOnboardingComplete,
} from '../src/services/onboarding-lifecycle.service.js';
import type {
  AnalysisRunStatus,
  OnboardingGates,
} from '../src/types/onboarding.js';
import { OnboardingError } from '../src/types/onboarding.js';

const NOW = new Date('2026-08-24T12:00:00Z');

function gatesFor(overrides: Partial<OnboardingGates> = {}): OnboardingGates {
  return {
    hasLinkedInstitution: true,
    linkingDeclaredComplete: true,
    manualProfileComplete: true,
    analysisReviewable: false,
    financialReviewConfirmed: false,
    ...overrides,
  };
}

describe('deriveGates', () => {
  test('fresh user has every gate closed', () => {
    const gates = deriveGates({
      hasActiveItem: false,
      linkingDeclaredCompleteAt: null,
      manualProfileCompletedAt: null,
      latestRun: null,
    });

    expect(gates).toEqual({
      hasLinkedInstitution: false,
      linkingDeclaredComplete: false,
      manualProfileComplete: false,
      analysisReviewable: false,
      financialReviewConfirmed: false,
    });
  });

  test('review_ready run opens analysisReviewable but not confirmation', () => {
    const gates = deriveGates({
      hasActiveItem: true,
      linkingDeclaredCompleteAt: NOW,
      manualProfileCompletedAt: NOW,
      latestRun: { status: 'review_ready' },
    });

    expect(gates.analysisReviewable).toBe(true);
    expect(gates.financialReviewConfirmed).toBe(false);
  });

  test('confirmed run opens both analysis gates', () => {
    const gates = deriveGates({
      hasActiveItem: true,
      linkingDeclaredCompleteAt: NOW,
      manualProfileCompletedAt: NOW,
      latestRun: { status: 'confirmed' },
    });

    expect(gates.analysisReviewable).toBe(true);
    expect(gates.financialReviewConfirmed).toBe(true);
  });

  test.each<AnalysisRunStatus>([
    'waiting_for_history',
    'processing',
    'recomputing',
    'failed',
  ])('run status %s keeps analysisReviewable closed', (status) => {
    const gates = deriveGates({
      hasActiveItem: true,
      linkingDeclaredCompleteAt: NOW,
      manualProfileCompletedAt: NOW,
      latestRun: { status },
    });

    expect(gates.analysisReviewable).toBe(false);
    expect(gates.financialReviewConfirmed).toBe(false);
  });
});

describe('isOnboardingComplete', () => {
  test('requires all three completion gates', () => {
    expect(
      isOnboardingComplete(
        gatesFor({ analysisReviewable: true, financialReviewConfirmed: true }),
      ),
    ).toBe(true);

    expect(isOnboardingComplete(gatesFor({ analysisReviewable: true }))).toBe(false);
    expect(
      isOnboardingComplete(
        gatesFor({
          manualProfileComplete: false,
          analysisReviewable: true,
          financialReviewConfirmed: true,
        }),
      ),
    ).toBe(false);
  });
});

describe('derivePhase', () => {
  test('no institution routes to financial_linking', () => {
    expect(
      derivePhase(gatesFor({ hasLinkedInstitution: false, linkingDeclaredComplete: false }), null),
    ).toBe('financial_linking');
  });

  test('linked but not declared done stays in financial_linking', () => {
    expect(derivePhase(gatesFor({ linkingDeclaredComplete: false }), null)).toBe(
      'financial_linking',
    );
  });

  test('manual profile outstanding routes to the wizard even while analysis runs', () => {
    expect(
      derivePhase(gatesFor({ manualProfileComplete: false }), 'processing'),
    ).toBe('manual_profile_in_progress');
  });

  test.each<[AnalysisRunStatus | null, string]>([
    [null, 'waiting_for_history'],
    ['waiting_for_history', 'waiting_for_history'],
    ['processing', 'classifying'],
    ['review_ready', 'review_ready'],
    ['recomputing', 'recomputing'],
    ['failed', 'failed_retryable'],
  ])('run status %s maps to phase %s once manual is complete', (status, phase) => {
    expect(derivePhase(gatesFor(), status)).toBe(phase);
  });

  test('all gates open means complete', () => {
    expect(
      derivePhase(
        gatesFor({ analysisReviewable: true, financialReviewConfirmed: true }),
        'confirmed',
      ),
    ).toBe('complete');
  });
});

describe('deriveAvailableActions', () => {
  test('review_ready exposes confirm and correct', () => {
    const actions = deriveAvailableActions('review_ready');
    expect(actions).toContain('confirm_review');
    expect(actions).toContain('correct_review');
  });

  test('failed_retryable exposes retry and relink', () => {
    const actions = deriveAvailableActions('failed_retryable');
    expect(actions).toContain('retry_analysis');
    expect(actions).toContain('link_institution');
  });

  test('restricted phases always allow managing connections and logout', () => {
    for (const phase of [
      'financial_linking',
      'manual_profile_in_progress',
      'waiting_for_history',
      'classifying',
      'review_ready',
      'recomputing',
      'failed_retryable',
    ] as const) {
      const actions = deriveAvailableActions(phase);
      expect(actions).toContain('manage_connections');
      expect(actions).toContain('logout');
    }
  });
});

describe('run status transitions', () => {
  test.each<[AnalysisRunStatus, AnalysisRunStatus]>([
    ['waiting_for_history', 'processing'],
    ['processing', 'review_ready'],
    ['review_ready', 'recomputing'],
    ['recomputing', 'review_ready'],
    ['review_ready', 'confirmed'],
    ['waiting_for_history', 'failed'],
    ['processing', 'failed'],
    ['failed', 'waiting_for_history'],
    ['failed', 'processing'],
    ['review_ready', 'waiting_for_history'],
    ['waiting_for_history', 'superseded'],
    ['review_ready', 'superseded'],
  ])('%s -> %s is allowed', (from, to) => {
    expect(canTransitionRun(from, to)).toBe(true);
    expect(() => assertRunTransition(from, to)).not.toThrow();
  });

  test.each<[AnalysisRunStatus, AnalysisRunStatus]>([
    ['confirmed', 'processing'],
    ['confirmed', 'review_ready'],
    ['superseded', 'waiting_for_history'],
    ['waiting_for_history', 'confirmed'],
    ['processing', 'confirmed'],
    ['recomputing', 'confirmed'],
    ['failed', 'review_ready'],
    ['failed', 'confirmed'],
  ])('%s -> %s is rejected', (from, to) => {
    expect(canTransitionRun(from, to)).toBe(false);
    expect(() => assertRunTransition(from, to)).toThrow(OnboardingError);
  });

  test('terminal states allow no transitions at all', () => {
    const statuses: AnalysisRunStatus[] = [
      'waiting_for_history',
      'processing',
      'review_ready',
      'recomputing',
      'confirmed',
      'failed',
      'superseded',
    ];

    for (const to of statuses) {
      expect(canTransitionRun('confirmed', to)).toBe(false);
      expect(canTransitionRun('superseded', to)).toBe(false);
    }
  });
});

describe('ensureRunInFlight', () => {
  function fakeDb(status: string) {
    const updates: string[] = [];

    const db = {
      async query<R>(text: string): Promise<{ rows: R[]; rowCount: number | null }> {
        if (text.includes('SELECT status FROM financial_analysis_runs')) {
          return { rows: [{ status } as R], rowCount: 1 };
        }

        if (text.includes('UPDATE financial_analysis_runs')) {
          updates.push(text);
          return { rows: [] as R[], rowCount: 1 };
        }

        throw new Error(`unexpected query: ${text.slice(0, 60)}`);
      },
    };

    return { db, updates };
  }

  test('promotes a waiting_for_history run to processing', async () => {
    const { db, updates } = fakeDb('waiting_for_history');

    await ensureRunInFlight('run-1', db);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('SET status = $2');
  });

  test('revives a run marked failed by a dead-lettered earlier attempt', async () => {
    const { db, updates } = fakeDb('failed');

    await ensureRunInFlight('run-1', db);

    expect(updates).toHaveLength(1);
  });

  test.each(['processing', 'recomputing', 'review_ready', 'confirmed'])(
    'leaves a %s run untouched',
    async (status) => {
      const { db, updates } = fakeDb(status);

      await ensureRunInFlight('run-1', db);

      expect(updates).toHaveLength(0);
    },
  );
});
