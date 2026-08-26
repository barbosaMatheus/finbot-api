/**
 * Stored-transaction domain types.
 *
 * Sign convention follows Plaid verbatim end to end: `amount` is positive
 * when money leaves the account and negative when money arrives. Every
 * consumer (classification, reconciliation, facts) reads this one shape.
 */

export type PfcConfidence = 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

/** Normalized fields extracted from one raw Plaid transaction. */
export type NormalizedTransaction = {
  transactionId: string;
  accountId: string;
  pendingTransactionId: string | null;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  authorizedDate: string | null;
  /** Positive = money out, negative = money in (Plaid convention). */
  amount: number;
  isoCurrencyCode: string | null;
  pending: boolean;
  name: string | null;
  merchantName: string | null;
  merchantNormalized: string | null;
  paymentChannel: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  pfcConfidence: PfcConfidence | null;
  pfcVersion: string;
  transactionCode: string | null;
  /** The full raw Plaid payload, stored as immutable evidence. */
  raw: unknown;
};

/** A transaction as persisted, with our row identity and account context. */
export type StoredTransaction = NormalizedTransaction & {
  rowId: string;
  userId: string;
  plaidItemRowId: string;
  isRemoved: boolean;
  /** Account context needed by classification. */
  accountType: string | null;
  accountSubtype: string | null;
};

export type SyncChangeCounts = {
  added: number;
  modified: number;
  removed: number;
};
