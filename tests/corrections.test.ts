import { describe, expect, jest, test } from '@jest/globals';

import {
  applyReviewItemAction,
  requestRecompute,
  type CorrectionsDeps,
} from '../src/services/corrections.service.js';
import { OnboardingError } from '../src/types/onboarding.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

type FakeState = {
  item: {
    id: string;
    analysis_run_id: string;
    user_id: string;
    item_key: string;
    type: string;
    required: boolean;
    status: string;
    evidence: Record<string, unknown>;
    allowed_actions: string[];
    run_status: string;
  } | null;
  latestVersion: number;
  itemUpdates: unknown[][];
  overrides: unknown[][];
  incomeUpdates: unknown[][];
  streamUpdates: unknown[][];
  transitions: string[];
  recomputes: unknown[];
  transactionExists: boolean;
};

function makeDeps(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    item: {
      id: 'item-1',
      analysis_run_id: 'run-1',
      user_id: 'user-1',
      item_key: 'external_card_payment',
      type: 'external_card_payment_unattributed',
      required: true,
      status: 'open',
      evidence: { observedMonthlyIncome: 5200 },
      allowed_actions: [
        'accept_coverage_limitation',
        'use_observed_value',
        'set_value',
        'confirm_stream',
        'dismiss_stream',
        'reclassify_transaction',
        'reclassify_merchant',
      ],
      run_status: 'review_ready',
    },
    latestVersion: 3,
    itemUpdates: [],
    overrides: [],
    incomeUpdates: [],
    streamUpdates: [],
    transitions: [],
    recomputes: [],
    transactionExists: true,
    ...overrides,
  };

  const db: Queryable = {
    async query<R>(text: string, values: unknown[] = []) {
      if (text.includes('FROM financial_review_items ri')) {
        return state.item && values[1] === state.item.user_id
          ? { rows: [state.item as R], rowCount: 1 }
          : { rows: [] as R[], rowCount: 0 };
      }

      if (text.includes('MAX(version)')) {
        return { rows: [{ version: state.latestVersion } as R], rowCount: 1 };
      }

      if (text.includes('UPDATE financial_review_items')) {
        state.itemUpdates.push(values);
        return { rows: [] as R[], rowCount: 1 };
      }

      if (text.includes('UPDATE user_info')) {
        state.incomeUpdates.push(values);
        return { rows: [] as R[], rowCount: 1 };
      }

      if (text.includes('UPDATE recurring_streams')) {
        state.streamUpdates.push(values);
        return { rows: [] as R[], rowCount: 1 };
      }

      if (text.includes('SELECT id FROM plaid_transactions')) {
        return state.transactionExists
          ? { rows: [{ id: values[0] } as R], rowCount: 1 }
          : { rows: [] as R[], rowCount: 0 };
      }

      if (text.includes('INSERT INTO user_classification_overrides')) {
        state.overrides.push(values);
        return { rows: [] as R[], rowCount: 1 };
      }

      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };

  const deps: CorrectionsDeps = {
    db,
    enqueueRecompute: async (payload) => {
      state.recomputes.push(payload);
      return null;
    },
    transitionRun: async (_runId, to) => {
      state.transitions.push(to);
    },
    now: () => new Date('2026-08-24T12:00:00Z'),
  };

  return { deps, state };
}

const baseRequest = {
  userId: 'user-1',
  reviewItemId: 'item-1',
  snapshotVersion: 3,
} as const;

describe('applyReviewItemAction', () => {
  test('accepting a limitation resolves without recompute', async () => {
    const { deps, state } = makeDeps();

    const result = await applyReviewItemAction(
      { ...baseRequest, action: 'accept_coverage_limitation' },
      deps,
    );

    expect(result).toEqual({ status: 'accepted', recomputeQueued: false });
    expect(state.itemUpdates).toHaveLength(1);
    expect(state.transitions).toHaveLength(0);

    // Audit trail: action, actor, timestamp, original evidence.
    const resolution = JSON.parse(state.itemUpdates[0]![3] as string) as Record<string, unknown>;
    expect(resolution).toMatchObject({
      action: 'accept_coverage_limitation',
      resolvedBy: 'user',
      at: '2026-08-24T12:00:00.000Z',
    });
    expect(resolution.originalEvidence).toBeDefined();
  });

  test('another user cannot touch the item', async () => {
    const { deps } = makeDeps();

    await expect(
      applyReviewItemAction(
        { ...baseRequest, userId: 'attacker', action: 'accept_coverage_limitation' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_ITEM_NOT_FOUND', statusCode: 404 });
  });

  test('stale snapshot version returns REVIEW_VERSION_STALE', async () => {
    const { deps } = makeDeps();

    await expect(
      applyReviewItemAction(
        { ...baseRequest, snapshotVersion: 2, action: 'accept_coverage_limitation' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_VERSION_STALE', statusCode: 409 });
  });

  test('actions not offered by the item are rejected', async () => {
    const { deps, state } = makeDeps();
    state.item!.allowed_actions = ['accept_coverage_limitation'];

    await expect(
      applyReviewItemAction({ ...baseRequest, action: 'dismiss_stream' }, deps),
    ).rejects.toMatchObject({ code: 'INVALID_CORRECTION_SCOPE', statusCode: 422 });
  });

  test('corrections are blocked while recomputing', async () => {
    const { deps, state } = makeDeps();
    state.item!.run_status = 'recomputing';

    await expect(
      applyReviewItemAction(
        { ...baseRequest, action: 'accept_coverage_limitation' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'RECOMPUTE_IN_PROGRESS', statusCode: 409 });
  });

  test('use_observed_value updates the manual income fact', async () => {
    const { deps, state } = makeDeps();

    const result = await applyReviewItemAction(
      { ...baseRequest, action: 'use_observed_value' },
      deps,
    );

    expect(result.status).toBe('resolved');
    expect(state.incomeUpdates).toEqual([['user-1', 5200]]);
  });

  test('set_value validates and applies a numeric amount', async () => {
    const { deps, state } = makeDeps();

    await applyReviewItemAction(
      { ...baseRequest, action: 'set_value', value: { amount: 6100 } },
      deps,
    );

    expect(state.incomeUpdates).toEqual([['user-1', 6100]]);

    await expect(
      applyReviewItemAction(
        { ...baseRequest, action: 'set_value', value: { amount: -5 } },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CORRECTION_SCOPE' });
  });

  test('dismiss_stream flips the stream and queues a recompute', async () => {
    const { deps, state } = makeDeps();
    state.item!.item_key = 'stream:outflow:netflix';

    const result = await applyReviewItemAction(
      { ...baseRequest, action: 'dismiss_stream' },
      deps,
    );

    expect(result.recomputeQueued).toBe(true);
    expect(state.streamUpdates).toEqual([['user-1', 'outflow:netflix', 'dismissed']]);
    expect(state.transitions).toEqual(['recomputing']);
    expect(state.recomputes).toEqual([{ userId: 'user-1', analysisRunId: 'run-1' }]);
  });

  test('reclassify_transaction stores a transaction-scoped override', async () => {
    const { deps, state } = makeDeps();

    const result = await applyReviewItemAction(
      {
        ...baseRequest,
        action: 'reclassify_transaction',
        value: { transactionRowId: 'txn-row-9', role: 'internal_transfer' },
      },
      deps,
    );

    expect(result.recomputeQueued).toBe(true);
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0]![1]).toBe('txn-row-9');
    expect(state.overrides[0]![2]).toBe('internal_transfer');
  });

  test("reclassify_transaction rejects another user's transaction", async () => {
    const { deps } = makeDeps({ transactionExists: false });

    await expect(
      applyReviewItemAction(
        {
          ...baseRequest,
          action: 'reclassify_transaction',
          value: { transactionRowId: 'foreign-txn', role: 'expense' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CORRECTION_SCOPE' });
  });

  test('reclassify_merchant stores a merchant-scoped override', async () => {
    const { deps, state } = makeDeps();

    await applyReviewItemAction(
      {
        ...baseRequest,
        action: 'reclassify_merchant',
        value: { merchantNormalized: 'Netflix', role: 'expense', displayBucket: 'Entertainment' },
      },
      deps,
    );

    expect(state.overrides[0]![1]).toBe('netflix');
    expect(state.overrides[0]![3]).toBe('Entertainment');
  });

  test('invalid role is rejected', async () => {
    const { deps } = makeDeps();

    await expect(
      applyReviewItemAction(
        {
          ...baseRequest,
          action: 'reclassify_merchant',
          value: { merchantNormalized: 'x', role: 'winnings' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CORRECTION_SCOPE' });
  });
});

describe('requestRecompute', () => {
  function recomputeDeps(runStatus: string) {
    const transitions: string[] = [];
    const recomputes: unknown[] = [];

    const db: Queryable = {
      async query<R>(text: string) {
        if (text.includes('FROM financial_analysis_runs')) {
          return {
            rows: [
              {
                id: 'run-1',
                status: runStatus,
                requested_lookback_days: 180,
                rule_version: 'v1',
                retry_count: 0,
                error_code: null,
                error_message: null,
                started_at: new Date('2026-08-24T10:00:00Z'),
                review_ready_at: null,
                confirmed_at: null,
                failed_at: null,
              } as R,
            ],
            rowCount: 1,
          };
        }

        throw new Error(`unexpected query: ${text.slice(0, 60)}`);
      },
    };

    const deps: CorrectionsDeps = {
      db,
      enqueueRecompute: async (payload) => {
        recomputes.push(payload);
        return null;
      },
      transitionRun: async (_runId, to) => {
        transitions.push(to);
      },
      now: () => new Date(),
    };

    return { deps, transitions, recomputes };
  }

  test('queues a rebuild from review_ready', async () => {
    const { deps, transitions, recomputes } = recomputeDeps('review_ready');

    expect(await requestRecompute('user-1', deps)).toEqual({ status: 'queued' });
    expect(transitions).toEqual(['recomputing']);
    expect(recomputes).toHaveLength(1);
  });

  test('already recomputing is reported, not duplicated', async () => {
    const { deps, recomputes } = recomputeDeps('recomputing');

    expect(await requestRecompute('user-1', deps)).toEqual({
      status: 'already_recomputing',
    });
    expect(recomputes).toHaveLength(0);
  });

  test('non-reviewable states are rejected', async () => {
    const { deps } = recomputeDeps('processing');

    await expect(requestRecompute('user-1', deps)).rejects.toBeInstanceOf(
      OnboardingError,
    );
  });
});
