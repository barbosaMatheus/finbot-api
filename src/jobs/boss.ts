/**
 * Lifecycle for the shared pg-boss instance.
 *
 * pg-boss owns its own schema (`pgboss`) in the same Postgres the API uses —
 * durable jobs without another infrastructure service. Business status never
 * lives in queue internals; jobs are references into FinBot tables.
 */

import { PgBoss } from 'pg-boss';

import { logger } from '../lib/logger.js';
import {
  ALL_JOB_NAMES,
  DEAD_LETTER_QUEUE,
  QUEUE_CONFIG,
} from './types.js';

let boss: PgBoss | null = null;
let started: Promise<PgBoss> | null = null;

function createBoss(): PgBoss {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; the job queue requires Postgres');
  }

  const instance = new PgBoss({
    connectionString,
    schema: process.env.PGBOSS_SCHEMA ?? 'pgboss',
  });

  instance.on('error', (err) => {
    logger.error('pg-boss error', { error: err });
  });

  return instance;
}

/** Create all business queues (idempotent) with their retry policies. */
export async function ensureQueues(instance: PgBoss): Promise<void> {
  await instance.createQueue(DEAD_LETTER_QUEUE, {
    // The DL consumer is the recovery path — it needs retries most: a
    // transient DB error while mirroring a failure into business state
    // would otherwise strand the user with zero record of it. Jobs are
    // never expired out; exhausted ones stay failed for operator redrive.
    retryLimit: 5,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 300,
    deleteAfterSeconds: 0,
  });

  for (const name of ALL_JOB_NAMES) {
    const config = QUEUE_CONFIG[name];
    await instance.createQueue(name, {
      retryLimit: config.retryLimit,
      retryDelay: config.retryDelay,
      retryBackoff: config.retryBackoff,
      retryDelayMax: config.retryDelayMax,
      expireInSeconds: config.expireInSeconds,
      deadLetter: DEAD_LETTER_QUEUE,
    });
  }
}

/**
 * Start (or reuse) the shared instance. Both the API process (enqueue only)
 * and the worker process (enqueue + work) call this.
 */
export async function getBoss(): Promise<PgBoss> {
  if (started) {
    return started;
  }

  started = (async () => {
    boss = createBoss();
    await boss.start();
    await ensureQueues(boss);
    logger.info('pg-boss started', { schema: process.env.PGBOSS_SCHEMA ?? 'pgboss' });
    return boss;
  })();

  try {
    return await started;
  } catch (err) {
    started = null;
    boss = null;
    throw err;
  }
}

export async function stopBoss(): Promise<void> {
  if (!boss) {
    return;
  }

  const instance = boss;
  boss = null;
  started = null;

  // graceful: let in-flight jobs finish before releasing them.
  await instance.stop({ graceful: true, timeout: 30_000 });
  logger.info('pg-boss stopped', {});
}
