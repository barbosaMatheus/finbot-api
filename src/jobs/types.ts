/**
 * The durable job vocabulary from the design (§8.4). Every queue is named
 * after its job type; payloads are minimal references — jobs re-read state
 * from the database so at-least-once delivery and replay stay safe.
 */

export const JOB = {
  INITIALIZE_ITEM_SYNC: 'INITIALIZE_ITEM_SYNC',
  SYNC_ITEM_TRANSACTIONS: 'SYNC_ITEM_TRANSACTIONS',
  CLASSIFY_USER_TRANSACTIONS: 'CLASSIFY_USER_TRANSACTIONS',
  RECONCILE_USER_TRANSFERS: 'RECONCILE_USER_TRANSFERS',
  DETECT_USER_RECURRING: 'DETECT_USER_RECURRING',
  BUILD_FINANCIAL_FACTS: 'BUILD_FINANCIAL_FACTS',
  BUILD_FINANCIAL_REVIEW: 'BUILD_FINANCIAL_REVIEW',
  SEND_REVIEW_READY_NOTIFICATION: 'SEND_REVIEW_READY_NOTIFICATION',
  SWEEP_STALE_RUNS: 'SWEEP_STALE_RUNS',
  // Gameplan (step 4). A finished user's routine syncs re-run
  // classification, reconciliation and recurrence in one job, then the
  // payday detector and the nudge evaluator read the result.
  REFRESH_USER_ANALYSIS: 'REFRESH_USER_ANALYSIS',
  BUILD_GAMEPLAN: 'BUILD_GAMEPLAN',
  GRADE_PERIOD: 'GRADE_PERIOD',
  EVALUATE_NUDGES: 'EVALUATE_NUDGES',
  RUN_GAMEPLAN_SCHEDULER: 'RUN_GAMEPLAN_SCHEDULER',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/** Failed-beyond-retry jobs from every queue land here for operator redrive. */
export const DEAD_LETTER_QUEUE = 'DEAD_LETTER';

export type ItemJobPayload = {
  /** plaid_items.id (our row id), not the Plaid item_id string. */
  plaidItemRowId: string;
  userId: string;
};

export type UserAnalysisJobPayload = {
  userId: string;
  analysisRunId: string;
};

export type UserJobPayload = {
  userId: string;
};

export type PeriodJobPayload = {
  userId: string;
  periodId: string;
};

export type GradePeriodJobPayload = PeriodJobPayload & {
  kind: 'mid_period' | 'final';
  /** Why a final grade runs now: a detected payday, the anchor day, or the payday fallback. */
  reason: 'payday' | 'schedule' | 'fallback';
  /** The posting that opened the next period, when the reason is payday. */
  paydayDate?: string;
  paydayAmount?: number;
};

export type JobPayloads = {
  [JOB.INITIALIZE_ITEM_SYNC]: ItemJobPayload;
  [JOB.SYNC_ITEM_TRANSACTIONS]: ItemJobPayload;
  [JOB.CLASSIFY_USER_TRANSACTIONS]: UserAnalysisJobPayload;
  [JOB.RECONCILE_USER_TRANSFERS]: UserAnalysisJobPayload;
  [JOB.DETECT_USER_RECURRING]: UserAnalysisJobPayload;
  [JOB.BUILD_FINANCIAL_FACTS]: UserAnalysisJobPayload;
  [JOB.BUILD_FINANCIAL_REVIEW]: UserAnalysisJobPayload;
  [JOB.SEND_REVIEW_READY_NOTIFICATION]: UserAnalysisJobPayload;
  [JOB.SWEEP_STALE_RUNS]: Record<string, never>;
  [JOB.REFRESH_USER_ANALYSIS]: UserJobPayload;
  [JOB.BUILD_GAMEPLAN]: PeriodJobPayload;
  [JOB.GRADE_PERIOD]: GradePeriodJobPayload;
  [JOB.EVALUATE_NUDGES]: UserJobPayload;
  [JOB.RUN_GAMEPLAN_SCHEDULER]: Record<string, never>;
};

export type QueueConfig = {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax: number;
  expireInSeconds: number;
};

const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  retryLimit: 5,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 600,
};

/**
 * Bounded exponential backoff everywhere; sync gets a longer active window
 * because a 180-day initial import over many pages is legitimately slow, and
 * notifications retry less because a stale "review ready" push is worthless.
 */
export const QUEUE_CONFIG: Record<JobName, QueueConfig> = {
  [JOB.INITIALIZE_ITEM_SYNC]: DEFAULT_QUEUE_CONFIG,
  [JOB.SYNC_ITEM_TRANSACTIONS]: { ...DEFAULT_QUEUE_CONFIG, expireInSeconds: 1800 },
  [JOB.CLASSIFY_USER_TRANSACTIONS]: DEFAULT_QUEUE_CONFIG,
  [JOB.RECONCILE_USER_TRANSFERS]: DEFAULT_QUEUE_CONFIG,
  [JOB.DETECT_USER_RECURRING]: DEFAULT_QUEUE_CONFIG,
  [JOB.BUILD_FINANCIAL_FACTS]: DEFAULT_QUEUE_CONFIG,
  [JOB.BUILD_FINANCIAL_REVIEW]: DEFAULT_QUEUE_CONFIG,
  [JOB.SEND_REVIEW_READY_NOTIFICATION]: {
    ...DEFAULT_QUEUE_CONFIG,
    retryLimit: 3,
    retryDelayMax: 120,
  },
  // Periodic sweep; the next scheduled tick is its own retry, so failures
  // barely need one.
  [JOB.SWEEP_STALE_RUNS]: {
    ...DEFAULT_QUEUE_CONFIG,
    retryLimit: 1,
    expireInSeconds: 300,
  },
  [JOB.REFRESH_USER_ANALYSIS]: DEFAULT_QUEUE_CONFIG,
  [JOB.BUILD_GAMEPLAN]: DEFAULT_QUEUE_CONFIG,
  [JOB.GRADE_PERIOD]: DEFAULT_QUEUE_CONFIG,
  // A nudge is only worth sending promptly; the next sync re-evaluates.
  [JOB.EVALUATE_NUDGES]: { ...DEFAULT_QUEUE_CONFIG, retryLimit: 2, retryDelayMax: 60 },
  // Hourly tick; the next tick is its own retry.
  [JOB.RUN_GAMEPLAN_SCHEDULER]: { ...DEFAULT_QUEUE_CONFIG, retryLimit: 1, expireInSeconds: 300 },
};

export const ALL_JOB_NAMES = Object.values(JOB) as JobName[];

/**
 * The narrow pg-boss surface the job layer depends on, so tests can pass a
 * fake and the registry never couples to the full client.
 */
export type BossLike = {
  createQueue(
    name: string,
    options?: Partial<QueueConfig> & { deadLetter?: string; policy?: string },
  ): Promise<void>;
  send(
    name: string,
    data?: object | null,
    options?: Record<string, unknown>,
  ): Promise<string | null>;
  sendDebounced(
    name: string,
    data: object | null,
    options: Record<string, unknown> | null,
    seconds: number,
    key?: string,
  ): Promise<string | null>;
  work(
    name: string,
    options: Record<string, unknown>,
    handler: (jobs: Array<{ id: string; name: string; data: unknown }>) => Promise<unknown>,
  ): Promise<string>;
};
