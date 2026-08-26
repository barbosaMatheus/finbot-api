/**
 * Persistence for Plaid transactions and per-Item sync state.
 *
 * All writes here are idempotent upserts keyed on Plaid's transaction_id so
 * at-least-once jobs and full replays converge on the same rows. Cursor
 * advancement lives with the caller (the sync job) and must happen in the
 * same database transaction as the page's changes.
 */

import type { RemovedTransaction, Transaction } from 'plaid';

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { normalizeMerchant } from '../lib/merchant.js';
import type {
  NormalizedTransaction,
  PfcConfidence,
  StoredTransaction,
  SyncChangeCounts,
} from '../types/transactions.js';

const PFC_CONFIDENCE_VALUES: readonly PfcConfidence[] = [
  'VERY_HIGH',
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNKNOWN',
];

function toPfcConfidence(value: string | null | undefined): PfcConfidence | null {
  if (!value) {
    return null;
  }

  const upper = value.toUpperCase() as PfcConfidence;
  return PFC_CONFIDENCE_VALUES.includes(upper) ? upper : 'UNKNOWN';
}

/**
 * Extract the normalized columns from a raw Plaid transaction. Pure, so the
 * sign and PFC mappings can be tested without a database.
 */
export function normalizeTransaction(txn: Transaction): NormalizedTransaction {
  return {
    transactionId: txn.transaction_id,
    accountId: txn.account_id,
    pendingTransactionId: txn.pending_transaction_id ?? null,
    date: txn.date,
    authorizedDate: txn.authorized_date ?? null,
    amount: txn.amount,
    isoCurrencyCode: txn.iso_currency_code ?? null,
    pending: txn.pending,
    name: txn.name ?? null,
    merchantName: txn.merchant_name ?? null,
    merchantNormalized: normalizeMerchant(txn.merchant_name, txn.name),
    paymentChannel: txn.payment_channel ?? null,
    pfcPrimary: txn.personal_finance_category?.primary ?? null,
    pfcDetailed: txn.personal_finance_category?.detailed ?? null,
    pfcConfidence: toPfcConfidence(txn.personal_finance_category?.confidence_level),
    pfcVersion: 'v2',
    transactionCode: txn.transaction_code ?? null,
    raw: txn,
  };
}

export async function ensureSyncState(
  db: Queryable,
  plaidItemRowId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO plaid_sync_state (plaid_item_id)
     VALUES ($1)
     ON CONFLICT (plaid_item_id) DO NOTHING`,
    [plaidItemRowId],
  );
}

export type SyncStateRow = {
  plaid_item_id: string;
  cursor: string | null;
  update_status: string;
  sync_status: 'pending' | 'syncing' | 'complete' | 'failed';
  oldest_transaction_date: Date | null;
  initialized_at: Date | null;
  last_synced_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

/**
 * Lock this Item's sync row for the duration of the caller's transaction.
 * This is the "only one cursor-advancing job per Item" guarantee: a second
 * concurrent job blocks here until the first commits, then sees its cursor.
 */
export async function lockSyncState(
  db: Queryable,
  plaidItemRowId: string,
): Promise<SyncStateRow | null> {
  const { rows } = await db.query<SyncStateRow>(
    `SELECT plaid_item_id, cursor, update_status, sync_status,
            oldest_transaction_date, initialized_at, last_synced_at,
            last_error_code, last_error_message
     FROM plaid_sync_state
     WHERE plaid_item_id = $1
     FOR UPDATE`,
    [plaidItemRowId],
  );

  return rows[0] ?? null;
}

export async function getSyncState(
  plaidItemRowId: string,
  db: Queryable = pool,
): Promise<SyncStateRow | null> {
  const { rows } = await db.query<SyncStateRow>(
    `SELECT plaid_item_id, cursor, update_status, sync_status,
            oldest_transaction_date, initialized_at, last_synced_at,
            last_error_code, last_error_message
     FROM plaid_sync_state
     WHERE plaid_item_id = $1`,
    [plaidItemRowId],
  );

  return rows[0] ?? null;
}

/**
 * Apply one page of /transactions/sync changes. Caller owns the transaction
 * and commits the cursor alongside. Upserts converge on replay; removed ids
 * flip is_removed rather than deleting evidence.
 */
export async function applySyncChanges(
  db: Queryable,
  input: {
    userId: string;
    plaidItemRowId: string;
    added: Transaction[];
    modified: Transaction[];
    removed: RemovedTransaction[];
  },
): Promise<SyncChangeCounts> {
  let added = 0;
  let modified = 0;

  for (const [list, isModification] of [
    [input.added, false],
    [input.modified, true],
  ] as const) {
    for (const txn of list) {
      const normalized = normalizeTransaction(txn);

      const { rowCount } = await db.query(
        `INSERT INTO plaid_transactions (
           user_id, plaid_item_id, account_id, transaction_id,
           pending_transaction_id, date, authorized_date, amount,
           iso_currency_code, pending, name, merchant_name,
           merchant_normalized, payment_channel, pfc_primary, pfc_detailed,
           pfc_confidence, pfc_version, transaction_code, raw
         )
         VALUES (
           $1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20::jsonb
         )
         ON CONFLICT (transaction_id) DO UPDATE SET
           pending_transaction_id = EXCLUDED.pending_transaction_id,
           date = EXCLUDED.date,
           authorized_date = EXCLUDED.authorized_date,
           amount = EXCLUDED.amount,
           iso_currency_code = EXCLUDED.iso_currency_code,
           pending = EXCLUDED.pending,
           name = EXCLUDED.name,
           merchant_name = EXCLUDED.merchant_name,
           merchant_normalized = EXCLUDED.merchant_normalized,
           payment_channel = EXCLUDED.payment_channel,
           pfc_primary = EXCLUDED.pfc_primary,
           pfc_detailed = EXCLUDED.pfc_detailed,
           pfc_confidence = EXCLUDED.pfc_confidence,
           pfc_version = EXCLUDED.pfc_version,
           transaction_code = EXCLUDED.transaction_code,
           raw = EXCLUDED.raw,
           is_removed = FALSE,
           removed_at = NULL,
           last_modified_at = NOW(),
           updated_at = NOW()`,
        [
          input.userId,
          input.plaidItemRowId,
          normalized.accountId,
          normalized.transactionId,
          normalized.pendingTransactionId,
          normalized.date,
          normalized.authorizedDate,
          normalized.amount,
          normalized.isoCurrencyCode,
          normalized.pending,
          normalized.name,
          normalized.merchantName,
          normalized.merchantNormalized,
          normalized.paymentChannel,
          normalized.pfcPrimary,
          normalized.pfcDetailed,
          normalized.pfcConfidence,
          normalized.pfcVersion,
          normalized.transactionCode,
          JSON.stringify(normalized.raw),
        ],
      );

      if (isModification) {
        modified += rowCount ?? 0;
      } else {
        added += rowCount ?? 0;
      }
    }
  }

  let removed = 0;

  if (input.removed.length > 0) {
    const { rowCount } = await db.query(
      `UPDATE plaid_transactions
       SET is_removed = TRUE,
           removed_at = COALESCE(removed_at, NOW()),
           updated_at = NOW()
       WHERE plaid_item_id = $1 AND transaction_id = ANY($2::text[])`,
      [
        input.plaidItemRowId,
        input.removed.map((entry) => entry.transaction_id),
      ],
    );

    removed = rowCount ?? 0;
  }

  return { added, modified, removed };
}

type StoredTransactionRow = {
  row_id: string;
  user_id: string;
  plaid_item_id: string;
  account_id: string;
  transaction_id: string;
  pending_transaction_id: string | null;
  date: string;
  authorized_date: string | null;
  amount: string;
  iso_currency_code: string | null;
  pending: boolean;
  name: string | null;
  merchant_name: string | null;
  merchant_normalized: string | null;
  payment_channel: string | null;
  pfc_primary: string | null;
  pfc_detailed: string | null;
  pfc_confidence: string | null;
  pfc_version: string;
  transaction_code: string | null;
  raw: unknown;
  is_removed: boolean;
  account_type: string | null;
  account_subtype: string | null;
};

function toStoredTransaction(row: StoredTransactionRow): StoredTransaction {
  return {
    rowId: row.row_id,
    userId: row.user_id,
    plaidItemRowId: row.plaid_item_id,
    accountId: row.account_id,
    transactionId: row.transaction_id,
    pendingTransactionId: row.pending_transaction_id,
    date: row.date,
    authorizedDate: row.authorized_date,
    amount: Number(row.amount),
    isoCurrencyCode: row.iso_currency_code,
    pending: row.pending,
    name: row.name,
    merchantName: row.merchant_name,
    merchantNormalized: row.merchant_normalized,
    paymentChannel: row.payment_channel,
    pfcPrimary: row.pfc_primary,
    pfcDetailed: row.pfc_detailed,
    pfcConfidence: toPfcConfidence(row.pfc_confidence),
    pfcVersion: row.pfc_version,
    transactionCode: row.transaction_code,
    raw: row.raw,
    isRemoved: row.is_removed,
    accountType: row.account_type,
    accountSubtype: row.account_subtype,
  };
}

/**
 * Every live (non-removed) stored transaction for a user, oldest first, with
 * account type context joined in for classification.
 */
export async function listUserTransactions(
  userId: string,
  options: { includePending?: boolean; sinceDate?: string } = {},
  db: Queryable = pool,
): Promise<StoredTransaction[]> {
  const { rows } = await db.query<StoredTransactionRow>(
    `SELECT t.id AS row_id, t.user_id, t.plaid_item_id, t.account_id,
            t.transaction_id, t.pending_transaction_id,
            t.date::text AS date, t.authorized_date::text AS authorized_date,
            t.amount::text AS amount, t.iso_currency_code, t.pending, t.name,
            t.merchant_name, t.merchant_normalized, t.payment_channel,
            t.pfc_primary, t.pfc_detailed, t.pfc_confidence, t.pfc_version,
            t.transaction_code, t.raw, t.is_removed,
            a.type AS account_type, a.subtype AS account_subtype
     FROM plaid_transactions t
     LEFT JOIN plaid_accounts a ON a.account_id = t.account_id
     WHERE t.user_id = $1
       AND t.is_removed = FALSE
       AND ($2::boolean OR t.pending = FALSE)
       AND ($3::date IS NULL OR t.date >= $3::date)
     ORDER BY t.date ASC, t.transaction_id ASC`,
    [userId, options.includePending ?? false, options.sinceDate ?? null],
  );

  return rows.map(toStoredTransaction);
}

/** Oldest live settled transaction date per Item, for history coverage. */
export async function getOldestTransactionDate(
  plaidItemRowId: string,
  db: Queryable = pool,
): Promise<string | null> {
  const { rows } = await db.query<{ oldest: string | null }>(
    `SELECT MIN(date)::text AS oldest
     FROM plaid_transactions
     WHERE plaid_item_id = $1 AND is_removed = FALSE`,
    [plaidItemRowId],
  );

  return rows[0]?.oldest ?? null;
}
