/**
 * Review and coverage domain types (API-012).
 *
 * A review snapshot carries two distinct concepts: calculation correctness
 * (exact arithmetic over the selected records — the facts) and coverage
 * (how complete those records are for the question being asked). Coverage
 * is expressed as named bands with reasons, never as an invented
 * confidence percentage.
 */

export type CoverageBand = 'complete' | 'partial' | 'insufficient';

export type CoverageReasonCode =
  | 'NO_USABLE_ITEM'
  | 'ITEM_FAILED'
  | 'LIMITED_HISTORY'
  | 'UNLINKED_CARD_PAYMENT'
  | 'LOW_CATEGORY_COVERAGE'
  | 'UNRESOLVED_TRANSFERS'
  | 'HIGH_UNKNOWN_SHARE'
  | 'NO_CREDIT_VISIBILITY'
  | 'STALE_SYNC';

export type CoverageReason = {
  code: CoverageReasonCode;
  message: string;
};

export type Coverage = {
  band: CoverageBand;
  reasons: CoverageReason[];
  dimensions: {
    accounts: {
      connectedItems: number;
      usableItems: number;
      failedItems: number;
      hasDepository: boolean;
      hasCredit: boolean;
    };
    history: {
      requestedDays: number;
      observedDays: number;
      perItem: Array<{
        itemRowId: string;
        institutionName: string | null;
        historyDays: number | null;
        status: 'ready' | 'limited' | 'failed' | 'pending';
      }>;
    };
    transferResolution: {
      /** Share of movement-shaped value that resolved to a known role, 0–1. */
      rate: number;
    };
    categories: {
      /** Share of gross economic spend with a real display bucket, 0–1. */
      categorizedShare: number;
    };
    freshness: {
      lastSyncedAt: string | null;
      pendingCount: number;
    };
  };
};

export type ReviewItemType =
  | 'external_card_payment_unattributed'
  | 'income_mismatch'
  | 'institution_connection_failed'
  | 'limited_history'
  | 'high_unknown_activity'
  | 'unconfirmed_recurring_stream';

export type ReviewItemStatus = 'open' | 'resolved' | 'accepted' | 'dismissed';

export type ReviewItemAction =
  | 'connect_account'
  | 'accept_coverage_limitation'
  | 'reconnect_institution'
  | 'keep_manual_value'
  | 'use_observed_value'
  | 'set_value'
  | 'confirm_stream'
  | 'dismiss_stream'
  | 'reclassify_transaction'
  | 'reclassify_merchant';

export type GeneratedReviewItem = {
  itemKey: string;
  type: ReviewItemType;
  required: boolean;
  evidence: Record<string, unknown>;
  proposedValue: Record<string, unknown> | null;
  allowedActions: ReviewItemAction[];
};

export type ReviewItemRecord = GeneratedReviewItem & {
  id: string;
  status: ReviewItemStatus;
  confirmedValue: unknown;
  resolvedAt: string | null;
};
