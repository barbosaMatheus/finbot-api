import { describe, expect, jest, test } from '@jest/globals';

import {
  sweepStaleRuns,
  STALL_FAIL_MINUTES,
  STALL_REKICK_MINUTES,
  type SweepDeps,
} from '../src/services/analysis-orchestration.service.js';
import type { Queryable } from '../src/lib/db-types.js';
import { OnboardingError } from '../src/types/onboarding.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

type StaleRow = { id: string; user_id: string };

function sweepDeps(options: {
  hopeless?: StaleRow[];
  quiet?: StaleRow[];
  waiting?: StaleRow[];
}) {
  const transitions: Array<{ runId: string; to: string; errorCode?: string | null }> = [];
  const enqueued: unknown[] = [];
  const syncEnsures: string[] = [];
  const analysisChecks: string[] = [];

  const db: Queryable = {
    async query<R>(
      text: string,
      values: unknown[] = [],
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      if (text.includes("status IN ('processing', 'recomputing')")) {
        const rows = (
          values[0] === STALL_FAIL_MINUTES
            ? (options.hopeless ?? [])
            : (options.quiet ?? [])
        ) as R[];
        return { rows, rowCount: rows.length };
      }

      if (text.includes("status = 'waiting_for_history'")) {
        const rows = (options.waiting ?? []) as R[];
        return { rows, rowCount: rows.length };
      }

      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };

  const deps: SweepDeps = {
    db,
    enqueueAnalysis: async (payload) => {
      enqueued.push(payload);
      return null;
    },
    ensureItemSyncs: async (userId) => {
      syncEnsures.push(userId);
      return 1;
    },
    maybeStartAnalysis: async (userId) => {
      analysisChecks.push(userId);
      return 'waiting';
    },
    transitionRun: (async (runId: string, to: string, opts?: { errorCode?: string | null }) => {
      transitions.push({ runId, to, errorCode: opts?.errorCode });
    }) as SweepDeps['transitionRun'],
  };

  return { deps, transitions, enqueued, syncEnsures, analysisChecks };
}

describe('sweepStaleRuns', () => {
  test('a quiet sweep does nothing', async () => {
    const { deps, transitions, enqueued, syncEnsures } = sweepDeps({});

    const result = await sweepStaleRuns(deps);

    expect(result).toEqual({ failed: 0, rekicked: 0, waitingKicked: 0 });
    expect(transitions).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(syncEnsures).toEqual([]);
  });

  test('long-stalled in-flight runs are failed retryably', async () => {
    const { deps, transitions } = sweepDeps({
      hopeless: [{ id: 'run-1', user_id: 'user-1' }],
    });

    const result = await sweepStaleRuns(deps);

    expect(result.failed).toBe(1);
    expect(transitions).toEqual([
      { runId: 'run-1', to: 'failed', errorCode: 'ANALYSIS_STALLED' },
    ]);
  });

  test('briefly stalled in-flight runs get their pipeline re-enqueued', async () => {
    const { deps, enqueued, transitions } = sweepDeps({
      quiet: [{ id: 'run-2', user_id: 'user-2' }],
    });

    const result = await sweepStaleRuns(deps);

    expect(result.rekicked).toBe(1);
    expect(enqueued).toEqual([{ userId: 'user-2', analysisRunId: 'run-2' }]);
    expect(transitions).toEqual([]);
  });

  test('stalled waiting runs get syncs and the start gate re-evaluated', async () => {
    const { deps, syncEnsures, analysisChecks } = sweepDeps({
      waiting: [{ id: 'run-3', user_id: 'user-3' }],
    });

    const result = await sweepStaleRuns(deps);

    expect(result.waitingKicked).toBe(1);
    expect(syncEnsures).toEqual(['user-3']);
    expect(analysisChecks).toEqual(['user-3']);
  });

  test('losing the fail race to another actor is quiet; transient errors are not', async () => {
    const raced = sweepDeps({ hopeless: [{ id: 'run-1', user_id: 'user-1' }] });
    raced.deps.transitionRun = (async () => {
      throw new OnboardingError('moved concurrently', 409, 'RUN_TRANSITION_CONFLICT');
    }) as SweepDeps['transitionRun'];

    await expect(sweepStaleRuns(raced.deps)).resolves.toMatchObject({ failed: 0 });

    const broken = sweepDeps({ hopeless: [{ id: 'run-1', user_id: 'user-1' }] });
    broken.deps.transitionRun = (async () => {
      throw new Error('connection reset');
    }) as SweepDeps['transitionRun'];

    await expect(sweepStaleRuns(broken.deps)).rejects.toThrow('connection reset');
  });

  test('the re-kick window is strictly shorter than the fail window', () => {
    expect(STALL_REKICK_MINUTES).toBeLessThan(STALL_FAIL_MINUTES);
  });
});
