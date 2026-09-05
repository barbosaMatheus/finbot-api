/**
 * End-to-end pipeline integration test (API-017 / G3 evidence).
 *
 * Runs the complete backend flow against a REAL Postgres — migrations,
 * fixture-driven Plaid sync, classification, reconciliation, recurrence,
 * facts, review, corrections, and confirmation — exercising the actual SQL
 * every stage executes. Guarded: skipped unless TEST_DATABASE_URL is set
 * (point it at the compose database, e.g.
 * postgres://finbot:finbot@localhost:5432/finbot).
 */

import './helpers/e2e-env.js';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import type { Transaction } from 'plaid';

const RUN_E2E = Boolean(process.env.TEST_DATABASE_URL);
const describeIf = RUN_E2E ? describe : describe.skip;

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import { pool, closePool } from '../src/db.js';
import { runMigrations } from '../src/db/migrate.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { maybeStartUserAnalysis } from '../src/services/analysis-orchestration.service.js';
import { classifyUserTransactions } from '../src/services/classification.service.js';
import { applyReviewItemAction } from '../src/services/corrections.service.js';
import { listUserTransactions } from '../src/services/transaction-store.service.js';
import {
  buildFinancialReview,
  getFinancialReviewForUser,
} from '../src/services/review.service.js';
import { detectUserRecurring } from '../src/services/recurrence.service.js';
import { reconcileUserTransfers } from '../src/services/reconciliation.service.js';
import {
  declareLinkingComplete,
  ensureActiveRun,
  getLatestRun,
  transitionRun,
} from '../src/services/onboarding-lifecycle.service.js';
import {
  confirmFinancialReview,
  getOnboardingStatus,
} from '../src/services/onboarding-status.service.js';
import {
  syncItemTransactions,
  type PlaidSyncClient,
  type SyncDeps,
} from '../src/services/plaid-sync.service.js';
import type { UserAnalysisJobPayload } from '../src/jobs/types.js';

const NOW = new Date('2026-08-24T12:00:00Z');
const TODAY = '2026-08-24';

let userId: string;
let itemRowId: string;

function txn(
  id: string,
  accountId: string,
  date: string,
  amount: number,
  fields: Partial<Transaction> = {},
): Transaction {
  return {
    transaction_id: id,
    account_id: accountId,
    amount,
    iso_currency_code: 'USD',
    date,
    authorized_date: null,
    name: null,
    merchant_name: null,
    pending: false,
    pending_transaction_id: null,
    payment_channel: 'other',
    personal_finance_category: null,
    transaction_code: null,
    ...fields,
  } as unknown as Transaction;
}

/** Six months of fixture history: payroll, rent, netflix, card activity. */
function fixtureTransactions(): Transaction[] {
  const out: Transaction[] = [];

  // Biweekly payroll into checking: 2026-03-08 .. 2026-08-23 (13 deposits).
  for (let i = 0; i < 13; i += 1) {
    const ms = Date.parse('2026-03-08T00:00:00Z') + i * 14 * 86_400_000;
    out.push(
      txn(`payroll-${i}`, 'acc-checking', new Date(ms).toISOString().slice(0, 10), -2600, {
        name: 'ACME CORP DES: PAYROLL',
        personal_finance_category: {
          primary: 'INCOME',
          detailed: 'INCOME_WAGES',
          confidence_level: 'VERY_HIGH',
        },
      }),
    );
  }

  // Monthly rent from checking.
  for (let month = 3; month <= 8; month += 1) {
    out.push(
      txn(`rent-${month}`, 'acc-checking', `2026-0${month}-01`, 1800, {
        name: 'SUNRISE PROPERTY RENT',
        merchant_name: 'Sunrise Property',
        personal_finance_category: {
          primary: 'RENT_AND_UTILITIES',
          detailed: 'RENT_AND_UTILITIES_RENT',
          confidence_level: 'VERY_HIGH',
        },
      }),
    );
  }

  // Monthly Netflix on the linked card.
  for (let month = 3; month <= 8; month += 1) {
    out.push(
      txn(`netflix-${month}`, 'acc-card', `2026-0${month}-15`, 15.49, {
        name: 'NETFLIX.COM',
        merchant_name: 'Netflix',
        personal_finance_category: {
          primary: 'ENTERTAINMENT',
          detailed: 'ENTERTAINMENT_STREAMING',
          confidence_level: 'VERY_HIGH',
        },
      }),
    );
  }

  // Card groceries + the matched checking->card payment pair each month.
  for (let month = 3; month <= 8; month += 1) {
    out.push(
      txn(`grocery-${month}`, 'acc-card', `2026-0${month}-10`, 420.5, {
        name: 'WHOLE FOODS MARKET',
        merchant_name: 'Whole Foods',
        personal_finance_category: {
          primary: 'FOOD_AND_DRINK',
          detailed: 'FOOD_AND_DRINK_GROCERIES',
          confidence_level: 'VERY_HIGH',
        },
      }),
    );

    out.push(
      txn(`pay-out-${month}`, 'acc-checking', `2026-0${month}-20`, 435.99, {
        name: 'CHASE CARD AUTOPAY',
        personal_finance_category: {
          primary: 'LOAN_PAYMENTS',
          detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
          confidence_level: 'VERY_HIGH',
        },
      }),
    );
    out.push(
      txn(`pay-in-${month}`, 'acc-card', `2026-0${month}-21`, -435.99, {
        name: 'ONLINE PAYMENT THANK YOU',
      }),
    );
  }

  // Payments to an UNLINKED external card: cash obligation + coverage gap.
  for (let month = 3; month <= 8; month += 1) {
    out.push(
      txn(`ext-card-${month}`, 'acc-checking', `2026-0${month}-25`, 820, {
        name: 'AMEX EPAYMENT AUTOPAY',
        personal_finance_category: {
          primary: 'LOAN_PAYMENTS',
          detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
          confidence_level: 'HIGH',
        },
      }),
    );
  }

  // A refund pair on the card.
  out.push(
    txn('tv-buy', 'acc-card', '2026-07-02', 499.99, {
      name: 'BEST BUY',
      merchant_name: 'Best Buy',
      personal_finance_category: {
        primary: 'GENERAL_MERCHANDISE',
        detailed: 'GENERAL_MERCHANDISE_ELECTRONICS',
        confidence_level: 'VERY_HIGH',
      },
    }),
    txn('tv-refund', 'acc-card', '2026-07-09', -499.99, {
      name: 'BEST BUY REFUND',
      merchant_name: 'Best Buy',
      personal_finance_category: {
        primary: 'GENERAL_MERCHANDISE',
        detailed: 'GENERAL_MERCHANDISE_ELECTRONICS',
        confidence_level: 'HIGH',
      },
    }),
  );

  return out;
}

const fixtureAccounts = [
  {
    account_id: 'acc-checking',
    name: 'Everyday Checking',
    official_name: null,
    mask: '1111',
    type: 'depository',
    subtype: 'checking',
    balances: { current: 5200, available: 4900, iso_currency_code: 'USD' },
  },
  {
    account_id: 'acc-card',
    name: 'Rewards Card',
    official_name: null,
    mask: '2222',
    type: 'credit',
    subtype: 'credit card',
    balances: { current: 436, available: null, iso_currency_code: 'USD' },
  },
];

function fixturePlaid(): PlaidSyncClient {
  return {
    async transactionsSync(request) {
      if (request.cursor) {
        return {
          data: {
            added: [],
            modified: [],
            removed: [],
            accounts: fixtureAccounts,
            next_cursor: 'cursor-final',
            has_more: false,
            transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
          } as never,
        };
      }

      return {
        data: {
          added: fixtureTransactions(),
          modified: [],
          removed: [],
          accounts: fixtureAccounts,
          next_cursor: 'cursor-final',
          has_more: false,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        } as never,
      };
    },
  };
}

describeIf('end-to-end financial onboarding pipeline (real Postgres)', () => {
  beforeAll(async () => {
    await runMigrations();

    userId = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
      [userId, `e2e-${userId}@test.local`],
    );

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO plaid_items (user_id, item_id, access_token_encrypted, institution_id, institution_name, status)
       VALUES ($1, $2, $3, 'ins_e2e', 'E2E Bank', 'active')
       RETURNING id`,
      [userId, `item-${userId}`, encryptSecret('access-e2e-token')],
    );

    itemRowId = rows[0]!.id;

    // Manual profile answers (the wizard's output), saved directly.
    await pool.query(
      `INSERT INTO user_info (
         user_id, first_name, dependents_count, shared_accounts, income_pattern,
         declared_obligations, upcoming_events, primary_goal, secondary_goals,
         goal_detail, coaching_pace, income_override
       ) VALUES (
         $1, 'E2E', 0, FALSE, 'steady',
         '[]'::jsonb, '{}', 'build_cushion', ARRAY['pay_down_debt'],
         NULL, 'balanced', 9500
       )`,
      [userId],
    );

    await pool.query(
      `UPDATE users SET manual_profile_completed_at = NOW() WHERE id = $1`,
      [userId],
    );
  }, 60_000);

  afterAll(async () => {
    if (userId) {
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }

    await closePool();
  });

  test('the full flow: sync → analyze → review → correct → confirm', async () => {
    // --- Link phase: declare done, run created --------------------------
    await declareLinkingComplete(userId);
    const run = await ensureActiveRun(userId);

    expect(run.status).toBe('waiting_for_history');

    // --- Item sync with fixture pages (no queue; direct invocation) -----
    const analysisStarts: UserAnalysisJobPayload[] = [];
    const orchestrationResults: string[] = [];

    const syncDeps: SyncDeps = {
      plaid: fixturePlaid(),
      db: pool as unknown as SyncDeps['db'],
      getAccessToken: async () => ({
        userId,
        accessToken: 'access-e2e-token',
        status: 'active',
      }),
      scheduleResync: async () => null,
      onItemTerminal: async (uid) => {
        orchestrationResults.push(
          await maybeStartUserAnalysis(uid, {
            enqueueAnalysis: async (payload) => {
              analysisStarts.push(payload);
              return null;
            },
          }),
        );
      },
      now: () => NOW,
    };

    const syncOutcome = await syncItemTransactions(
      { plaidItemRowId: itemRowId, userId },
      syncDeps,
    );

    expect(syncOutcome.terminal).toBe(true);
    expect(analysisStarts).toHaveLength(1);

    const payload = analysisStarts[0]!;

    // Replaying the sync must not duplicate anything, and the second
    // terminal signal must not restart the already-processing analysis.
    await syncItemTransactions({ plaidItemRowId: itemRowId, userId }, syncDeps);
    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM plaid_transactions WHERE user_id = $1`,
      [userId],
    );
    expect(Number(countRows[0]!.count)).toBe(fixtureTransactions().length);
    expect(orchestrationResults).toEqual(['started', 'skipped']);
    expect(analysisStarts).toHaveLength(1);

    // --- Pipeline stages (as the worker chain runs them) ----------------
    const noop = async () => null;

    await classifyUserTransactions(payload, {
      db: pool,
      listTransactions: async (uid) =>
        listUserTransactions(uid, { includePending: true }),
      enqueueNextStage: noop,
    });

    await reconcileUserTransfers(payload, {
      db: pool,
      listLinkable: async () => {
        const { rows } = await pool.query<{
          row_id: string;
          account_id: string;
          account_type: string | null;
          account_subtype: string | null;
          amount: string;
          date: string;
          iso_currency_code: string | null;
          economic_role: never;
          source: string;
          pending: boolean;
        }>(
          `SELECT t.id AS row_id, t.account_id, a.type AS account_type,
                  a.subtype AS account_subtype, t.amount::text AS amount,
                  t.date::text AS date, t.iso_currency_code,
                  c.economic_role, c.source, t.pending
           FROM plaid_transactions t
           JOIN transaction_classifications c ON c.transaction_row_id = t.id
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
      },
      enqueueNextStage: noop,
    });

    // Six monthly card-payment pairs must have linked one-to-one.
    const { rows: linkRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM transaction_links WHERE user_id = $1`,
      [userId],
    );
    expect(Number(linkRows[0]!.count)).toBe(6);

    await detectUserRecurring(payload, {
      db: pool,
      listInputs: async () => {
        const { rows } = await pool.query<{
          row_id: string;
          merchant_normalized: string | null;
          merchant_name: string | null;
          name: string | null;
          amount: string;
          date: string;
          pending: boolean;
          economic_role: never;
        }>(
          `SELECT t.id AS row_id, t.merchant_normalized, t.merchant_name,
                  t.name, t.amount::text AS amount, t.date::text AS date,
                  t.pending, c.economic_role
           FROM plaid_transactions t
           JOIN transaction_classifications c ON c.transaction_row_id = t.id
           WHERE t.user_id = $1 AND t.is_removed = FALSE`,
          [userId],
        );

        return rows.map((row) => ({
          rowId: row.row_id,
          merchantKey: row.merchant_normalized,
          displayName: row.merchant_name ?? row.name,
          amount: Number(row.amount),
          date: row.date,
          pending: row.pending,
          role: row.economic_role,
        }));
      },
      enqueueNextStage: noop,
    });

    const reviewResult = await buildFinancialReview(payload, {
      db: pool,
      loadData: async (uid) => {
        const { loadFactsData } = await import(
          '../src/services/financial-facts.service.js'
        );
        return loadFactsData(uid);
      },
      getItems: async (uid) => {
        const { getItemSyncOverviews } = await import(
          '../src/services/analysis-orchestration.service.js'
        );
        return getItemSyncOverviews(uid, pool, NOW);
      },
      getRun: async (runId) => {
        const { rows } = await pool.query<{
          status: string;
          requested_lookback_days: number;
          started_at: Date;
        }>(
          `SELECT status, requested_lookback_days, started_at
           FROM financial_analysis_runs WHERE id = $1`,
          [runId],
        );
        return rows[0]
          ? {
              status: rows[0].status,
              requestedLookbackDays: rows[0].requested_lookback_days,
              startedAt: rows[0].started_at.toISOString(),
            }
          : null;
      },
      getManualMonthlyIncome: async (uid) => {
        const { rows } = await pool.query<{ income_override: string | null }>(
          `SELECT income_override FROM user_info WHERE user_id = $1`,
          [uid],
        );
        const override = rows[0]?.income_override ?? null;
        return override === null ? null : Number(override);
      },
      getUnknownActivity: async () => ({
        topMerchants: [],
        sampleTransactions: [],
      }),
      transitionRun: (runId, to) => transitionRun(runId, to),
      onReviewReady: async () => {},
      now: () => NOW,
    });

    expect(reviewResult.snapshotVersion).toBe(1);

    // --- The review -----------------------------------------------------
    const review = await getFinancialReviewForUser(userId);

    expect(review.status).toBe('needs_confirmation');
    expect(review.period.throughDate).toBe(TODAY);

    // Income: 13 biweekly 2600 deposits ≈ 5653/month via the stream.
    expect(review.facts.monthlyIncomeEstimate).toBeGreaterThan(5000);
    expect(review.facts.monthlyIncomeEstimate).toBeLessThan(6200);
    expect(review.fullFacts.income.estimateSource).toBe('recurring_streams');

    // Card purchases count once: linked payments are movement, not spend.
    expect(review.fullFacts.movement.linkedCardPaymentTotal).toBeCloseTo(
      6 * 435.99,
      1,
    );
    expect(review.fullFacts.movement.externalCardPaymentTotal).toBeCloseTo(
      6 * 820,
      1,
    );

    // The refund nets out of spend.
    expect(review.fullFacts.spend.refundsAndCredits).toBeCloseTo(499.99, 1);

    // Coverage: partial, because of the unlinked external card.
    expect(review.coverage.band).toBe('partial');
    expect(review.coverage.reasons.map((r) => r.code)).toContain(
      'UNLINKED_CARD_PAYMENT',
    );

    // Required review items: external card + income mismatch (9500 manual
    // vs ~5650 observed differs by >25%).
    const requiredTypes = review.reviewItems
      .filter((item) => item.required && item.status === 'open')
      .map((item) => item.type)
      .sort();
    expect(requiredTypes).toEqual([
      'external_card_payment_unattributed',
      'income_mismatch',
    ]);

    // Netflix shows up as a recurring outflow stream, and the planning
    // fields written by recurrence (migration 015) round-trip through the
    // facts read: fixed at the last amount, landing on the 15th.
    const netflix = review.recurringStreams.find(
      (stream) => stream.displayName.toLowerCase() === 'netflix',
    );
    expect(netflix).toBeDefined();
    expect(netflix).toMatchObject({
      amountClass: 'fixed',
      planningAmount: 15.49,
      anchorDayOfMonth: 15,
      amountRange: { low: 15.49, high: 15.49 },
    });
    expect(netflix!.dateJitterDays).toBeGreaterThanOrEqual(2);

    // --- Confirmation blocked until required items resolve --------------
    await expect(
      confirmFinancialReview(userId, review.snapshotVersion),
    ).rejects.toMatchObject({ code: 'REVIEW_ITEMS_UNRESOLVED' });

    const externalItem = review.reviewItems.find(
      (item) => item.type === 'external_card_payment_unattributed',
    )!;
    const incomeItem = review.reviewItems.find(
      (item) => item.type === 'income_mismatch',
    )!;

    const correctionDeps = {
      db: pool,
      enqueueRecompute: async () => null,
      transitionRun: (runId: string, to: 'recomputing') => transitionRun(runId, to),
      now: () => NOW,
    };

    await applyReviewItemAction(
      {
        userId,
        reviewItemId: externalItem.id,
        action: 'accept_coverage_limitation',
        snapshotVersion: review.snapshotVersion,
      },
      correctionDeps,
    );

    await applyReviewItemAction(
      {
        userId,
        reviewItemId: incomeItem.id,
        action: 'use_observed_value',
        snapshotVersion: review.snapshotVersion,
      },
      correctionDeps,
    );

    // Ownership: another user cannot touch this review.
    await expect(
      applyReviewItemAction(
        {
          userId: randomUUID(),
          reviewItemId: externalItem.id,
          action: 'accept_coverage_limitation',
          snapshotVersion: review.snapshotVersion,
        },
        correctionDeps,
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_ITEM_NOT_FOUND' });

    // --- Confirm: the only path to completion ---------------------------
    const confirmation = await confirmFinancialReview(userId, review.snapshotVersion);

    expect(confirmation.onboardingComplete).toBe(true);

    const status = await getOnboardingStatus(userId);

    expect(status.phase).toBe('complete');
    expect(status.onboardingComplete).toBe(true);
    expect(status.gates.financialReviewConfirmed).toBe(true);

    const finalRun = await getLatestRun(userId);
    expect(finalRun?.status).toBe('confirmed');

    // Confirmation is idempotent.
    const again = await confirmFinancialReview(userId, review.snapshotVersion);
    expect(again.alreadyConfirmed).toBe(true);
  }, 120_000);

  test('concurrent transitions cannot compose a forbidden move (CAS)', async () => {
    // The race the old FOR-UPDATE-on-a-pool code lost: a dead-letter
    // 'failed' running concurrently with a user confirm could overwrite
    // 'confirmed'. Under the CAS exactly one side wins and the loser
    // throws; the winner's status is never clobbered.
    const uid = randomUUID();

    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
      [uid, `e2e-cas-${uid}@test.local`],
    );

    try {
      for (let round = 0; round < 5; round += 1) {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO financial_analysis_runs (user_id, requested_lookback_days)
           VALUES ($1, 180)
           RETURNING id`,
          [uid],
        );
        const runId = rows[0]!.id;

        await transitionRun(runId, 'processing');
        await transitionRun(runId, 'review_ready');

        const results = await Promise.allSettled([
          transitionRun(runId, 'confirmed'),
          transitionRun(runId, 'failed', { errorCode: 'ANALYSIS_JOB_FAILED' }),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(1);

        const { rows: finalRows } = await pool.query<{ status: string }>(
          `SELECT status FROM financial_analysis_runs WHERE id = $1`,
          [runId],
        );

        // The stored status is exactly the winner's move — never a
        // second transition layered on top of it.
        const winnerIndex = results[0]!.status === 'fulfilled' ? 0 : 1;
        expect(finalRows[0]!.status).toBe(winnerIndex === 0 ? 'confirmed' : 'failed');

        // Free the single active-run slot for the next round.
        await pool.query(
          `UPDATE financial_analysis_runs SET status = 'superseded' WHERE id = $1`,
          [runId],
        );
      }
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [uid]);
    }
  }, 60_000);
});
