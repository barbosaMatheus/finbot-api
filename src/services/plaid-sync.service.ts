/**
 * Cursor-based /transactions/sync engine (API-006).
 *
 * One sync session fetches every available page for an Item, then applies
 * all changes and the final cursor in a single database transaction while
 * holding the Item's sync-state row lock. Crash anywhere before commit
 * leaves the stored cursor untouched, so the retry re-fetches the same
 * session and the upserts converge — no duplicates, no lost pages.
 *
 * Per Plaid guidance, TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION restarts
 * the whole session from the stored cursor.
 */

import type { RemovedTransaction, Transaction, TransactionsSyncResponse } from 'plaid';

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import type { ItemJobPayload } from '../jobs/types.js';
import {
  applySyncChanges,
  ensureSyncState,
  getOldestTransactionDate,
} from './transaction-store.service.js';

const HISTORICAL_COMPLETE = 'HISTORICAL_UPDATE_COMPLETE';
const MUTATION_ERROR_CODE = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const MAX_SESSION_RESTARTS = 3;

/** Seconds between poll re-syncs while waiting for historical data. */
function pollIntervalSeconds(): number {
  const parsed = Number.parseInt(process.env.PLAID_SYNC_POLL_SECONDS ?? '30', 10);
  return Number.isFinite(parsed) && parsed >= 5 ? parsed : 30;
}

/**
 * How long after initialization we keep polling for historical readiness
 * before accepting whatever history arrived as this Item's terminal state.
 */
function pollTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.PLAID_SYNC_POLL_TIMEOUT_SECONDS ?? '1800',
    10,
  );
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 1800) * 1000;
}

type SyncPage = Pick<
  TransactionsSyncResponse,
  'added' | 'modified' | 'removed' | 'next_cursor' | 'has_more' | 'accounts'
> & { transactions_update_status: string };

export type PlaidSyncClient = {
  transactionsSync(request: {
    access_token: string;
    cursor?: string;
    count?: number;
  }): Promise<{ data: SyncPage }>;
};

export type TxClientLike = Queryable & { release(): void };

export type SyncDeps = {
  plaid: PlaidSyncClient;
  db: Queryable & { connect(): Promise<TxClientLike> };
  getAccessToken(plaidItemRowId: string): Promise<{
    userId: string;
    accessToken: string;
    status: string;
  }>;
  /** Schedule a delayed re-sync poll for this Item. */
  scheduleResync(payload: ItemJobPayload, delaySeconds: number): Promise<unknown>;
  /** Called when this Item reaches a terminal sync state for the run. */
  onItemTerminal(userId: string): Promise<void>;
  now(): Date;
};

async function defaultDeps(): Promise<SyncDeps> {
  const [{ getPlaidClient }, { getAccessTokenForItemRow }, enqueue, orchestration] =
    await Promise.all([
      import('../lib/plaid.js'),
      import('./plaid.service.js'),
      import('../jobs/enqueue.js'),
      import('./analysis-orchestration.service.js'),
    ]);

  return {
    plaid: getPlaidClient() as unknown as PlaidSyncClient,
    db: pool as unknown as SyncDeps['db'],
    getAccessToken: getAccessTokenForItemRow,
    scheduleResync: (payload, delaySeconds) =>
      enqueue.enqueueItemSyncDelayed(payload, delaySeconds),
    onItemTerminal: async (userId) => {
      await orchestration.maybeStartUserAnalysis(userId);
    },
    now: () => new Date(),
  };
}

type SessionBuffer = {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  accounts: Map<string, SyncPage['accounts'][number]>;
  finalCursor: string;
  updateStatus: string;
};

function isMutationDuringPagination(err: unknown): boolean {
  const code = (
    err as { response?: { data?: { error_code?: string } } }
  )?.response?.data?.error_code;
  return code === MUTATION_ERROR_CODE;
}

/** Fetch every page of one sync session starting from `startCursor`. */
async function fetchSession(
  plaid: PlaidSyncClient,
  accessToken: string,
  startCursor: string | null,
): Promise<SessionBuffer> {
  const buffer: SessionBuffer = {
    added: [],
    modified: [],
    removed: [],
    accounts: new Map(),
    finalCursor: startCursor ?? '',
    updateStatus: 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
  };

  let cursor = startCursor ?? undefined;
  let hasMore = true;

  while (hasMore) {
    const { data } = await plaid.transactionsSync({
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
    });

    buffer.added.push(...data.added);
    buffer.modified.push(...data.modified);
    buffer.removed.push(...data.removed);

    for (const account of data.accounts ?? []) {
      buffer.accounts.set(account.account_id, account);
    }

    buffer.updateStatus = data.transactions_update_status;
    buffer.finalCursor = data.next_cursor;
    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  return buffer;
}

async function refreshAccounts(
  db: Queryable,
  plaidItemRowId: string,
  accounts: SessionBuffer['accounts'],
): Promise<void> {
  for (const account of accounts.values()) {
    await db.query(
      `INSERT INTO plaid_accounts (
         plaid_item_id, account_id, name, official_name, mask, type, subtype,
         current_balance, available_balance, iso_currency_code
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (account_id) DO UPDATE SET
         plaid_item_id = EXCLUDED.plaid_item_id,
         name = EXCLUDED.name,
         official_name = EXCLUDED.official_name,
         mask = EXCLUDED.mask,
         type = EXCLUDED.type,
         subtype = EXCLUDED.subtype,
         current_balance = EXCLUDED.current_balance,
         available_balance = EXCLUDED.available_balance,
         iso_currency_code = EXCLUDED.iso_currency_code,
         updated_at = NOW()`,
      [
        plaidItemRowId,
        account.account_id,
        account.name,
        account.official_name ?? null,
        account.mask ?? null,
        account.type,
        account.subtype ?? null,
        account.balances?.current ?? null,
        account.balances?.available ?? null,
        account.balances?.iso_currency_code ?? null,
      ],
    );
  }
}

export type SyncOutcome = {
  status: 'synced' | 'skipped';
  terminal: boolean;
  updateStatus?: string;
  counts?: { added: number; modified: number; removed: number };
};

/**
 * Run one full sync session for an Item. Idempotent; safe under
 * at-least-once delivery and concurrent triggers (the loser of the cursor
 * race restarts against the winner's committed cursor).
 */
export async function syncItemTransactions(
  payload: ItemJobPayload,
  depsOverride?: SyncDeps,
): Promise<SyncOutcome> {
  const deps: SyncDeps = depsOverride ?? (await defaultDeps());
  const { plaidItemRowId, userId } = payload;

  const item = await deps.getAccessToken(plaidItemRowId);

  if (item.status !== 'active') {
    logger.info('skipping sync for inactive item', { itemId: plaidItemRowId, userId });
    return { status: 'skipped', terminal: true };
  }

  await ensureSyncState(deps.db, plaidItemRowId);

  for (let attempt = 0; attempt < MAX_SESSION_RESTARTS; attempt += 1) {
    // Read the committed cursor outside the transaction; the commit phase
    // re-checks it under lock and restarts on interference.
    const { rows: stateRows } = await deps.db.query<{
      cursor: string | null;
      initialized_at: Date | null;
    }>(
      `SELECT cursor, initialized_at FROM plaid_sync_state WHERE plaid_item_id = $1`,
      [plaidItemRowId],
    );

    const state = stateRows[0];

    if (!state) {
      throw new Error(`sync state missing for item ${plaidItemRowId}`);
    }

    let session: SessionBuffer;

    try {
      session = await fetchSession(deps.plaid, item.accessToken, state.cursor);
    } catch (err) {
      if (isMutationDuringPagination(err) && attempt < MAX_SESSION_RESTARTS - 1) {
        logger.warn('sync session mutated during pagination; restarting', {
          itemId: plaidItemRowId,
          attempt,
        });
        continue;
      }

      await recordSyncError(deps.db, plaidItemRowId, err);
      throw err;
    }

    const client = await deps.db.connect();

    try {
      await client.query('BEGIN');

      const { rows: lockedRows } = await client.query<{
        cursor: string | null;
        initialized_at: Date | null;
      }>(
        `SELECT cursor, initialized_at FROM plaid_sync_state
         WHERE plaid_item_id = $1
         FOR UPDATE`,
        [plaidItemRowId],
      );

      const locked = lockedRows[0];

      if (!locked || locked.cursor !== state.cursor) {
        // Another worker advanced the cursor while we fetched. Retry the
        // whole session from the new committed cursor.
        await client.query('ROLLBACK');
        continue;
      }

      await refreshAccounts(client, plaidItemRowId, session.accounts);

      const counts = await applySyncChanges(client, {
        userId,
        plaidItemRowId,
        added: session.added,
        modified: session.modified,
        removed: session.removed,
      });

      const historicalReady = session.updateStatus === HISTORICAL_COMPLETE;
      const initializedAt = locked.initialized_at ?? deps.now();
      const pollExpired =
        deps.now().getTime() - initializedAt.getTime() > pollTimeoutMs();
      const terminal = historicalReady || pollExpired;

      if (pollExpired && !historicalReady) {
        logger.warn('historical sync window expired; completing with available history', {
          itemId: plaidItemRowId,
          updateStatus: session.updateStatus,
        });
      }

      await client.query(
        `UPDATE plaid_sync_state
         SET cursor = $2,
             update_status = $3,
             sync_status = $4,
             initialized_at = COALESCE(initialized_at, NOW()),
             last_synced_at = NOW(),
             oldest_transaction_date = (
               SELECT MIN(date) FROM plaid_transactions
               WHERE plaid_item_id = $1 AND is_removed = FALSE
             ),
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = NOW()
         WHERE plaid_item_id = $1`,
        [
          plaidItemRowId,
          session.finalCursor,
          session.updateStatus,
          terminal ? 'complete' : 'syncing',
        ],
      );

      await client.query('COMMIT');

      logger.info('sync session committed', {
        itemId: plaidItemRowId,
        userId,
        added: counts.added,
        modified: counts.modified,
        removed: counts.removed,
        updateStatus: session.updateStatus,
        terminal,
      });

      if (terminal) {
        await deps.onItemTerminal(userId);
      } else {
        await deps.scheduleResync(payload, pollIntervalSeconds());
      }

      return {
        status: 'synced',
        terminal,
        updateStatus: session.updateStatus,
        counts,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      await recordSyncError(deps.db, plaidItemRowId, err);
      throw err;
    } finally {
      client.release();
    }
  }

  throw new Error(
    `sync for item ${plaidItemRowId} could not complete after ${MAX_SESSION_RESTARTS} attempts`,
  );
}

async function recordSyncError(
  db: Queryable,
  plaidItemRowId: string,
  err: unknown,
): Promise<void> {
  const data = (
    err as { response?: { data?: { error_code?: string; error_message?: string } } }
  )?.response?.data;

  try {
    await db.query(
      `UPDATE plaid_sync_state
       SET last_error_code = $2,
           last_error_message = $3,
           updated_at = NOW()
       WHERE plaid_item_id = $1`,
      [
        plaidItemRowId,
        data?.error_code ?? 'SYNC_ERROR',
        data?.error_message ?? (err instanceof Error ? err.message : 'Unknown error'),
      ],
    );
  } catch (recordErr) {
    logger.error('could not record sync error', {
      itemId: plaidItemRowId,
      error: recordErr instanceof Error ? recordErr : String(recordErr),
    });
  }
}

/**
 * Mark an Item's sync failed terminally (called when its job dead-letters)
 * and let the user-level orchestration decide what that means for the run.
 */
export async function markItemSyncFailed(
  plaidItemRowId: string,
  userId: string,
  onItemTerminal?: (userId: string) => Promise<void>,
): Promise<void> {
  await pool.query(
    `UPDATE plaid_sync_state
     SET sync_status = 'failed', updated_at = NOW()
     WHERE plaid_item_id = $1`,
    [plaidItemRowId],
  );

  if (onItemTerminal) {
    await onItemTerminal(userId);
  } else {
    const { maybeStartUserAnalysis } = await import(
      './analysis-orchestration.service.js'
    );
    await maybeStartUserAnalysis(userId);
  }
}

/** Oldest-history helper re-exported for coverage computations. */
export { getOldestTransactionDate };
