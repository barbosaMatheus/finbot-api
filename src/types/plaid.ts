/** Domain error for the Plaid feature, mapped to an HTTP status in routes/plaid.ts. */
export class PlaidError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PlaidError';
  }
}

/** Everything the client needs to launch Link, native or hosted. */
export type LinkTokenResult = {
  linkToken: string;
  expiration: string | null;
  /** Only present when Hosted Link is enabled; used by the web fallback. */
  hostedLinkUrl: string | null;
};

export type PlaidAccountSummary = {
  accountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  currentBalance: number | null;
  availableBalance: number | null;
  isoCurrencyCode: string | null;
};

/** A linked Item plus its accounts. Never exposes the access token. */
export type PlaidConnection = {
  id: string;
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  status: string;
  createdAt: string;
  accounts: PlaidAccountSummary[];
  /** Present when the caller asked for health (connections listing). */
  health?: ConnectionHealth | null;
  /** True when this exchange matched an already-linked institution. */
  duplicate?: boolean;
};

/**
 * Result of polling a Hosted Link session. `pending` means the user has not
 * finished in the browser yet, so the client should keep polling.
 */
export type HostedLinkCompletion =
  | { status: 'pending' }
  | { status: 'connected'; connection: PlaidConnection };

/** Sync health surfaced with each connection (null before first sync). */
export type ConnectionHealth = {
  syncStatus: 'pending' | 'syncing' | 'complete' | 'failed';
  updateStatus: string;
  oldestTransactionDate: string | null;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
};
