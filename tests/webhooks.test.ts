import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

import {
  WebhookVerificationError,
  sha256Hex,
  verifyPlaidWebhook,
} from '../src/lib/webhook-verify.js';
import {
  processPlaidWebhook,
  webhookEventHash,
  type PlaidWebhookPayload,
  type WebhookDeps,
} from '../src/services/webhook.service.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

const NOW = new Date('2026-08-24T12:00:00Z');

describe('verifyPlaidWebhook', () => {
  let publicJwk: JWK;
  let sign: (claims: Record<string, unknown>, iat?: number) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    publicJwk = await exportJWK(publicKey);

    sign = async (claims, iat = Math.floor(NOW.getTime() / 1000)) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
        .setIssuedAt(iat)
        .sign(privateKey);
  });

  const deps = () => ({
    getKey: async (keyId: string) => {
      expect(keyId).toBe('key-1');
      return publicJwk;
    },
    now: () => NOW,
  });

  test('accepts an authentic delivery', async () => {
    const body = JSON.stringify({ webhook_type: 'TRANSACTIONS' });
    const jwt = await sign({ request_body_sha256: sha256Hex(body) });

    await expect(verifyPlaidWebhook(body, jwt, deps())).resolves.toBeUndefined();
  });

  test('rejects a tampered body', async () => {
    const jwt = await sign({ request_body_sha256: sha256Hex('{"original":true}') });

    await expect(
      verifyPlaidWebhook('{"tampered":true}', jwt, deps()),
    ).rejects.toThrow(WebhookVerificationError);
  });

  test('rejects a missing header', async () => {
    await expect(verifyPlaidWebhook('{}', undefined, deps())).rejects.toThrow(
      'Missing Plaid-Verification header',
    );
  });

  test('rejects the wrong algorithm', async () => {
    // HS256-signed token: same structure, wrong alg.
    const secret = new TextEncoder().encode('not-an-ec-key-but-long-enough!!');
    const jwt = await new SignJWT({ request_body_sha256: sha256Hex('{}') })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setIssuedAt()
      .sign(secret);

    await expect(verifyPlaidWebhook('{}', jwt, deps())).rejects.toThrow(
      /Unexpected signing algorithm/,
    );
  });

  test('rejects a stale token', async () => {
    const body = '{}';
    const staleIat = Math.floor(NOW.getTime() / 1000) - 10 * 60;
    const jwt = await sign({ request_body_sha256: sha256Hex(body) }, staleIat);

    await expect(verifyPlaidWebhook(body, jwt, deps())).rejects.toThrow(
      'Verification token is too old',
    );
  });

  test('rejects a signature from a different key', async () => {
    const { privateKey: otherKey } = await generateKeyPair('ES256');
    const body = '{}';
    const jwt = await new SignJWT({ request_body_sha256: sha256Hex(body) })
      .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .sign(otherKey);

    await expect(verifyPlaidWebhook(body, jwt, deps())).rejects.toThrow(
      'Signature verification failed',
    );
  });
});

type EventRow = {
  id: string;
  event_hash: string;
  result: string | null;
};

function webhookDeps(options: { itemExists?: boolean } = {}) {
  const events: EventRow[] = [];
  const enqueued: unknown[] = [];
  const terminals: string[] = [];
  const syncStateUpdates: string[] = [];

  const db: Queryable = {
    async query<R>(text: string, values: unknown[] = []) {
      if (text.includes('INSERT INTO plaid_webhook_events')) {
        const hash = values[0] as string;

        if (events.some((event) => event.event_hash === hash)) {
          return { rows: [] as R[], rowCount: 0 };
        }

        const row = { id: `evt-${events.length}`, event_hash: hash, result: null };
        events.push(row);
        return { rows: [{ id: row.id } as R], rowCount: 1 };
      }

      if (text.includes('UPDATE plaid_webhook_events')) {
        const row = events.find((event) => event.id === values[0]);
        if (row) row.result = values[1] as string;
        return { rows: [] as R[], rowCount: 1 };
      }

      if (text.includes('SELECT id, user_id FROM plaid_items')) {
        if (options.itemExists === false) {
          return { rows: [] as R[], rowCount: 0 };
        }
        return {
          rows: [{ id: 'item-row-1', user_id: 'user-1' } as R],
          rowCount: 1,
        };
      }

      if (text.includes('UPDATE plaid_sync_state')) {
        syncStateUpdates.push(text.replace(/\s+/g, ' ').slice(0, 60));
        return { rows: [] as R[], rowCount: 1 };
      }

      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };

  const deps: WebhookDeps = {
    db,
    enqueueItemSync: async (payload) => {
      enqueued.push(payload);
      return null;
    },
    onItemTerminal: async (userId) => {
      terminals.push(userId);
    },
    now: () => NOW,
  };

  return { deps, events, enqueued, terminals, syncStateUpdates };
}

describe('processPlaidWebhook', () => {
  const syncPayload: PlaidWebhookPayload = {
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: 'plaid-item-1',
  };

  test('a sync event enqueues exactly one logical item update', async () => {
    const { deps, enqueued, events } = webhookDeps();
    const body = JSON.stringify(syncPayload);

    const result = await processPlaidWebhook(body, syncPayload, deps);

    expect(result).toBe('enqueued_sync');
    expect(enqueued).toEqual([{ plaidItemRowId: 'item-row-1', userId: 'user-1' }]);
    expect(events[0]?.result).toBe('enqueued_sync');
  });

  test('duplicate delivery is a safe no-op', async () => {
    const { deps, enqueued } = webhookDeps();
    const body = JSON.stringify(syncPayload);

    await processPlaidWebhook(body, syncPayload, deps);
    const second = await processPlaidWebhook(body, syncPayload, deps);

    expect(second).toBe('duplicate');
    expect(enqueued).toHaveLength(1);
  });

  test('unknown item is recorded but not enqueued', async () => {
    const { deps, enqueued } = webhookDeps({ itemExists: false });

    const result = await processPlaidWebhook(
      JSON.stringify(syncPayload),
      syncPayload,
      deps,
    );

    expect(result).toBe('unknown_item');
    expect(enqueued).toHaveLength(0);
  });

  test('ITEM ERROR marks the item failed and pings orchestration', async () => {
    const { deps, terminals, syncStateUpdates } = webhookDeps();
    const payload: PlaidWebhookPayload = {
      webhook_type: 'ITEM',
      webhook_code: 'ERROR',
      item_id: 'plaid-item-1',
      error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'Relink needed' },
    };

    const result = await processPlaidWebhook(JSON.stringify(payload), payload, deps);

    expect(result).toBe('item_failed');
    expect(terminals).toEqual(['user-1']);
    expect(syncStateUpdates.some((sql) => sql.includes("sync_status = 'failed'"))).toBe(true);
  });

  test('LOGIN_REPAIRED clears failure and re-syncs', async () => {
    const { deps, enqueued } = webhookDeps();
    const payload: PlaidWebhookPayload = {
      webhook_type: 'ITEM',
      webhook_code: 'LOGIN_REPAIRED',
      item_id: 'plaid-item-1',
    };

    const result = await processPlaidWebhook(JSON.stringify(payload), payload, deps);

    expect(result).toBe('item_repaired');
    expect(enqueued).toHaveLength(1);
  });

  test('unrelated webhook types are recorded and ignored', async () => {
    const { deps } = webhookDeps();
    const payload: PlaidWebhookPayload = {
      webhook_type: 'ASSETS',
      webhook_code: 'PRODUCT_READY',
    };

    expect(await processPlaidWebhook(JSON.stringify(payload), payload, deps)).toBe(
      'ignored',
    );
  });

  test('event hash buckets retries but not later repeats', () => {
    const body = JSON.stringify(syncPayload);
    const early = webhookEventHash(body, new Date('2026-08-24T12:00:00Z'));
    const retry = webhookEventHash(body, new Date('2026-08-24T12:01:30Z'));
    const muchLater = webhookEventHash(body, new Date('2026-08-24T13:00:00Z'));

    expect(retry).toBe(early);
    expect(muchLater).not.toBe(early);
  });
});
