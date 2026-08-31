import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  enqueueAnalysisStage,
  enqueueInitializeItemSync,
  enqueueItemSync,
  enqueueReviewReadyNotification,
  enqueueUserAnalysis,
} from '../src/jobs/enqueue.js';
import {
  clearJobHandlers,
  registerJobHandlers,
  registeredJobNames,
  setDeadLetterHandler,
  setJobHandler,
} from '../src/jobs/register.js';
import {
  ALL_JOB_NAMES,
  DEAD_LETTER_QUEUE,
  JOB,
  QUEUE_CONFIG,
  type BossLike,
} from '../src/jobs/types.js';
import { __internal as loggerInternal } from '../src/lib/logger.js';

type SentJob = {
  name: string;
  data: unknown;
  options: Record<string, unknown> | null;
  debounceSeconds?: number;
  debounceKey?: string;
};

type WorkRegistration = {
  name: string;
  options: Record<string, unknown>;
  handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<unknown>;
};

function fakeBoss(): BossLike & { sent: SentJob[]; workers: WorkRegistration[] } {
  const sent: SentJob[] = [];
  const workers: WorkRegistration[] = [];

  return {
    sent,
    workers,
    async createQueue() {},
    async send(name, data, options) {
      sent.push({ name, data, options: (options as Record<string, unknown>) ?? null });
      return `job-${sent.length}`;
    },
    async sendDebounced(name, data, options, seconds, key) {
      sent.push({
        name,
        data,
        options: options as Record<string, unknown> | null,
        debounceSeconds: seconds,
        debounceKey: key,
      });
      return `job-${sent.length}`;
    },
    async work(name, options, handler) {
      workers.push({ name, options: options as Record<string, unknown>, handler });
      return `worker-${workers.length}`;
    },
  };
}

afterEach(() => {
  clearJobHandlers();
  jest.restoreAllMocks();
});

describe('queue configuration', () => {
  test('every job type has a bounded retry policy with backoff', () => {
    for (const name of ALL_JOB_NAMES) {
      const config = QUEUE_CONFIG[name];
      expect(config.retryLimit).toBeGreaterThan(0);
      expect(config.retryLimit).toBeLessThanOrEqual(10);
      expect(config.retryBackoff).toBe(true);
      expect(config.retryDelayMax).toBeGreaterThan(config.retryDelay);
      expect(config.expireInSeconds).toBeGreaterThan(0);
    }
  });

  test('the eight design job types all exist', () => {
    expect(ALL_JOB_NAMES.sort()).toEqual(
      [
        'INITIALIZE_ITEM_SYNC',
        'SYNC_ITEM_TRANSACTIONS',
        'CLASSIFY_USER_TRANSACTIONS',
        'RECONCILE_USER_TRANSFERS',
        'DETECT_USER_RECURRING',
        'BUILD_FINANCIAL_FACTS',
        'BUILD_FINANCIAL_REVIEW',
        'SEND_REVIEW_READY_NOTIFICATION',
      ].sort(),
    );
  });
});

describe('enqueue helpers', () => {
  const itemPayload = { plaidItemRowId: 'item-row-1', userId: 'user-1' };
  const analysisPayload = { userId: 'user-1', analysisRunId: 'run-1' };

  test('item sync is debounced per Item row', async () => {
    const boss = fakeBoss();
    await enqueueItemSync(itemPayload, boss);

    expect(boss.sent).toHaveLength(1);
    expect(boss.sent[0]).toMatchObject({
      name: JOB.SYNC_ITEM_TRANSACTIONS,
      data: itemPayload,
      debounceKey: 'item-row-1',
    });
    expect(boss.sent[0]!.debounceSeconds).toBeGreaterThan(0);
  });

  test('initialize sync uses a singleton key per Item row', async () => {
    const boss = fakeBoss();
    await enqueueInitializeItemSync(itemPayload, boss);

    expect(boss.sent[0]).toMatchObject({
      name: JOB.INITIALIZE_ITEM_SYNC,
      options: { singletonKey: 'item-row-1' },
    });
  });

  test('user analysis is debounced per user so several Item updates collapse', async () => {
    const boss = fakeBoss();
    await enqueueUserAnalysis(analysisPayload, boss);

    expect(boss.sent[0]).toMatchObject({
      name: JOB.CLASSIFY_USER_TRANSACTIONS,
      data: analysisPayload,
      debounceKey: 'user-1',
    });
  });

  test('pipeline stages carry a run-scoped singleton key', async () => {
    const boss = fakeBoss();
    await enqueueAnalysisStage(JOB.BUILD_FINANCIAL_FACTS, analysisPayload, boss);

    expect(boss.sent[0]).toMatchObject({
      name: JOB.BUILD_FINANCIAL_FACTS,
      options: {
        singletonKey: `run-1:${JOB.BUILD_FINANCIAL_FACTS}`,
      },
    });
  });

  test('review-ready notification is delayed and unique per run', async () => {
    const boss = fakeBoss();
    await enqueueReviewReadyNotification(analysisPayload, 120, boss);

    expect(boss.sent[0]).toMatchObject({
      name: JOB.SEND_REVIEW_READY_NOTIFICATION,
      options: { startAfter: 120, singletonKey: 'run-1' },
    });
  });
});

describe('handler registration', () => {
  test('only registered handlers are wired to queues', async () => {
    const boss = fakeBoss();

    setJobHandler(JOB.SYNC_ITEM_TRANSACTIONS, async () => {});
    await registerJobHandlers(boss);

    expect(boss.workers.map((w) => w.name)).toEqual([JOB.SYNC_ITEM_TRANSACTIONS]);
    expect(registeredJobNames()).toEqual([JOB.SYNC_ITEM_TRANSACTIONS]);
  });

  test('handler success is logged and does not throw', async () => {
    const boss = fakeBoss();
    const calls: unknown[] = [];

    setJobHandler(JOB.SYNC_ITEM_TRANSACTIONS, async (payload) => {
      calls.push(payload);
    });
    await registerJobHandlers(boss);

    await expect(
      boss.workers[0]!.handler([
        { id: 'j1', name: JOB.SYNC_ITEM_TRANSACTIONS, data: { plaidItemRowId: 'a', userId: 'b' } },
      ]),
    ).resolves.not.toThrow();

    expect(calls).toEqual([{ plaidItemRowId: 'a', userId: 'b' }]);
  });

  test('handler failure rethrows so pg-boss applies retry policy', async () => {
    const boss = fakeBoss();
    jest.spyOn(console, 'error').mockImplementation(() => {});

    setJobHandler(JOB.SYNC_ITEM_TRANSACTIONS, async () => {
      throw new Error('boom');
    });
    await registerJobHandlers(boss);

    await expect(
      boss.workers[0]!.handler([
        { id: 'j1', name: JOB.SYNC_ITEM_TRANSACTIONS, data: {} },
      ]),
    ).rejects.toThrow('boom');
  });

  test('dead-letter worker passes source-queue metadata and rethrows failures', async () => {
    const boss = fakeBoss();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const contexts: unknown[] = [];

    setDeadLetterHandler(async (payload, context) => {
      contexts.push(context);

      if ((payload as { boom?: boolean }).boom) {
        throw new Error('dl boom');
      }
    });
    await registerJobHandlers(boss);

    const worker = boss.workers.find((w) => w.name === DEAD_LETTER_QUEUE);
    expect(worker).toBeDefined();
    // includeMetadata is what exposes sourceName on fetched DL jobs.
    expect(worker!.options).toMatchObject({ includeMetadata: true });

    await worker!.handler([
      {
        id: 'dl-1',
        name: DEAD_LETTER_QUEUE,
        data: { userId: 'u' },
        sourceName: JOB.SEND_REVIEW_READY_NOTIFICATION,
      } as never,
    ]);

    expect(contexts[0]).toMatchObject({
      jobId: 'dl-1',
      sourceName: JOB.SEND_REVIEW_READY_NOTIFICATION,
    });

    // A failing DL handler rethrows so the DL queue's retry policy applies —
    // it used to be swallowed into a permanent, retryless failure.
    await expect(
      worker!.handler([
        { id: 'dl-2', name: DEAD_LETTER_QUEUE, data: { boom: true } } as never,
      ]),
    ).rejects.toThrow('dl boom');
  });

  test('duplicate delivery of the same payload is tolerated by contract', async () => {
    const boss = fakeBoss();
    const seen: string[] = [];

    // The registration layer guarantees rethrow-on-failure; idempotency is a
    // handler contract. This asserts the wrapper delivers duplicates intact
    // rather than deduplicating or reordering them.
    setJobHandler(JOB.SYNC_ITEM_TRANSACTIONS, async (payload) => {
      seen.push(payload.plaidItemRowId);
    });
    await registerJobHandlers(boss);

    const job = { id: 'j1', name: JOB.SYNC_ITEM_TRANSACTIONS, data: { plaidItemRowId: 'x', userId: 'u' } };
    await boss.workers[0]!.handler([job]);
    await boss.workers[0]!.handler([job]);

    expect(seen).toEqual(['x', 'x']);
  });
});

describe('logger redaction', () => {
  test('secret-bearing keys are redacted and raw payload keys dropped', () => {
    const clean = loggerInternal.sanitize({
      userId: 'u1',
      accessToken: 'secret-value',
      plaidSecret: 'also-secret',
      raw: { huge: 'payload' },
      durationMs: 12,
    });

    expect(clean).toEqual({
      userId: 'u1',
      accessToken: '[redacted]',
      plaidSecret: '[redacted]',
      durationMs: 12,
    });
  });
});
