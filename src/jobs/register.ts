/**
 * Handler registration — the seam between the queue and the domain services.
 *
 * Each pipeline ticket adds its handler to `handlers`. Registration wraps
 * every handler with structured logging (jobId, type, duration, terminal
 * status) and rethrows failures so pg-boss applies the queue's retry policy.
 * Handlers must be idempotent: delivery is at-least-once by design.
 */

import { logger } from '../lib/logger.js';
import type { BossLike, JobName, JobPayloads } from './types.js';

export type JobHandler<N extends JobName> = (
  payload: JobPayloads[N],
  context: { jobId: string },
) => Promise<void>;

type HandlerMap = { [N in JobName]?: JobHandler<N> };

const handlers: HandlerMap = {};

/** Later tickets call this at module load to plug their handler in. */
export function setJobHandler<N extends JobName>(
  name: N,
  handler: JobHandler<N>,
): void {
  handlers[name] = handler as HandlerMap[N];
}

export function registeredJobNames(): JobName[] {
  return Object.keys(handlers) as JobName[];
}

/** Exposed for tests so suites can start from a clean registry. */
export function clearJobHandlers(): void {
  for (const key of Object.keys(handlers)) {
    delete handlers[key as JobName];
  }
}

export async function registerJobHandlers(boss: BossLike): Promise<void> {
  for (const name of registeredJobNames()) {
    const handler = handlers[name];

    if (!handler) {
      continue;
    }

    await boss.work(name, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const startedAt = Date.now();

        try {
          await (handler as JobHandler<JobName>)(
            job.data as JobPayloads[JobName],
            { jobId: job.id },
          );

          logger.info('job completed', {
            jobType: name,
            jobId: job.id,
            durationMs: Date.now() - startedAt,
            status: 'completed',
          });
        } catch (err) {
          logger.error('job failed', {
            jobType: name,
            jobId: job.id,
            durationMs: Date.now() - startedAt,
            status: 'failed',
            error: err instanceof Error ? err : String(err),
          });

          // Rethrow so pg-boss retries with backoff and eventually
          // dead-letters. Swallowing here would fake success.
          throw err;
        }
      }
    });

    logger.info('job handler registered', { jobType: name });
  }
}
