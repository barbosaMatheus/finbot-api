import type { AccountBase } from 'plaid';

import { pool } from '../db.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import {
  PLAID_CLIENT_NAME,
  getHostedLinkRedirectUri,
  getPlaidAndroidPackageName,
  getPlaidClient,
  getPlaidCountryCodes,
  getPlaidProducts,
  getPlaidRedirectUri,
  getRequestedHistoryDays,
} from '../lib/plaid.js';
import { enqueueInitializeItemSync } from '../jobs/enqueue.js';
import { logger } from '../lib/logger.js';
import { ensureSyncState } from './transaction-store.service.js';
import {
  PlaidError,
  type HostedLinkCompletion,
  type LinkTokenResult,
  type PlaidAccountSummary,
  type PlaidConnection,
} from '../types/plaid.js';

type PlaidItemRow = {
  id: string;
  item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  status: string;
  created_at: Date;
};

type PlaidAccountRow = {
  plaid_item_id: string;
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  current_balance: string | null;
  available_balance: string | null;
  iso_currency_code: string | null;
};

/** NUMERIC comes back from pg as a string to preserve precision. */
function toNumber(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function toAccountSummary(row: PlaidAccountRow): PlaidAccountSummary {
  return {
    accountId: row.account_id,
    name: row.name,
    officialName: row.official_name,
    mask: row.mask,
    type: row.type,
    subtype: row.subtype,
    currentBalance: toNumber(row.current_balance),
    availableBalance: toNumber(row.available_balance),
    isoCurrencyCode: row.iso_currency_code,
  };
}

function toConnection(
  item: PlaidItemRow,
  accounts: PlaidAccountRow[],
): PlaidConnection {
  return {
    id: item.id,
    itemId: item.item_id,
    institutionId: item.institution_id,
    institutionName: item.institution_name,
    status: item.status,
    createdAt: item.created_at.toISOString(),
    accounts: accounts.map(toAccountSummary),
  };
}

/**
 * Plaid errors arrive as axios errors with the useful detail nested in the
 * response body. Surface the display message without leaking our credentials
 * or the raw axios payload into logs.
 */
function toPlaidError(err: unknown, fallback: string): PlaidError {
  if (err instanceof PlaidError) {
    return err;
  }

  const response = (
    err as { response?: { data?: { error_message?: string; error_code?: string } } }
  )?.response;
  const data = response?.data;

  if (data?.error_message) {
    console.error(`[plaid] ${data.error_code ?? 'error'}: ${data.error_message}`);

    // Plaid issues a separate secret per environment, and using the wrong one
    // gives no hint that the environment is the problem.
    if (data.error_code === 'INVALID_API_KEYS') {
      return new PlaidError(
        `${data.error_message} — check that PLAID_SECRET is the secret for PLAID_ENV=${
          process.env.PLAID_ENV ?? 'sandbox'
        }.`,
        502,
      );
    }

    return new PlaidError(data.error_message, 502);
  }

  console.error('[plaid]', err);

  return new PlaidError(fallback, 502);
}

/**
 * Step 1 of the standard Plaid flow: create a short-lived link_token scoped to
 * this user. `hosted_link` is always requested so the web client (which cannot
 * load Plaid's native module) has a URL it can open in a browser.
 */
export async function createLinkToken(
  userId: string,
  options: { mode?: 'add' | 'update'; itemRowId?: string } = {},
): Promise<LinkTokenResult> {
  const client = getPlaidClient();
  const redirectUri = getPlaidRedirectUri();
  const androidPackageName = getPlaidAndroidPackageName();
  const completionRedirectUri = getHostedLinkRedirectUri();

  // Update mode: re-authenticate or change account selection on an
  // existing Item. Requires the stored access token and takes no products.
  let updateAccessToken: string | null = null;

  if (options.mode === 'update') {
    if (!options.itemRowId) {
      throw new PlaidError('itemId is required for update mode', 400);
    }

    const { rows } = await pool.query<{ access_token_encrypted: string }>(
      `SELECT access_token_encrypted FROM plaid_items WHERE id = $1 AND user_id = $2`,
      [options.itemRowId, userId],
    );

    if (!rows[0]) {
      throw new PlaidError('Bank connection not found', 404);
    }

    updateAccessToken = decryptSecret(rows[0].access_token_encrypted);
  }

  try {
    const { data } = await client.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: PLAID_CLIENT_NAME,
      country_codes: getPlaidCountryCodes(),
      language: 'en',
      ...(updateAccessToken
        ? {
            access_token: updateAccessToken,
            update: { account_selection_enabled: true },
          }
        : {
            products: getPlaidProducts(),
            // Up to 180 days of history so recurrence detection and
            // baselines have enough signal. Institutions with less simply
            // return what they have.
            transactions: { days_requested: getRequestedHistoryDays() },
          }),
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      ...(androidPackageName ? { android_package_name: androidPackageName } : {}),
      hosted_link: completionRedirectUri
        ? { completion_redirect_uri: completionRedirectUri }
        : {},
    });

    return {
      linkToken: data.link_token,
      expiration: data.expiration ?? null,
      hostedLinkUrl: data.hosted_link_url ?? null,
    };
  } catch (err) {
    throw toPlaidError(err, 'Could not start a bank connection session');
  }
}

/**
 * Step 3 of the standard flow: swap the short-lived public_token for a
 * long-lived access_token, then snapshot the Item's accounts so the app has
 * real data to show. The access token is encrypted before it touches the DB.
 */
export async function exchangePublicToken(
  userId: string,
  publicToken: string,
): Promise<PlaidConnection> {
  const client = getPlaidClient();

  let accessToken: string;
  let itemId: string;

  try {
    const { data } = await client.itemPublicTokenExchange({
      public_token: publicToken,
    });

    accessToken = data.access_token;
    itemId = data.item_id;
  } catch (err) {
    throw toPlaidError(err, 'Could not complete the bank connection');
  }

  let accounts: AccountBase[] = [];
  let institutionId: string | null = null;

  try {
    const { data } = await client.accountsGet({ access_token: accessToken });
    accounts = data.accounts;
    institutionId = data.item.institution_id ?? null;
  } catch (err) {
    throw toPlaidError(err, 'Connected the bank but could not read accounts');
  }

  // Duplicate detection: the same institution re-linked with the same
  // visible accounts should not become a second Item with a second access
  // token. The fresh token is removed and the existing connection returned.
  const duplicate = await findDuplicateConnection(userId, itemId, institutionId, accounts);

  if (duplicate) {
    try {
      await client.itemRemove({ access_token: accessToken });
    } catch (err) {
      logger.warn('could not remove duplicate Plaid item', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('duplicate institution link detected', {
      userId,
      itemId: duplicate.id,
    });

    return { ...duplicate, duplicate: true };
  }

  const institutionName = await resolveInstitutionName(institutionId);

  const connection = await persistConnection({
    userId,
    itemId,
    accessToken,
    institutionId,
    institutionName,
    accounts,
  });

  await startItemSync(userId, connection.id);

  return connection;
}

/**
 * A new Item duplicates an existing one when it is the same institution and
 * every account it exposes matches an existing account's fingerprint
 * (mask + type + subtype). Account ids differ between Items by design, so
 * fingerprints are the only comparable identity.
 */
async function findDuplicateConnection(
  userId: string,
  newItemId: string,
  institutionId: string | null,
  accounts: AccountBase[],
): Promise<PlaidConnection | null> {
  if (!institutionId || accounts.length === 0) {
    return null;
  }

  const existing = await listConnections(userId);

  const fingerprint = (account: {
    mask: string | null;
    type: string;
    subtype: string | null;
  }): string => `${account.mask ?? ''}|${account.type}|${account.subtype ?? ''}`;

  for (const connection of existing) {
    if (connection.status !== 'active') continue;
    if (connection.institutionId !== institutionId) continue;
    if (connection.itemId === newItemId) continue;

    const existingPrints = new Set(connection.accounts.map(fingerprint));

    const allMatch = accounts.every((account) =>
      existingPrints.has(
        fingerprint({
          mask: account.mask ?? null,
          type: account.type,
          subtype: account.subtype ?? null,
        }),
      ),
    );

    if (allMatch) {
      return connection;
    }
  }

  return null;
}

/**
 * Kick off the durable transaction sync for a freshly linked (or re-linked)
 * Item. Best-effort by design: the connection is already committed, so a
 * queue hiccup must not fail the link — declare-complete and retry paths
 * re-ensure syncs as a backstop.
 */
export async function startItemSync(
  userId: string,
  plaidItemRowId: string,
): Promise<void> {
  try {
    await ensureSyncState(pool, plaidItemRowId);
    await enqueueInitializeItemSync({ userId, plaidItemRowId });
  } catch (err) {
    logger.error('could not enqueue item sync initialization', {
      userId,
      itemId: plaidItemRowId,
      error: err instanceof Error ? err : String(err),
    });
  }
}

/**
 * Web fallback: Hosted Link runs in a browser tab and has no callback into the
 * app, so the client polls this with the link_token it was handed. Once Plaid
 * reports a finished session we pull the public_token out of it and run the
 * normal exchange.
 */
export async function completeHostedLink(
  userId: string,
  linkToken: string,
): Promise<HostedLinkCompletion> {
  const client = getPlaidClient();

  let publicToken: string | undefined;

  try {
    const { data } = await client.linkTokenGet({ link_token: linkToken });

    publicToken = data.link_sessions
      ?.flatMap((session) => session.results?.item_add_results ?? [])
      .find((result) => Boolean(result.public_token))?.public_token;
  } catch (err) {
    throw toPlaidError(err, 'Could not check the bank connection session');
  }

  if (!publicToken) {
    return { status: 'pending' };
  }

  const connection = await exchangePublicToken(userId, publicToken);

  return { status: 'connected', connection };
}

/** Best-effort: a missing institution name should never fail the link. */
async function resolveInstitutionName(
  institutionId: string | null,
): Promise<string | null> {
  if (!institutionId) {
    return null;
  }

  try {
    const { data } = await getPlaidClient().institutionsGetById({
      institution_id: institutionId,
      country_codes: getPlaidCountryCodes(),
    });

    return data.institution.name;
  } catch (err) {
    console.error('[plaid] could not resolve institution name', err);
    return null;
  }
}

type PersistConnectionInput = {
  userId: string;
  itemId: string;
  accessToken: string;
  institutionId: string | null;
  institutionName: string | null;
  accounts: AccountBase[];
};

/**
 * Upsert on item_id so re-linking the same institution refreshes the row (and
 * its access token) instead of erroring on the unique constraint.
 */
async function persistConnection(
  input: PersistConnectionInput,
): Promise<PlaidConnection> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: itemRows } = await client.query<PlaidItemRow>(
      `INSERT INTO plaid_items (
         user_id, item_id, access_token_encrypted, institution_id, institution_name, status
       )
       VALUES ($1, $2, $3, $4, $5, 'active')
       ON CONFLICT (item_id) DO UPDATE SET
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         institution_id = EXCLUDED.institution_id,
         institution_name = EXCLUDED.institution_name,
         status = 'active',
         updated_at = NOW()
       RETURNING id, item_id, institution_id, institution_name, status, created_at`,
      [
        input.userId,
        input.itemId,
        encryptSecret(input.accessToken),
        input.institutionId,
        input.institutionName,
      ],
    );

    const item = itemRows[0];

    if (!item) {
      throw new PlaidError('Could not save the bank connection', 500);
    }

    for (const account of input.accounts) {
      await client.query(
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
          item.id,
          account.account_id,
          account.name,
          account.official_name ?? null,
          account.mask ?? null,
          account.type,
          account.subtype ?? null,
          account.balances.current ?? null,
          account.balances.available ?? null,
          account.balances.iso_currency_code ?? null,
        ],
      );
    }

    const { rows: accountRows } = await client.query<PlaidAccountRow>(
      `SELECT plaid_item_id, account_id, name, official_name, mask, type, subtype,
              current_balance, available_balance, iso_currency_code
       FROM plaid_accounts
       WHERE plaid_item_id = $1
       ORDER BY name`,
      [item.id],
    );

    await client.query('COMMIT');

    return toConnection(item, accountRows);
  } catch (err) {
    await client.query('ROLLBACK');

    if (err instanceof Error && err.message.includes('violates foreign key')) {
      throw new PlaidError('User not found', 404);
    }

    throw err;
  } finally {
    client.release();
  }
}

type SyncHealthRow = {
  plaid_item_id: string;
  sync_status: 'pending' | 'syncing' | 'complete' | 'failed';
  update_status: string;
  oldest_transaction_date: string | null;
  last_synced_at: Date | null;
  last_error_code: string | null;
};

/** Everything this user has linked, with per-Item sync health. */
export async function listConnections(userId: string): Promise<PlaidConnection[]> {
  const { rows: itemRows } = await pool.query<PlaidItemRow>(
    `SELECT id, item_id, institution_id, institution_name, status, created_at
     FROM plaid_items
     WHERE user_id = $1
     ORDER BY created_at`,
    [userId],
  );

  if (itemRows.length === 0) {
    return [];
  }

  const itemIds = itemRows.map((item) => item.id);

  const { rows: accountRows } = await pool.query<PlaidAccountRow>(
    `SELECT plaid_item_id, account_id, name, official_name, mask, type, subtype,
            current_balance, available_balance, iso_currency_code
     FROM plaid_accounts
     WHERE plaid_item_id = ANY($1::uuid[])
     ORDER BY name`,
    [itemIds],
  );

  const { rows: healthRows } = await pool.query<SyncHealthRow>(
    `SELECT plaid_item_id, sync_status, update_status,
            oldest_transaction_date::text AS oldest_transaction_date,
            last_synced_at, last_error_code
     FROM plaid_sync_state
     WHERE plaid_item_id = ANY($1::uuid[])`,
    [itemIds],
  );

  const healthByItem = new Map(
    healthRows.map((row) => [
      row.plaid_item_id,
      {
        syncStatus: row.sync_status,
        updateStatus: row.update_status,
        oldestTransactionDate: row.oldest_transaction_date,
        lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
        lastErrorCode: row.last_error_code,
      },
    ]),
  );

  return itemRows.map((item) => ({
    ...toConnection(
      item,
      accountRows.filter((account) => account.plaid_item_id === item.id),
    ),
    health: healthByItem.get(item.id) ?? null,
  }));
}

/**
 * Disconnect one Item: mark it inactive, revoke Plaid access (best
 * effort), and recompute everything that depended on it — the derived
 * onboarding flag immediately, and the analysis via a rebuild when a run
 * is reviewable.
 */
export async function disconnectItem(
  userId: string,
  itemRowId: string,
): Promise<{ recomputeQueued: boolean }> {
  const { rows } = await pool.query<{ access_token_encrypted: string; status: string }>(
    `SELECT access_token_encrypted, status
     FROM plaid_items
     WHERE id = $1 AND user_id = $2`,
    [itemRowId, userId],
  );

  const item = rows[0];

  if (!item) {
    throw new PlaidError('Bank connection not found', 404);
  }

  if (item.status !== 'disconnected') {
    await pool.query(
      `UPDATE plaid_items SET status = 'disconnected', updated_at = NOW() WHERE id = $1`,
      [itemRowId],
    );

    try {
      await getPlaidClient().itemRemove({
        access_token: decryptSecret(item.access_token_encrypted),
      });
    } catch (err) {
      logger.warn('could not revoke Plaid access on disconnect', {
        itemId: itemRowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const lifecycle = await import('./onboarding-lifecycle.service.js');
  const orchestration = await import('./analysis-orchestration.service.js');

  await lifecycle.recomputeOnboardingComplete(pool, userId);

  const run = await lifecycle.getLatestRun(userId);
  let recomputeQueued = false;

  if (run && (run.status === 'review_ready' || run.status === 'recomputing')) {
    const corrections = await import('./corrections.service.js');
    const result = await corrections.requestRecompute(userId);
    recomputeQueued = result.status === 'queued';
  } else if (run && run.status === 'waiting_for_history') {
    await orchestration.maybeStartUserAnalysis(userId);
  }

  logger.info('item disconnected', { userId, itemId: itemRowId, recomputeQueued });

  return { recomputeQueued };
}

/**
 * Decrypt the stored access token for a user's Item. Not used by the link flow
 * itself — this is the seam the transactions/RAG work will call.
 */
export async function getAccessTokenForItem(
  userId: string,
  itemId: string,
): Promise<string> {
  const { rows } = await pool.query<{ access_token_encrypted: string }>(
    'SELECT access_token_encrypted FROM plaid_items WHERE user_id = $1 AND item_id = $2',
    [userId, itemId],
  );

  const row = rows[0];

  if (!row) {
    throw new PlaidError('Bank connection not found', 404);
  }

  return decryptSecret(row.access_token_encrypted);
}

/** Same as above but addressed by our plaid_items.id row key (worker path). */
export async function getAccessTokenForItemRow(
  plaidItemRowId: string,
): Promise<{ userId: string; accessToken: string; status: string }> {
  const { rows } = await pool.query<{
    user_id: string;
    access_token_encrypted: string;
    status: string;
  }>(
    'SELECT user_id, access_token_encrypted, status FROM plaid_items WHERE id = $1',
    [plaidItemRowId],
  );

  const row = rows[0];

  if (!row) {
    throw new PlaidError('Bank connection not found', 404);
  }

  return {
    userId: row.user_id,
    accessToken: decryptSecret(row.access_token_encrypted),
    status: row.status,
  };
}
