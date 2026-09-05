/**
 * Expo push notifications (API-015).
 *
 * Push is a wake-up call, never the source of truth: the app refetches
 * /onboarding/status when tapped. Payloads carry no balances or
 * transaction detail. The send ledger's unique constraint makes each
 * run/device notification idempotent under job retries, and Expo's
 * DeviceNotRegistered responses revoke tokens from future sends.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';

export const REVIEW_READY_NOTIFICATION = 'financial_review_ready';
export const REVIEW_DEEP_LINK = 'finbot://onboarding/review';

/** Seconds of processing after which a ready review earns a push. */
export function expectedAnalysisWindowSeconds(): number {
  const parsed = Number.parseInt(
    process.env.ANALYSIS_EXPECTED_WINDOW_SECONDS ?? '120',
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 120;
}

// ---------------------------------------------------------------------------
// Token registration
// ---------------------------------------------------------------------------

export type RegisteredToken = {
  id: string;
  platform: string;
  createdAt: string;
};

export async function registerPushToken(
  userId: string,
  input: { token: string; platform: 'ios' | 'android' | 'web'; deviceId?: string },
  db: Queryable = pool,
): Promise<RegisteredToken> {
  const { rows } = await db.query<{ id: string; platform: string; created_at: Date }>(
    `INSERT INTO push_tokens (user_id, expo_token, platform, device_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, expo_token) DO UPDATE SET
       platform = EXCLUDED.platform,
       device_id = EXCLUDED.device_id,
       revoked_at = NULL,
       enabled_at = NOW(),
       updated_at = NOW()
     RETURNING id, platform, created_at`,
    [userId, input.token, input.platform, input.deviceId ?? null],
  );

  const row = rows[0];

  if (!row) {
    throw new Error('push token upsert returned no row');
  }

  return {
    id: row.id,
    platform: row.platform,
    createdAt: row.created_at.toISOString(),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function revokePushToken(
  userId: string,
  tokenId: string,
  db: Queryable = pool,
): Promise<boolean> {
  if (!UUID_PATTERN.test(tokenId)) {
    return false;
  }

  const { rowCount } = await db.query(
    `UPDATE push_tokens
     SET revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [tokenId, userId],
  );

  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Expo adapter
// ---------------------------------------------------------------------------

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
};

export type ExpoPushTicket = {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
};

export type ExpoPushSender = (
  messages: ExpoPushMessage[],
) => Promise<ExpoPushTicket[]>;

/** Production sender: Expo's HTTP push API, no SDK dependency. */
export const sendViaExpo: ExpoPushSender = async (messages) => {
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(messages),
  });

  if (!response.ok) {
    throw new Error(`Expo push API responded ${response.status}`);
  }

  const body = (await response.json()) as { data?: ExpoPushTicket[] };
  return body.data ?? [];
};

// ---------------------------------------------------------------------------
// Review-ready delivery
// ---------------------------------------------------------------------------

export type PushDeps = {
  db: Queryable;
  send: ExpoPushSender;
};

async function defaultDeps(): Promise<PushDeps> {
  return { db: pool, send: sendViaExpo };
}

/**
 * SEND_REVIEW_READY_NOTIFICATION handler. Sends at most one notification
 * per enabled device for this analysis run; skips entirely when the run is
 * no longer waiting on the user (confirmed / recomputing / superseded).
 */
export async function sendReviewReadyNotification(
  payload: UserAnalysisJobPayload,
  depsOverride?: PushDeps,
): Promise<{ sent: number; skipped: string | null }> {
  const deps = depsOverride ?? (await defaultDeps());

  const { rows: runRows } = await deps.db.query<{ status: string }>(
    `SELECT status FROM financial_analysis_runs WHERE id = $1`,
    [payload.analysisRunId],
  );

  const runStatus = runRows[0]?.status;

  if (runStatus !== 'review_ready') {
    logger.info('review-ready push skipped', {
      analysisRunId: payload.analysisRunId,
      runStatus: runStatus ?? 'missing',
    });
    return { sent: 0, skipped: runStatus ?? 'missing' };
  }

  const { rows: tokens } = await deps.db.query<{ id: string; expo_token: string }>(
    `SELECT id, expo_token
     FROM push_tokens
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [payload.userId],
  );

  let sent = 0;

  for (const token of tokens) {
    // The ledger insert is the idempotency gate: a retry that already sent
    // to this device inserts nothing and sends nothing.
    const { rows: claimed } = await deps.db.query<{ id: string }>(
      `INSERT INTO push_notification_sends (
         user_id, analysis_run_id, push_token_id, notification_type
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (analysis_run_id, push_token_id, notification_type) DO NOTHING
       RETURNING id`,
      [payload.userId, payload.analysisRunId, token.id, REVIEW_READY_NOTIFICATION],
    );

    if (!claimed[0]) {
      continue;
    }

    try {
      const [ticket] = await deps.send([
        {
          to: token.expo_token,
          title: 'FinBot',
          // No balances, no transaction names — just the wake-up.
          body: 'Your financial review is ready.',
          data: { type: REVIEW_READY_NOTIFICATION, url: REVIEW_DEEP_LINK },
        },
      ]);

      const receipt = ticket?.status ?? 'unknown';

      await deps.db.query(
        `UPDATE push_notification_sends SET receipt_status = $2 WHERE id = $1`,
        [claimed[0].id, receipt],
      );

      if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        await deps.db.query(
          `UPDATE push_tokens SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [token.id],
        );

        logger.info('revoked dead push token', { tokenId: token.id });
        continue;
      }

      if (ticket?.status === 'ok') {
        sent += 1;
      }
    } catch (err) {
      await deps.db.query(
        `UPDATE push_notification_sends SET receipt_status = 'send_failed' WHERE id = $1`,
        [claimed[0].id],
      );

      logger.error('push send failed', {
        tokenId: token.id,
        error: err instanceof Error ? err : String(err),
      });
    }
  }

  logger.info('review-ready push processed', {
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    devices: tokens.length,
    sent,
  });

  return { sent, skipped: null };
}
