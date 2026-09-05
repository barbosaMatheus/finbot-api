import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockMarkItemSyncFailed = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockTransitionRun = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.mock('../src/services/plaid-sync.service', () => ({
  markItemSyncFailed: mockMarkItemSyncFailed,
}));

jest.mock('../src/services/onboarding-lifecycle.service', () => ({
  transitionRun: mockTransitionRun,
}));

jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import { handleDeadLetter } from '../src/jobs/handlers/dead-letter.js';
import { JOB } from '../src/jobs/types.js';
import { OnboardingError } from '../src/types/onboarding.js';

const itemPayload = { plaidItemRowId: 'item-row-1', userId: 'user-1' };
const analysisPayload = { userId: 'user-1', analysisRunId: 'run-1' };

function context(sourceName: string | null) {
  return { jobId: 'dl-1', sourceName, failure: null };
}

beforeEach(() => {
  mockMarkItemSyncFailed.mockReset().mockResolvedValue(undefined);
  mockTransitionRun.mockReset().mockResolvedValue(undefined);
});

describe('handleDeadLetter', () => {
  test('a dead notification job never touches run or item state', async () => {
    // Regression: the notification payload carries the same analysisRunId
    // as pipeline jobs, and shape-based classification used to regress a
    // review_ready run to failed over nothing but a missed push.
    await handleDeadLetter(
      analysisPayload,
      context(JOB.SEND_REVIEW_READY_NOTIFICATION),
    );

    expect(mockTransitionRun).not.toHaveBeenCalled();
    expect(mockMarkItemSyncFailed).not.toHaveBeenCalled();
  });

  test('a dead item-sync job marks the Item failed', async () => {
    await handleDeadLetter(itemPayload, context(JOB.SYNC_ITEM_TRANSACTIONS));

    expect(mockMarkItemSyncFailed).toHaveBeenCalledWith('item-row-1', 'user-1');
    expect(mockTransitionRun).not.toHaveBeenCalled();
  });

  test('a dead pipeline job marks the run failed and retryable', async () => {
    await handleDeadLetter(analysisPayload, context(JOB.BUILD_FINANCIAL_FACTS));

    expect(mockTransitionRun).toHaveBeenCalledWith('run-1', 'failed', {
      errorCode: 'ANALYSIS_JOB_FAILED',
      errorMessage: 'A background analysis step failed after retries.',
    });
  });

  test('an already-terminal run is benign and does not rethrow', async () => {
    mockTransitionRun.mockRejectedValue(
      new OnboardingError('Analysis run cannot move from confirmed to failed', 409, 'INVALID_RUN_TRANSITION'),
    );

    await expect(
      handleDeadLetter(analysisPayload, context(JOB.BUILD_FINANCIAL_REVIEW)),
    ).resolves.toBeUndefined();
  });

  test('a transient DB error while marking the run rethrows so the DL queue retries', async () => {
    mockTransitionRun.mockRejectedValue(new Error('connection reset'));

    await expect(
      handleDeadLetter(analysisPayload, context(JOB.BUILD_FINANCIAL_REVIEW)),
    ).rejects.toThrow('connection reset');
  });

  test('a transient DB error while marking the Item rethrows so the DL queue retries', async () => {
    mockMarkItemSyncFailed.mockRejectedValue(new Error('connection reset'));

    await expect(
      handleDeadLetter(itemPayload, context(JOB.INITIALIZE_ITEM_SYNC)),
    ).rejects.toThrow('connection reset');
  });
});
