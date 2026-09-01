import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { Transaction } from 'plaid';

import {
  syncItemTransactions,
  type PlaidSyncClient,
  type SyncDeps,
} from '../src/services/plaid-sync.service.js';
import {
  getItemSyncOverviews,
  maybeStartUserAnalysis,
  type OrchestrationDeps,
} from '../src/services/analysis-orchestration.service.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

function txn(id: string, amount: number, date = '2026-08-01'): Transaction {
  return {
    transaction_id: id,
    account_id: 'acc-1',
    amount,
    iso_currency_code: 'USD',
    date,
    authorized_date: null,
    name: `txn ${id}`,
    merchant_name: null,
    pending: false,
    pending_transaction_id: null,
    payment_channel: 'other',
    personal_finance_category: null,
    transaction_code: null,
  } as unknown as Transaction;
}

type Page = {
  added: Transaction[];
  modified: Transaction[];
  removed: Array<{ transaction_id: string }>;
  accounts: Array<Record<string, unknown>>;
  next_cursor: string;
  has_more: boolean;
  transactions_update_status: string;
};

function page(overrides: Partial<Page>): Page {
  return {
    added: [],
    modified: [],
    removed: [],
    accounts: [
      {
        account_id: 'acc-1',
        name: 'Checking',
        official_name: null,
        mask: '0000',
        type: 'depository',
        subtype: 'checking',
        balances: { current: 100, available: 90, iso_currency_code: 'USD' },
      },
    ],
    next_cursor: '',
    has_more: false,
    transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
    ...overrides,
  };
}

/**
 * In-memory stand-in for the tables the sync engine touches, with
 * transactional snapshot/rollback so crash tests behave like Postgres.
 */
class FakeStore {
  state = {
    cursor: null as string | null,
    initialized_at: null as Date | null,
    update_status: 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
    sync_status: 'pending',
    last_error_code: null as string | null,
    last_error_message: null as string | null,
  };

  txns = new Map<string, { amount: number; date: string; removed: boolean }>();
  accounts = new Map<string, Record<string, unknown>>();
  insertCount = 0;

  private snapshot: string | null = null;

  private capture(): string {
    return JSON.stringify({
      state: { ...this.state, initialized_at: this.state.initialized_at?.toISOString() ?? null },
      txns: [...this.txns.entries()],
      accounts: [...this.accounts.entries()],
    });
  }

  private restore(saved: string): void {
    const parsed = JSON.parse(saved) as {
      state: Omit<FakeStore['state'], 'initialized_at'> & {
        initialized_at: string | null;
      };
      txns: Array<[string, { amount: number; date: string; removed: boolean }]>;
      accounts: Array<[string, Record<string, unknown>]>;
    };

    this.state = {
      ...parsed.state,
      initialized_at: parsed.state.initialized_at
        ? new Date(parsed.state.initialized_at)
        : null,
    };
    this.txns = new Map(parsed.txns);
    this.accounts = new Map(parsed.accounts);
  }

  async query<R>(text: string, values: unknown[] = []): Promise<{ rows: R[]; rowCount: number | null }> {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql === 'BEGIN') {
      this.snapshot = this.capture();
      return { rows: [], rowCount: null };
    }

    if (sql === 'COMMIT') {
      this.snapshot = null;
      return { rows: [], rowCount: null };
    }

    if (sql === 'ROLLBACK') {
      if (this.snapshot) {
        this.restore(this.snapshot);
        this.snapshot = null;
      }
      return { rows: [], rowCount: null };
    }

    if (sql.startsWith('INSERT INTO plaid_sync_state')) {
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT cursor, initialized_at FROM plaid_sync_state')) {
      return {
        rows: [
          {
            cursor: this.state.cursor,
            initialized_at: this.state.initialized_at,
          } as R,
        ],
        rowCount: 1,
      };
    }

    if (sql.startsWith('INSERT INTO plaid_accounts')) {
      this.accounts.set(values[1] as string, { name: values[2] });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO plaid_transactions')) {
      const id = values[3] as string;
      this.insertCount += 1;
      this.txns.set(id, {
        amount: values[7] as number,
        date: values[5] as string,
        removed: false,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE plaid_transactions SET is_removed = TRUE')) {
      const ids = values[1] as string[];
      let count = 0;
      for (const id of ids) {
        const existing = this.txns.get(id);
        if (existing && !existing.removed) {
          existing.removed = true;
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (sql.startsWith('UPDATE user_classification_overrides')) {
      // Override migration on pending→posted settle; nothing to move in
      // these fixtures.
      return { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('UPDATE plaid_sync_state SET cursor')) {
      this.state.cursor = values[1] as string;
      this.state.update_status = values[2] as string;
      this.state.sync_status = values[3] as string;
      this.state.initialized_at = this.state.initialized_at ?? new Date();
      this.state.last_error_code = null;
      this.state.last_error_message = null;
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE plaid_sync_state SET last_error_code')) {
      this.state.last_error_code = values[1] as string;
      this.state.last_error_message = values[2] as string;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`FakeStore has no route for: ${sql.slice(0, 80)}`);
  }
}

function makeDeps(store: FakeStore, plaid: PlaidSyncClient) {
  const terminalCalls: string[] = [];
  const resyncCalls: number[] = [];

  const db = {
    query: store.query.bind(store),
    connect: async () => ({
      query: store.query.bind(store),
      release: () => {},
    }),
  };

  const deps: SyncDeps = {
    plaid,
    db,
    getAccessToken: async () => ({
      userId: 'user-1',
      accessToken: 'access-token',
      status: 'active',
    }),
    scheduleResync: async (_payload, seconds) => {
      resyncCalls.push(seconds);
      return null;
    },
    onItemTerminal: async (userId) => {
      terminalCalls.push(userId);
    },
    now: () => new Date('2026-08-24T12:00:00Z'),
  };

  return { deps, terminalCalls, resyncCalls };
}

function plaidFromPages(pages: Record<string, Page>): PlaidSyncClient & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    async transactionsSync(request) {
      const key = request.cursor ?? '';
      calls.push(key);
      const data = pages[key];

      if (!data) {
        throw new Error(`no page for cursor "${key}"`);
      }

      return { data: data as never };
    },
  };
}

const payload = { plaidItemRowId: 'item-row-1', userId: 'user-1' };

describe('syncItemTransactions', () => {
  test('follows has_more pages and commits the final cursor with all changes', async () => {
    const store = new FakeStore();
    const plaid = plaidFromPages({
      '': page({
        added: [txn('t1', 10), txn('t2', 20)],
        next_cursor: 'c1',
        has_more: true,
        transactions_update_status: 'NOT_READY',
      }),
      c1: page({
        added: [txn('t3', 30)],
        next_cursor: 'c2',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      }),
    });

    const { deps, terminalCalls } = makeDeps(store, plaid);
    const outcome = await syncItemTransactions(payload, deps);

    expect(outcome.status).toBe('synced');
    expect(outcome.terminal).toBe(true);
    expect(store.state.cursor).toBe('c2');
    expect(store.state.sync_status).toBe('complete');
    expect([...store.txns.keys()].sort()).toEqual(['t1', 't2', 't3']);
    expect(terminalCalls).toEqual(['user-1']);
  });

  test('crash mid-session leaves the cursor untouched and replay converges without duplicates', async () => {
    const store = new FakeStore();

    let failNext = true;
    const flaky: PlaidSyncClient = {
      async transactionsSync(request) {
        const key = request.cursor ?? '';
        if (key === 'c1' && failNext) {
          failNext = false;
          throw new Error('network blip');
        }

        const pages: Record<string, Page> = {
          '': page({
            added: [txn('t1', 10)],
            next_cursor: 'c1',
            has_more: true,
            transactions_update_status: 'NOT_READY',
          }),
          c1: page({
            added: [txn('t2', 20)],
            next_cursor: 'c2',
            has_more: false,
          }),
        };

        return { data: pages[key] as never };
      },
    };

    const { deps } = makeDeps(store, flaky);

    await expect(syncItemTransactions(payload, deps)).rejects.toThrow('network blip');
    // Nothing committed: cursor still null, no transactions.
    expect(store.state.cursor).toBeNull();
    expect(store.txns.size).toBe(0);
    expect(store.state.last_error_code).toBe('SYNC_ERROR');

    // Retry (as pg-boss would) — full session re-fetches and applies once.
    const outcome = await syncItemTransactions(payload, deps);
    expect(outcome.terminal).toBe(true);
    expect(store.state.cursor).toBe('c2');
    expect([...store.txns.keys()].sort()).toEqual(['t1', 't2']);
    expect(store.state.last_error_code).toBeNull();
  });

  test('removed transactions are flagged, not deleted', async () => {
    const store = new FakeStore();
    store.txns.set('t9', { amount: 5, date: '2026-07-01', removed: false });
    const plaid = plaidFromPages({
      '': page({ removed: [{ transaction_id: 't9' }] }),
    });

    const { deps } = makeDeps(store, plaid);
    await syncItemTransactions(payload, deps);

    expect(store.txns.get('t9')?.removed).toBe(true);
  });

  test('non-historical status schedules a delayed re-sync instead of finishing', async () => {
    const store = new FakeStore();
    const plaid = plaidFromPages({
      '': page({
        added: [txn('t1', 10)],
        next_cursor: 'c1',
        transactions_update_status: 'INITIAL_UPDATE_COMPLETE',
      }),
    });

    const { deps, terminalCalls, resyncCalls } = makeDeps(store, plaid);
    const outcome = await syncItemTransactions(payload, deps);

    expect(outcome.terminal).toBe(false);
    expect(store.state.sync_status).toBe('syncing');
    expect(terminalCalls).toEqual([]);
    expect(resyncCalls).toHaveLength(1);
  });

  test('expired poll window completes with available history (limited)', async () => {
    const store = new FakeStore();
    // Initialized two hours ago; poll timeout defaults to 30 minutes.
    store.state.initialized_at = new Date('2026-08-24T10:00:00Z');
    const plaid = plaidFromPages({
      '': page({
        added: [txn('t1', 10)],
        next_cursor: 'c1',
        transactions_update_status: 'INITIAL_UPDATE_COMPLETE',
      }),
    });

    const { deps, terminalCalls } = makeDeps(store, plaid);
    const outcome = await syncItemTransactions(payload, deps);

    expect(outcome.terminal).toBe(true);
    expect(store.state.sync_status).toBe('complete');
    expect(terminalCalls).toEqual(['user-1']);
  });

  test('inactive items are skipped', async () => {
    const store = new FakeStore();
    const plaid = plaidFromPages({});
    const { deps } = makeDeps(store, plaid);

    const outcome = await syncItemTransactions(payload, {
      ...deps,
      getAccessToken: async () => ({
        userId: 'user-1',
        accessToken: 'x',
        status: 'disconnected',
      }),
    });

    expect(outcome.status).toBe('skipped');
  });

  test('mutation-during-pagination restarts the session from the stored cursor', async () => {
    const store = new FakeStore();
    let first = true;

    const plaid: PlaidSyncClient = {
      async transactionsSync(request) {
        const key = request.cursor ?? '';

        if (key === '' && first) {
          first = false;
          const err = new Error('mutation') as Error & {
            response: { data: { error_code: string } };
          };
          err.response = {
            data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' },
          };
          throw err;
        }

        return {
          data: page({ added: [txn('t1', 10)], next_cursor: 'c1' }) as never,
        };
      },
    };

    const { deps } = makeDeps(store, plaid);
    const outcome = await syncItemTransactions(payload, deps);

    expect(outcome.terminal).toBe(true);
    expect(store.txns.has('t1')).toBe(true);
  });
});

describe('maybeStartUserAnalysis', () => {
  type Row = Record<string, unknown>;

  function orchestrationDeps(options: {
    declared: boolean;
    items: Array<{ sync_status: string | null }>;
    runStatus?: string;
  }) {
    const transitions: Array<{ to: string; errorCode?: string | null }> = [];
    const enqueued: unknown[] = [];

    const db: Queryable = {
      async query<R>(text: string): Promise<{ rows: R[]; rowCount: number | null }> {
        if (text.includes('SELECT linking_declared_complete_at')) {
          return {
            rows: [
              {
                linking_declared_complete_at: options.declared ? new Date() : null,
              } as R,
            ],
            rowCount: 1,
          };
        }

        if (text.includes('FROM plaid_items i')) {
          return {
            rows: options.items.map(
              (item, index) =>
                ({
                  item_row_id: `item-${index}`,
                  institution_name: 'Bank',
                  sync_status: item.sync_status,
                  update_status: null,
                  oldest_transaction_date: '2026-03-01',
                  last_error_code: null,
                }) as R,
            ),
            rowCount: options.items.length,
          };
        }

        throw new Error(`unexpected query: ${text.slice(0, 60)}`);
      },
    };

    const runStatus = options.runStatus ?? 'waiting_for_history';
    const runSummary = {
      id: 'run-1',
      status: runStatus as never,
      requestedLookbackDays: 180,
      ruleVersion: 'v1',
      retryCount: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: '2026-08-24T00:00:00Z',
      reviewReadyAt: null,
      confirmedAt: null,
      failedAt: null,
    } as never;

    const deps: OrchestrationDeps = {
      db,
      enqueueAnalysis: async (p) => {
        enqueued.push(p);
        return null;
      },
      // Mirrors production: a confirmed/superseded run is the latest run but
      // never the active one.
      getLatestRun: async () => runSummary,
      getActiveRun: async () =>
        runStatus === 'confirmed' || runStatus === 'superseded' ? null : runSummary,
      ensureActiveRun: async () => {
        throw new Error('should not create runs in these tests');
      },
      transitionRun: async (_id, to, opts) => {
        transitions.push({ to, errorCode: opts?.errorCode });
      },
      now: () => new Date('2026-08-24T12:00:00Z'),
    };

    return { deps, transitions, enqueued };
  }

  test('starts analysis when declared complete and all items terminal with one usable', async () => {
    const { deps, transitions, enqueued } = orchestrationDeps({
      declared: true,
      items: [{ sync_status: 'complete' }, { sync_status: 'failed' }],
    });

    const result = await maybeStartUserAnalysis('user-1', deps);

    expect(result).toBe('started');
    expect(transitions).toEqual([{ to: 'processing', errorCode: undefined }]);
    expect(enqueued).toEqual([{ userId: 'user-1', analysisRunId: 'run-1' }]);
  });

  test('waits while any item is still syncing', async () => {
    const { deps, transitions } = orchestrationDeps({
      declared: true,
      items: [{ sync_status: 'complete' }, { sync_status: 'syncing' }],
    });

    expect(await maybeStartUserAnalysis('user-1', deps)).toBe('waiting');
    expect(transitions).toEqual([]);
  });

  test('fails the run when every item failed', async () => {
    const { deps, transitions } = orchestrationDeps({
      declared: true,
      items: [{ sync_status: 'failed' }],
    });

    expect(await maybeStartUserAnalysis('user-1', deps)).toBe('failed');
    expect(transitions).toEqual([{ to: 'failed', errorCode: 'NO_USABLE_ITEM' }]);
  });

  test('does nothing before the user declares linking complete', async () => {
    const { deps } = orchestrationDeps({
      declared: false,
      items: [{ sync_status: 'complete' }],
    });

    expect(await maybeStartUserAnalysis('user-1', deps)).toBe('skipped');
  });

  test('does not restart an already-processing run', async () => {
    const { deps, transitions } = orchestrationDeps({
      declared: true,
      items: [{ sync_status: 'complete' }],
      runStatus: 'processing',
    });

    expect(await maybeStartUserAnalysis('user-1', deps)).toBe('skipped');
    expect(transitions).toEqual([]);
  });

  test('a failed enqueue never strands the run in processing', async () => {
    // Regression: transition-then-enqueue could crash between the two and
    // leave a 'processing' run with nothing queued — an unrecoverable
    // spinner. Enqueue goes first; on failure the status is untouched.
    const { deps, transitions } = orchestrationDeps({
      declared: true,
      items: [{ sync_status: 'complete' }],
    });

    deps.enqueueAnalysis = async () => {
      throw new Error('queue down');
    };

    await expect(maybeStartUserAnalysis('user-1', deps)).rejects.toThrow('queue down');
    expect(transitions).toEqual([]);
  });

  test('never spawns a new run for a user whose latest run is confirmed', async () => {
    // Post-completion webhook syncs land here; the ensureActiveRun stub
    // throws, so reaching 'skipped' proves no run was created.
    const { deps, transitions, enqueued } = orchestrationDeps({
      declared: true,
      items: [{ sync_status: 'complete' }],
      runStatus: 'confirmed',
    });

    expect(await maybeStartUserAnalysis('user-1', deps)).toBe('skipped');
    expect(transitions).toEqual([]);
    expect(enqueued).toEqual([]);
  });
});

describe('getItemSyncOverviews', () => {
  test('derives terminal/usable and history days', async () => {
    const db: Queryable = {
      async query<R>(): Promise<{ rows: R[]; rowCount: number | null }> {
        return {
          rows: [
            {
              item_row_id: 'a',
              institution_name: 'Chase',
              sync_status: 'complete',
              update_status: 'HISTORICAL_UPDATE_COMPLETE',
              oldest_transaction_date: '2026-05-24',
              last_error_code: null,
            } as R,
            {
              item_row_id: 'b',
              institution_name: 'Amex',
              sync_status: null,
              update_status: null,
              oldest_transaction_date: null,
              last_error_code: null,
            } as R,
          ],
          rowCount: 2,
        };
      },
    };

    const overviews = await getItemSyncOverviews('user-1', db, new Date('2026-08-24T00:00:00Z'));

    expect(overviews[0]).toMatchObject({
      itemRowId: 'a',
      terminal: true,
      usable: true,
      historyDaysAvailable: 92,
    });
    expect(overviews[1]).toMatchObject({
      itemRowId: 'b',
      syncStatus: 'pending',
      terminal: false,
      usable: false,
      historyDaysAvailable: null,
    });
  });
});
