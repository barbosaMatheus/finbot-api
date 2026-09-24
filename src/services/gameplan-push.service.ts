/**
 * The gameplan push types (cadence note: anchor ready · reminder · nudge ·
 * re-engage), sent through the same Expo adapter as the review-ready push
 * and made idempotent by their own ledger keyed on period rather than
 * analysis run. Bodies never carry balances or transaction names beyond
 * what a nudge states as its one fact.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import { sendViaExpo, type ExpoPushSender } from './push.service.js';

export const GAMEPLAN_PUSH = {
  anchorReady: 'gameplan_anchor_ready',
  reminder: 'gameplan_reminder',
  nudge: 'gameplan_nudge',
  reengage: 'gameplan_reengage',
} as const;

export type GameplanPushType = (typeof GAMEPLAN_PUSH)[keyof typeof GAMEPLAN_PUSH];

export const ANCHOR_DEEP_LINK = 'finbot://gameplan/anchor';
export const CHAT_DEEP_LINK = 'finbot://chat';

export type GameplanPushInput = {
  userId: string;
  periodId: string | null;
  /** Idempotency key per device: e.g. `anchor:<periodId>` or `nudge:<nudgeId>`. */
  notificationKey: string;
  type: GameplanPushType;
  body: string;
  url?: string;
};

export type GameplanPushDeps = {
  db: Queryable;
  send: ExpoPushSender;
};

export async function sendGameplanPush(
  input: GameplanPushInput,
  depsOverride?: GameplanPushDeps,
): Promise<{ sent: number }> {
  const deps = depsOverride ?? { db: pool, send: sendViaExpo };
  const url = input.url ?? (input.type === GAMEPLAN_PUSH.nudge ? CHAT_DEEP_LINK : ANCHOR_DEEP_LINK);

  const { rows: tokens } = await deps.db.query<{ id: string; expo_token: string }>(
    `SELECT id, expo_token FROM push_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
    [input.userId],
  );

  let sent = 0;

  for (const token of tokens) {
    const { rows: claimed } = await deps.db.query<{ id: string }>(
      `INSERT INTO gameplan_push_sends (user_id, period_id, push_token_id, notification_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (push_token_id, notification_key) DO NOTHING
       RETURNING id`,
      [input.userId, input.periodId, token.id, input.notificationKey],
    );

    if (!claimed[0]) continue;

    try {
      const [ticket] = await deps.send([
        { to: token.expo_token, title: 'FinBot', body: input.body, data: { type: input.type, url } },
      ]);

      await deps.db.query(`UPDATE gameplan_push_sends SET receipt_status = $2 WHERE id = $1`, [
        claimed[0].id,
        ticket?.status ?? 'unknown',
      ]);

      if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        await deps.db.query(
          `UPDATE push_tokens SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [token.id],
        );
      }

      sent += 1;
    } catch (err) {
      logger.warn('gameplan push failed', {
        userId: input.userId,
        type: input.type,
        error: err instanceof Error ? err : String(err),
      });
    }
  }

  return { sent };
}
