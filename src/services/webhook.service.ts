/**
 * Webhook event processing (API-007).
 *
 * The route verifies and records the delivery; this service turns event
 * types into durable work. Everything here is fast — long work always goes
 * through the queue — and idempotent, since Plaid retries deliveries and
 * the enqueue layer debounces per Item.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import { sha256Hex } from '../lib/webhook-verify.js';
import type { ItemJobPayload } from '../jobs/types.js';

export type PlaidWebhookPayload = {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string; error_message?: string } | null;
  [key: string]: unknown;
};

export type WebhookDeps = {
  db: Queryable;
  enqueueItemSync(payload: ItemJobPayload): Promise<unknown>;
  onItemTerminal(userId: string): Promise<void>;
  now(): Date;
};

async function defaultDeps(): Promise<WebhookDeps> {
  const [enqueue, orchestration] = await Promise.all([
    import('../jobs/enqueue.js'),
    import('./analysis-orchestration.service.js'),
  ]);

  return {
    db: pool,
    enqueueItemSync: (payload) => enqueue.enqueueItemSync(payload),
    onItemTerminal: async (userId) => {
      await orchestration.maybeStartUserAnalysis(userId);
    },
    now: () => new Date(),
  };
}

/** Sync-relevant transaction webhook codes. */
const SYNC_CODES = new Set([
  'SYNC_UPDATES_AVAILABLE',
  'INITIAL_UPDATE',
  'HISTORICAL_UPDATE',
  'DEFAULT_UPDATE',
  'TRANSACTIONS_REMOVED',
]);

/**
 * Deduplication key: body hash + 5-minute bucket, so delivery retries
 * collapse but a legitimately repeated event later still processes.
 */
export function webhookEventHash(rawBody: string | Buffer, receivedAt: Date): string {
  const bucket = Math.floor(receivedAt.getTime() / (5 * 60 * 1000));
  return sha256Hex(Buffer.concat([
    Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody),
    Buffer.from(`:${bucket}`),
  ]));
}

export type WebhookResult =
  | 'duplicate'
  | 'enqueued_sync'
  | 'item_failed'
  | 'item_repaired'
  | 'ignored'
  | 'unknown_item';

/**
 * Record and process one verified webhook delivery. Returns what happened
 * so the route can respond quickly and tests can assert behavior.
 */
export async function processPlaidWebhook(
  rawBody: string | Buffer,
  payload: PlaidWebhookPayload,
  depsOverride?: WebhookDeps,
): Promise<WebhookResult> {
  const deps = depsOverride ?? (await defaultDeps());
  const receivedAt = deps.now();
  const eventHash = webhookEventHash(rawBody, receivedAt);

  const { rows: inserted } = await deps.db.query<{ id: string }>(
    `INSERT INTO plaid_webhook_events (event_hash, item_id, webhook_type, webhook_code, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (event_hash) DO NOTHING
     RETURNING id`,
    [
      eventHash,
      payload.item_id ?? null,
      payload.webhook_type ?? 'UNKNOWN',
      payload.webhook_code ?? 'UNKNOWN',
      JSON.stringify(payload),
    ],
  );

  const eventRow = inserted[0];

  if (!eventRow) {
    logger.info('duplicate webhook ignored', {
      webhookType: payload.webhook_type,
      webhookCode: payload.webhook_code,
    });
    return 'duplicate';
  }

  const result = await handleEvent(payload, deps);

  await deps.db.query(
    `UPDATE plaid_webhook_events
     SET processed_at = NOW(), result = $2
     WHERE id = $1`,
    [eventRow.id, result],
  );

  logger.info('webhook processed', {
    webhookType: payload.webhook_type,
    webhookCode: payload.webhook_code,
    result,
  });

  return result;
}

async function findItemRow(
  db: Queryable,
  plaidItemId: string | undefined,
): Promise<{ id: string; user_id: string } | null> {
  if (!plaidItemId) {
    return null;
  }

  const { rows } = await db.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM plaid_items WHERE item_id = $1`,
    [plaidItemId],
  );

  return rows[0] ?? null;
}

async function handleEvent(
  payload: PlaidWebhookPayload,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const type = payload.webhook_type ?? '';
  const code = payload.webhook_code ?? '';

  if (type === 'TRANSACTIONS' && SYNC_CODES.has(code)) {
    const item = await findItemRow(deps.db, payload.item_id);

    if (!item) {
      return 'unknown_item';
    }

    await deps.enqueueItemSync({ plaidItemRowId: item.id, userId: item.user_id });
    return 'enqueued_sync';
  }

  if (type === 'ITEM' && code === 'ERROR') {
    const item = await findItemRow(deps.db, payload.item_id);

    if (!item) {
      return 'unknown_item';
    }

    await deps.db.query(
      `UPDATE plaid_sync_state
       SET sync_status = 'failed',
           last_error_code = $2,
           last_error_message = $3,
           updated_at = NOW()
       WHERE plaid_item_id = $1`,
      [
        item.id,
        payload.error?.error_code ?? 'ITEM_ERROR',
        payload.error?.error_message ?? 'The institution connection failed.',
      ],
    );

    await deps.onItemTerminal(item.user_id);
    return 'item_failed';
  }

  if (type === 'ITEM' && code === 'LOGIN_REPAIRED') {
    const item = await findItemRow(deps.db, payload.item_id);

    if (!item) {
      return 'unknown_item';
    }

    await deps.db.query(
      `UPDATE plaid_sync_state
       SET sync_status = CASE WHEN sync_status = 'failed' THEN 'syncing' ELSE sync_status END,
           last_error_code = NULL,
           last_error_message = NULL,
           updated_at = NOW()
       WHERE plaid_item_id = $1`,
      [item.id],
    );

    await deps.enqueueItemSync({ plaidItemRowId: item.id, userId: item.user_id });
    return 'item_repaired';
  }

  return 'ignored';
}
