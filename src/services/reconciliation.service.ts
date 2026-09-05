/**
 * Transfer and card-payment reconciliation (API-009).
 *
 * Finds the two postings of one real-world movement — the checking outflow
 * and the card credit, or the two sides of an account transfer — scores
 * candidate pairs, selects one-to-one matches greedily by score, and
 * refines both sides' classifications from the link. Prevents the two
 * classic errors: double-counting a card payment as spend, and counting a
 * transfer arrival as income.
 */

import { pool } from '../db.js';
import type { Queryable } from '../lib/db-types.js';
import { logger } from '../lib/logger.js';
import type { UserAnalysisJobPayload } from '../jobs/types.js';
import type { EconomicRole } from '../types/classification.js';

export const RECONCILIATION_RULE_VERSION = 'recon-v1';

/** Subtypes whose inbound transfers are savings/investment movement. */
const SAVINGS_SUBTYPES = new Set([
  'savings',
  'money market',
  'cd',
  'brokerage',
  'ira',
  '401k',
  'hsa',
]);

/** Roles eligible to be the outflow side of a link. */
const OUTFLOW_CANDIDATE_ROLES: ReadonlySet<EconomicRole> = new Set([
  'credit_card_payment',
  'internal_transfer',
  'savings_or_investment_transfer',
  'unknown_outflow',
]);

/** Roles eligible to be the inflow side of a link. */
const INFLOW_CANDIDATE_ROLES: ReadonlySet<EconomicRole> = new Set([
  'credit_card_payment',
  'internal_transfer',
  'unknown_inflow',
]);

export type LinkableTransaction = {
  rowId: string;
  accountId: string;
  accountType: string | null;
  accountSubtype: string | null;
  /** Plaid sign: positive = money out. */
  amount: number;
  date: string;
  isoCurrencyCode: string | null;
  role: EconomicRole;
  classificationSource: string;
  pending: boolean;
};

export type LinkType = 'credit_card_payment' | 'internal_transfer' | 'savings_transfer';

export type ProposedLink = {
  outflowRowId: string;
  inflowRowId: string;
  linkType: LinkType;
  score: number;
  evidence: {
    amount: number;
    dayGap: number;
    outflowRole: EconomicRole;
    inflowRole: EconomicRole;
    outflowAccount: string;
    inflowAccount: string;
  };
};

export type MatchOptions = {
  /** Calendar-day window within which the two postings must occur. */
  dateWindowDays?: number;
  /** Minimum score for a pair to be accepted. */
  scoreThreshold?: number;
};

function parseDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

function linkTypeFor(inflow: LinkableTransaction): LinkType {
  if (inflow.accountType === 'credit') {
    return 'credit_card_payment';
  }

  if (inflow.accountSubtype && SAVINGS_SUBTYPES.has(inflow.accountSubtype)) {
    return 'savings_transfer';
  }

  return 'internal_transfer';
}

/**
 * Stored classification confidence for a link of this match score. The old
 * code stamped every refinement 'high' regardless of evidence; a weakly
 * corroborated match must say so, or a wrong link reads as certainty.
 */
export function confidenceForScore(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.85) return 'high';
  if (score >= 0.7) return 'medium';
  return 'low';
}

/** The refined role both postings receive once linked. */
export function roleForLinkType(linkType: LinkType): EconomicRole {
  switch (linkType) {
    case 'credit_card_payment':
      return 'credit_card_payment';
    case 'savings_transfer':
      return 'savings_or_investment_transfer';
    case 'internal_transfer':
      return 'internal_transfer';
  }
}

function evidenceScore(outflow: LinkableTransaction, inflow: LinkableTransaction): number {
  const outKnown = outflow.role !== 'unknown_outflow';
  const inKnown = inflow.role !== 'unknown_inflow';

  if (outKnown && inKnown) return 0.25;
  if (outKnown || inKnown) return 0.15;
  return 0.08;
}

/**
 * Score all admissible pairs, then pick one-to-one matches greedily from
 * the highest score down. Pure and deterministic (ties break on row ids).
 */
export function proposeLinks(
  transactions: readonly LinkableTransaction[],
  options: MatchOptions = {},
): ProposedLink[] {
  const dateWindowDays = options.dateWindowDays ?? 7;
  const scoreThreshold = options.scoreThreshold ?? 0.6;

  const settled = transactions.filter((txn) => !txn.pending);

  const outflows = settled.filter(
    (txn) => txn.amount > 0 && OUTFLOW_CANDIDATE_ROLES.has(txn.role),
  );
  const inflows = settled.filter(
    (txn) => txn.amount < 0 && INFLOW_CANDIDATE_ROLES.has(txn.role),
  );

  // Index inflows by absolute amount in cents for O(1) candidate lookup.
  const inflowsByAmount = new Map<number, LinkableTransaction[]>();

  for (const inflow of inflows) {
    const cents = Math.round(Math.abs(inflow.amount) * 100);
    const bucket = inflowsByAmount.get(cents);
    if (bucket) bucket.push(inflow);
    else inflowsByAmount.set(cents, [inflow]);
  }

  const scored: ProposedLink[] = [];

  for (const outflow of outflows) {
    const cents = Math.round(Math.abs(outflow.amount) * 100);
    const candidates = inflowsByAmount.get(cents) ?? [];

    for (const inflow of candidates) {
      // Same-account pairs are statement noise, not movement.
      if (inflow.accountId === outflow.accountId) continue;

      // Currencies must agree when known.
      if (
        outflow.isoCurrencyCode &&
        inflow.isoCurrencyCode &&
        outflow.isoCurrencyCode !== inflow.isoCurrencyCode
      ) {
        continue;
      }

      const dayGap = Math.abs(parseDay(outflow.date) - parseDay(inflow.date));

      if (dayGap > dateWindowDays) continue;

      // Two mutually-unknown postings share no corroborating signal beyond
      // the amount, and same amount days apart is exactly how an unrelated
      // $250 check and a $250 deposit collide. Only near-simultaneous
      // posting is strong enough to call them one movement.
      const bothUnknown =
        outflow.role === 'unknown_outflow' && inflow.role === 'unknown_inflow';

      if (bothUnknown && dayGap > 1) continue;

      // Type consistency: a card payment's inflow lands on a credit
      // account; the checking side must not itself be a credit account.
      if (inflow.accountType === 'credit' && outflow.accountType === 'credit') {
        continue;
      }

      const amountScore = 0.5; // exact-cents match required to be a candidate
      const dateScore = 0.25 * Math.max(0, 1 - dayGap / dateWindowDays);
      const score = amountScore + dateScore + evidenceScore(outflow, inflow);

      if (score < scoreThreshold) continue;

      scored.push({
        outflowRowId: outflow.rowId,
        inflowRowId: inflow.rowId,
        linkType: linkTypeFor(inflow),
        score: Math.round(score * 10_000) / 10_000,
        evidence: {
          amount: Math.abs(outflow.amount),
          dayGap,
          outflowRole: outflow.role,
          inflowRole: inflow.role,
          outflowAccount: outflow.accountId,
          inflowAccount: inflow.accountId,
        },
      });
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.outflowRowId.localeCompare(b.outflowRowId) ||
      a.inflowRowId.localeCompare(b.inflowRowId),
  );

  const usedOutflows = new Set<string>();
  const usedInflows = new Set<string>();
  const selected: ProposedLink[] = [];

  for (const candidate of scored) {
    if (usedOutflows.has(candidate.outflowRowId)) continue;
    if (usedInflows.has(candidate.inflowRowId)) continue;

    usedOutflows.add(candidate.outflowRowId);
    usedInflows.add(candidate.inflowRowId);
    selected.push(candidate);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Pipeline job
// ---------------------------------------------------------------------------

export type ReconcileDeps = {
  db: Queryable;
  listLinkable(userId: string): Promise<LinkableTransaction[]>;
  enqueueNextStage(payload: UserAnalysisJobPayload): Promise<unknown>;
};

async function defaultListLinkable(userId: string): Promise<LinkableTransaction[]> {
  const { rows } = await pool.query<{
    row_id: string;
    account_id: string;
    account_type: string | null;
    account_subtype: string | null;
    amount: string;
    date: string;
    iso_currency_code: string | null;
    economic_role: EconomicRole;
    source: string;
    pending: boolean;
  }>(
    `SELECT t.id AS row_id, t.account_id, a.type AS account_type,
            a.subtype AS account_subtype, t.amount::text AS amount,
            t.date::text AS date, t.iso_currency_code,
            c.economic_role, c.source, t.pending
     FROM plaid_transactions t
     JOIN transaction_classifications c ON c.transaction_row_id = t.id
     -- Same active-item filter as the facts read: a disconnected item's
     -- postings must not participate in links the facts then cannot see.
     JOIN plaid_items i ON i.id = t.plaid_item_id AND i.status = 'active'
     LEFT JOIN plaid_accounts a ON a.account_id = t.account_id
     WHERE t.user_id = $1 AND t.is_removed = FALSE`,
    [userId],
  );

  return rows.map((row) => ({
    rowId: row.row_id,
    accountId: row.account_id,
    accountType: row.account_type,
    accountSubtype: row.account_subtype,
    amount: Number(row.amount),
    date: row.date,
    isoCurrencyCode: row.iso_currency_code,
    role: row.economic_role,
    classificationSource: row.source,
    pending: row.pending,
  }));
}

async function defaultDeps(): Promise<ReconcileDeps> {
  const [enqueue, jobs] = await Promise.all([
    import('../jobs/enqueue.js'),
    import('../jobs/types.js'),
  ]);

  return {
    db: pool,
    listLinkable: defaultListLinkable,
    enqueueNextStage: (payload) =>
      enqueue.enqueueAnalysisStage(jobs.JOB.DETECT_USER_RECURRING, payload),
  };
}

function dateWindowFromEnv(): number {
  const parsed = Number.parseInt(process.env.RECONCILE_DATE_WINDOW_DAYS ?? '7', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}

/**
 * RECONCILE_USER_TRANSFERS: rebuild the user's links from scratch (pure
 * derivation, so replay converges), refine linked classifications without
 * ever touching user overrides, then chain recurrence detection.
 */
export async function reconcileUserTransfers(
  payload: UserAnalysisJobPayload,
  depsOverride?: ReconcileDeps,
): Promise<{ links: number }> {
  const deps = depsOverride ?? (await defaultDeps());

  const transactions = await deps.listLinkable(payload.userId);
  const links = proposeLinks(transactions, { dateWindowDays: dateWindowFromEnv() });

  await deps.db.query(`DELETE FROM transaction_links WHERE user_id = $1`, [
    payload.userId,
  ]);

  for (const link of links) {
    await deps.db.query(
      `INSERT INTO transaction_links (
         user_id, outflow_transaction_row_id, inflow_transaction_row_id,
         link_type, match_score, evidence, rule_version
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        payload.userId,
        link.outflowRowId,
        link.inflowRowId,
        link.linkType,
        link.score,
        JSON.stringify(link.evidence),
        RECONCILIATION_RULE_VERSION,
      ],
    );

    const refinedRole = roleForLinkType(link.linkType);

    // Refine both sides from the link evidence — but a user's explicit
    // correction always outranks reconciliation.
    await deps.db.query(
      `UPDATE transaction_classifications
       SET economic_role = $2,
           display_bucket = NULL,
           source = 'reconciliation',
           rule_id = $3,
           rule_version = $4,
           confidence = $6,
           explanation = $5,
           updated_at = NOW()
       WHERE transaction_row_id = ANY($1::uuid[])
         AND source <> 'user_override'`,
      [
        [link.outflowRowId, link.inflowRowId],
        refinedRole,
        `link-${link.linkType}`,
        RECONCILIATION_RULE_VERSION,
        `Matched to its counterpart posting (score ${link.score}).`,
        confidenceForScore(link.score),
      ],
    );
  }

  logger.info('reconciliation complete', {
    userId: payload.userId,
    analysisRunId: payload.analysisRunId,
    links: links.length,
  });

  await deps.enqueueNextStage(payload);

  return { links: links.length };
}
