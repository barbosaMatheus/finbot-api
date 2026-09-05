import { describe, expect, jest, test } from '@jest/globals';

import {
  registerPushToken,
  revokePushToken,
  sendReviewReadyNotification,
  type ExpoPushMessage,
  type ExpoPushTicket,
  type PushDeps,
} from '../src/services/push.service.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

function pushDeps(options: {
  runStatus?: string;
  tokens?: Array<{ id: string; expo_token: string }>;
  alreadySent?: Set<string>;
  tickets?: ExpoPushTicket[];
  sendThrows?: boolean;
}) {
  const sent: ExpoPushMessage[][] = [];
  const receipts: unknown[][] = [];
  const revocations: string[] = [];
  const ledger = options.alreadySent ?? new Set<string>();

  const db: Queryable = {
    async query<R>(text: string, values: unknown[] = []) {
      if (text.includes('SELECT status FROM financial_analysis_runs')) {
        return {
          rows: [{ status: options.runStatus ?? 'review_ready' } as R],
          rowCount: 1,
        };
      }

      if (text.includes('SELECT id, expo_token')) {
        return {
          rows: (options.tokens ?? []) as R[],
          rowCount: options.tokens?.length ?? 0,
        };
      }

      if (text.includes('INSERT INTO push_notification_sends')) {
        const key = `${values[1]}:${values[2]}`;

        if (ledger.has(key)) {
          return { rows: [] as R[], rowCount: 0 };
        }

        ledger.add(key);
        return { rows: [{ id: `send-${key}` } as R], rowCount: 1 };
      }

      if (text.includes('UPDATE push_notification_sends')) {
        receipts.push(values);
        return { rows: [] as R[], rowCount: 1 };
      }

      if (text.includes('UPDATE push_tokens SET revoked_at')) {
        revocations.push(values[0] as string);
        return { rows: [] as R[], rowCount: 1 };
      }

      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };

  const deps: PushDeps = {
    db,
    send: async (messages) => {
      if (options.sendThrows) {
        throw new Error('expo unreachable');
      }
      sent.push(messages);
      return options.tickets ?? [{ status: 'ok' }];
    },
  };

  return { deps, sent, receipts, revocations, ledger };
}

const payload = { userId: 'user-1', analysisRunId: 'run-1' };

describe('sendReviewReadyNotification', () => {
  test('sends one notification per enabled device with a safe payload', async () => {
    const { deps, sent } = pushDeps({
      tokens: [
        { id: 'tok-1', expo_token: 'ExponentPushToken[aaa]' },
        { id: 'tok-2', expo_token: 'ExponentPushToken[bbb]' },
      ],
    });

    const result = await sendReviewReadyNotification(payload, deps);

    expect(result.sent).toBe(2);
    expect(sent).toHaveLength(2);

    const message = sent[0]![0]!;
    expect(message.data).toEqual({
      type: 'financial_review_ready',
      url: 'finbot://onboarding/review',
    });
    // No balances or transaction detail in the payload.
    expect(JSON.stringify(message)).not.toMatch(/\$|\bbalance\b|\bamount\b/i);
  });

  test('retry sends nothing to devices already in the ledger', async () => {
    const { deps, sent } = pushDeps({
      tokens: [{ id: 'tok-1', expo_token: 'ExponentPushToken[aaa]' }],
      alreadySent: new Set(['run-1:tok-1']),
    });

    const result = await sendReviewReadyNotification(payload, deps);

    expect(result.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test('running twice sends exactly once', async () => {
    const shared = pushDeps({
      tokens: [{ id: 'tok-1', expo_token: 'ExponentPushToken[aaa]' }],
    });

    await sendReviewReadyNotification(payload, shared.deps);
    await sendReviewReadyNotification(payload, shared.deps);

    expect(shared.sent).toHaveLength(1);
  });

  test('skips when the run is no longer review_ready', async () => {
    const { deps, sent } = pushDeps({
      runStatus: 'confirmed',
      tokens: [{ id: 'tok-1', expo_token: 'ExponentPushToken[aaa]' }],
    });

    const result = await sendReviewReadyNotification(payload, deps);

    expect(result.skipped).toBe('confirmed');
    expect(sent).toHaveLength(0);
  });

  test('DeviceNotRegistered revokes the token from future sends', async () => {
    const { deps, revocations } = pushDeps({
      tokens: [{ id: 'tok-dead', expo_token: 'ExponentPushToken[dead]' }],
      tickets: [
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ],
    });

    const result = await sendReviewReadyNotification(payload, deps);

    expect(result.sent).toBe(0);
    expect(revocations).toEqual(['tok-dead']);
  });

  test('a transport failure records send_failed and does not crash the batch', async () => {
    const { deps, receipts } = pushDeps({
      tokens: [{ id: 'tok-1', expo_token: 'ExponentPushToken[aaa]' }],
      sendThrows: true,
    });

    const result = await sendReviewReadyNotification(payload, deps);

    expect(result.sent).toBe(0);
    expect(receipts.some((values) => String(values[0]).startsWith('send-'))).toBe(true);
  });
});

describe('token registration', () => {
  test('registering the same token twice unrevokes and refreshes it', async () => {
    const upserts: unknown[][] = [];

    const db: Queryable = {
      async query<R>(text: string, values: unknown[] = []) {
        expect(text).toContain('ON CONFLICT (user_id, expo_token) DO UPDATE');
        expect(text).toContain('revoked_at = NULL');
        upserts.push(values);
        return {
          rows: [{ id: 'tok-1', platform: values[2], created_at: new Date() } as R],
          rowCount: 1,
        };
      },
    };

    const token = await registerPushToken(
      'user-1',
      { token: 'ExponentPushToken[aaa]', platform: 'ios', deviceId: 'device-9' },
      db,
    );

    expect(token.id).toBe('tok-1');
    expect(upserts[0]).toEqual([
      'user-1',
      'ExponentPushToken[aaa]',
      'ios',
      'device-9',
    ]);
  });

  test('revoking enforces ownership and uuid shape', async () => {
    const db: Queryable = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    };

    expect(await revokePushToken('user-1', 'not-a-uuid', db)).toBe(false);
    expect(
      await revokePushToken('user-1', '5b910c92-1890-4dce-8912-0e496d4091a4', db),
    ).toBe(false); // rowCount 0: not found or someone else's
  });
});
