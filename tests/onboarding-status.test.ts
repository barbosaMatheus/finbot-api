import { describe, expect, jest, test } from '@jest/globals';

import type { ItemSyncOverview } from '../src/services/analysis-orchestration.service.js';
import {
  aggregateInstitutions,
  confirmFinancialReview,
  getOnboardingStatus,
  retryAnalysis,
  type RetryDeps,
  type StatusDeps,
} from '../src/services/onboarding-status.service.js';
import type { AnalysisRunSummary, LifecycleState } from '../src/types/onboarding.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

function item(overrides: Partial<ItemSyncOverview>): ItemSyncOverview {
  return {
    itemRowId: 'item-1',
    institutionName: 'Chase',
    syncStatus: 'complete',
    updateStatus: 'HISTORICAL_UPDATE_COMPLETE',
    oldestTransactionDate: '2026-03-01',
    historyDaysAvailable: 176,
    lastErrorCode: null,
    terminal: true,
    usable: true,
    ...overrides,
  };
}

function run(overrides: Partial<AnalysisRunSummary> = {}): AnalysisRunSummary {
  return {
    id: 'run-1',
    status: 'waiting_for_history',
    requestedLookbackDays: 180,
    ruleVersion: 'v1',
    retryCount: 0,
    errorCode: null,
    errorMessage: null,
    startedAt: '2026-08-24T10:00:00Z',
    reviewReadyAt: null,
    confirmedAt: null,
    failedAt: null,
    ...overrides,
  };
}

function lifecycle(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    userId: 'user-1',
    hasActiveItem: true,
    activeItemCount: 2,
    linkingDeclaredCompleteAt: new Date('2026-08-24T09:00:00Z'),
    manualProfileCompletedAt: new Date('2026-08-24T09:30:00Z'),
    latestRun: run(),
    onboardingCompleteFlag: false,
    ...overrides,
  };
}

function statusDeps(state: LifecycleState, items: ItemSyncOverview[]): StatusDeps {
  return {
    getLifecycleState: async () => state,
    getItems: async () => items,
  };
}

describe('aggregateInstitutions', () => {
  test('splits ready, limited, failed, pending', () => {
    const result = aggregateInstitutions(
      [
        item({}),
        item({ itemRowId: 'b', historyDaysAvailable: 60 }),
        item({ itemRowId: 'c', syncStatus: 'failed', usable: false }),
        item({ itemRowId: 'd', syncStatus: 'syncing', usable: false, terminal: false }),
      ],
      180,
    );

    expect(result).toEqual({ total: 4, ready: 1, limited: 1, failed: 1, pending: 1 });
  });
});

describe('getOnboardingStatus', () => {
  test('waiting phase with institutions breakdown matches the contract shape', async () => {
    const status = await getOnboardingStatus(
      'user-1',
      statusDeps(lifecycle(), [item({}), item({ itemRowId: 'b', syncStatus: 'syncing', terminal: false, usable: false })]),
    );

    expect(status.phase).toBe('waiting_for_history');
    expect(status.gates).toEqual({
      hasLinkedInstitution: true,
      linkingDeclaredComplete: true,
      manualProfileComplete: true,
      analysisReviewable: false,
      financialReviewConfirmed: false,
    });
    expect(status.analysis).toMatchObject({
      runId: 'run-1',
      status: 'waiting_for_history',
      requestedLookbackDays: 180,
      institutions: { total: 2, ready: 1, pending: 1 },
      retryAllowed: false,
    });
    expect(status.onboardingComplete).toBe(false);
    expect(status.availableActions).toContain('view_waiting');
  });

  test('fresh user with nothing linked routes to financial_linking with no analysis', async () => {
    const status = await getOnboardingStatus(
      'user-1',
      statusDeps(
        lifecycle({
          hasActiveItem: false,
          activeItemCount: 0,
          linkingDeclaredCompleteAt: null,
          manualProfileCompletedAt: null,
          latestRun: null,
        }),
        [],
      ),
    );

    expect(status.phase).toBe('financial_linking');
    expect(status.analysis).toBeNull();
    expect(status.availableActions).toContain('link_institution');
  });

  test('failed run exposes retry', async () => {
    const status = await getOnboardingStatus(
      'user-1',
      statusDeps(lifecycle({ latestRun: run({ status: 'failed' }) }), [
        item({ syncStatus: 'failed', usable: false }),
      ]),
    );

    expect(status.phase).toBe('failed_retryable');
    expect(status.analysis?.retryAllowed).toBe(true);
    expect(status.availableActions).toContain('retry_analysis');
  });

  test('confirmed run means complete and unlocked', async () => {
    const status = await getOnboardingStatus(
      'user-1',
      statusDeps(
        lifecycle({ latestRun: run({ status: 'confirmed' }), onboardingCompleteFlag: true }),
        [item({})],
      ),
    );

    expect(status.phase).toBe('complete');
    expect(status.onboardingComplete).toBe(true);
  });

  test('a stray post-completion run cannot un-complete a finished user', async () => {
    // Regression: a webhook-spawned run after confirmation used to flip
    // onboardingComplete back to false and re-lock the app shell.
    const status = await getOnboardingStatus(
      'user-1',
      statusDeps(
        lifecycle({
          latestRun: run({ status: 'waiting_for_history' }),
          onboardingCompleteFlag: true,
        }),
        [item({})],
      ),
    );

    expect(status.onboardingComplete).toBe(true);
  });
});

describe('confirmFinancialReview', () => {
  function confirmDb(options: {
    runStatus: string;
    latestVersion: number;
    unresolvedRequired: number;
  }) {
    const updates: string[] = [];

    const db: Queryable = {
      async query<R>(text: string) {
        if (text.includes('FROM financial_analysis_runs') && text.includes('ORDER BY')) {
          return {
            rows: [
              {
                id: 'run-1',
                status: options.runStatus,
                requested_lookback_days: 180,
                rule_version: 'v1',
                retry_count: 0,
                error_code: null,
                error_message: null,
                started_at: new Date('2026-08-24T10:00:00Z'),
                review_ready_at: new Date('2026-08-24T11:00:00Z'),
                confirmed_at: null,
                failed_at: null,
              } as R,
            ],
            rowCount: 1,
          };
        }

        if (text.includes('MAX(version)')) {
          return { rows: [{ version: options.latestVersion } as R], rowCount: 1 };
        }

        if (text.includes('COUNT(*)') && text.includes('financial_review_items')) {
          return {
            rows: [{ count: String(options.unresolvedRequired) } as R],
            rowCount: 1,
          };
        }

        if (text.includes('SELECT status FROM financial_analysis_runs')) {
          updates.push('lock');
          return { rows: [{ status: options.runStatus } as R], rowCount: 1 };
        }

        if (text.includes('UPDATE financial_analysis_runs')) {
          updates.push(text.includes('confirmed_snapshot_version') ? 'pin-version' : 'transition');
          return { rows: [] as R[], rowCount: 1 };
        }

        if (text.includes('SELECT manual_profile_completed_at')) {
          return {
            rows: [
              {
                manual_profile_completed_at: new Date(),
                linking_declared_complete_at: new Date(),
              } as R,
            ],
            rowCount: 1,
          };
        }

        if (text.includes('SELECT EXISTS')) {
          return { rows: [{ exists: true } as R], rowCount: 1 };
        }

        if (text.includes('UPDATE users SET on_boarding_complete')) {
          updates.push('final-flag');
          return { rows: [] as R[], rowCount: 1 };
        }

        throw new Error(`unexpected query: ${text.slice(0, 70)}`);
      },
    };

    return { db, updates };
  }

  test('happy path confirms and completes onboarding', async () => {
    const { db, updates } = confirmDb({
      runStatus: 'review_ready',
      latestVersion: 3,
      unresolvedRequired: 0,
    });

    const result = await confirmFinancialReview('user-1', 3, { db });

    // After transition the run reads back as confirmed for the recompute.
    expect(result.alreadyConfirmed).toBe(false);
    expect(updates).toContain('transition');
    expect(updates).toContain('pin-version');
    expect(updates).toContain('final-flag');
  });

  test('unresolved required items block confirmation', async () => {
    const { db } = confirmDb({
      runStatus: 'review_ready',
      latestVersion: 3,
      unresolvedRequired: 2,
    });

    await expect(confirmFinancialReview('user-1', 3, { db })).rejects.toMatchObject({
      code: 'REVIEW_ITEMS_UNRESOLVED',
      statusCode: 409,
    });
  });

  test('stale snapshot version blocks confirmation', async () => {
    const { db } = confirmDb({
      runStatus: 'review_ready',
      latestVersion: 4,
      unresolvedRequired: 0,
    });

    await expect(confirmFinancialReview('user-1', 3, { db })).rejects.toMatchObject({
      code: 'REVIEW_VERSION_STALE',
    });
  });

  test('confirming an already-confirmed run is idempotent', async () => {
    const { db } = confirmDb({
      runStatus: 'confirmed',
      latestVersion: 3,
      unresolvedRequired: 0,
    });

    const result = await confirmFinancialReview('user-1', 3, { db });

    expect(result).toEqual({ onboardingComplete: true, alreadyConfirmed: true });
  });

  test('confirmation is impossible while analysis is running', async () => {
    const { db } = confirmDb({
      runStatus: 'processing',
      latestVersion: 0,
      unresolvedRequired: 0,
    });

    await expect(confirmFinancialReview('user-1', 1, { db })).rejects.toMatchObject({
      code: 'ANALYSIS_NOT_REVIEWABLE',
    });
  });
});

describe('retryAnalysis', () => {
  function retryDeps(options: {
    runStatus: string;
    items: ItemSyncOverview[];
    rekickedItems?: number;
    analysisOutcome?: string;
  }) {
    const resets: unknown[][] = [];
    const enqueued: unknown[] = [];
    const transitions: string[] = [];
    const analysisChecks: string[] = [];
    const syncEnsures: string[] = [];

    const db: Queryable = {
      async query<R>(text: string, values: unknown[] = []) {
        if (text.includes('FROM financial_analysis_runs')) {
          return {
            rows: [
              {
                id: 'run-1',
                status: options.runStatus,
                requested_lookback_days: 180,
                rule_version: 'v1',
                retry_count: 1,
                error_code: 'NO_USABLE_ITEM',
                error_message: null,
                started_at: new Date('2026-08-24T10:00:00Z'),
                review_ready_at: null,
                confirmed_at: null,
                failed_at: new Date('2026-08-24T11:00:00Z'),
              } as R,
            ],
            rowCount: 1,
          };
        }

        if (text.includes('UPDATE plaid_sync_state')) {
          resets.push(values);
          return { rows: [] as R[], rowCount: 1 };
        }

        throw new Error(`unexpected query: ${text.slice(0, 60)}`);
      },
    };

    const deps: RetryDeps = {
      db,
      getItems: async () => options.items,
      enqueueItemSync: async (payload) => {
        enqueued.push(payload);
        return null;
      },
      transitionRun: async (_id, to) => {
        transitions.push(to);
      },
      maybeStartAnalysis: async (userId) => {
        analysisChecks.push(userId);
        return options.analysisOutcome ?? 'waiting';
      },
      ensureItemSyncs: async (userId) => {
        syncEnsures.push(userId);
        return options.rekickedItems ?? 0;
      },
    };

    return { deps, resets, enqueued, transitions, analysisChecks, syncEnsures };
  }

  test('failed run with failed items resets and re-syncs them', async () => {
    const { deps, resets, enqueued, transitions } = retryDeps({
      runStatus: 'failed',
      items: [item({ syncStatus: 'failed', usable: false })],
    });

    const result = await retryAnalysis('user-1', deps);

    expect(result).toEqual({ status: 'retry_queued' });
    expect(resets).toHaveLength(1);
    expect(enqueued).toEqual([{ plaidItemRowId: 'item-1', userId: 'user-1' }]);
    expect(transitions).toEqual(['waiting_for_history']);
  });

  test('a run already processing reports as queued', async () => {
    const { deps, enqueued } = retryDeps({
      runStatus: 'processing',
      items: [item({})],
    });

    expect(await retryAnalysis('user-1', deps)).toEqual({ status: 'already_running' });
    expect(enqueued).toHaveLength(0);
  });

  test('review_ready with nothing failed rejects the retry', async () => {
    const { deps } = retryDeps({ runStatus: 'review_ready', items: [item({})] });

    await expect(retryAnalysis('user-1', deps)).rejects.toMatchObject({
      code: 'RETRY_NOT_AVAILABLE',
    });
  });

  // Regression: this branch used to early-return 'already_running' without
  // doing anything, so a run whose analysis trigger was lost had no exit.
  test('waiting run with genuinely in-flight syncs reports already_running but still re-evaluates', async () => {
    const { deps, analysisChecks, syncEnsures } = retryDeps({
      runStatus: 'waiting_for_history',
      items: [item({ syncStatus: 'syncing', terminal: false, usable: false })],
    });

    expect(await retryAnalysis('user-1', deps)).toEqual({ status: 'already_running' });
    expect(syncEnsures).toEqual(['user-1']);
    expect(analysisChecks).toEqual(['user-1']);
  });

  test('waiting run with a lost analysis trigger re-starts and reports retry_queued', async () => {
    const { deps, analysisChecks } = retryDeps({
      runStatus: 'waiting_for_history',
      items: [item({})],
      analysisOutcome: 'started',
    });

    expect(await retryAnalysis('user-1', deps)).toEqual({ status: 'retry_queued' });
    expect(analysisChecks).toEqual(['user-1']);
  });

  test('waiting run with a stranded sync chain re-kicks it and reports retry_queued', async () => {
    const { deps, syncEnsures } = retryDeps({
      runStatus: 'waiting_for_history',
      items: [item({ syncStatus: 'pending', terminal: false, usable: false })],
      rekickedItems: 1,
    });

    expect(await retryAnalysis('user-1', deps)).toEqual({ status: 'retry_queued' });
    expect(syncEnsures).toEqual(['user-1']);
  });
});
