import { describe, expect, jest, test } from '@jest/globals';

import {
  proposeLinks,
  reconcileUserTransfers,
  roleForLinkType,
  type LinkableTransaction,
  type ReconcileDeps,
} from '../src/services/reconciliation.service.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

let rowCounter = 0;

function linkable(overrides: Partial<LinkableTransaction>): LinkableTransaction {
  rowCounter += 1;
  return {
    rowId: `row-${rowCounter}`,
    accountId: 'checking-1',
    accountType: 'depository',
    accountSubtype: 'checking',
    amount: 100,
    date: '2026-08-01',
    isoCurrencyCode: 'USD',
    role: 'internal_transfer',
    classificationSource: 'pfc',
    pending: false,
    ...overrides,
  };
}

describe('proposeLinks', () => {
  test('checking-to-card payment links one-to-one as credit_card_payment', () => {
    const outflow = linkable({
      rowId: 'out-1',
      amount: 820,
      role: 'credit_card_payment',
      date: '2026-08-01',
    });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'card-1',
      accountType: 'credit',
      accountSubtype: 'credit card',
      amount: -820,
      role: 'credit_card_payment',
      date: '2026-08-03',
    });

    const links = proposeLinks([outflow, inflow]);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      outflowRowId: 'out-1',
      inflowRowId: 'in-1',
      linkType: 'credit_card_payment',
    });
    expect(roleForLinkType(links[0]!.linkType)).toBe('credit_card_payment');
  });

  test('checking-to-savings links as savings_transfer', () => {
    const outflow = linkable({
      rowId: 'out-1',
      amount: 400,
      role: 'savings_or_investment_transfer',
    });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'savings-1',
      accountSubtype: 'savings',
      amount: -400,
      role: 'internal_transfer',
    });

    const links = proposeLinks([outflow, inflow]);

    expect(links[0]?.linkType).toBe('savings_transfer');
    expect(roleForLinkType('savings_transfer')).toBe('savings_or_investment_transfer');
  });

  test('a card refund is not a payment candidate and stays unlinked', () => {
    const outflow = linkable({
      rowId: 'out-1',
      amount: 45,
      role: 'credit_card_payment',
    });
    // Refund on the card: same absolute amount, but refund_or_credit is not
    // an admissible inflow role.
    const refund = linkable({
      rowId: 'in-1',
      accountId: 'card-1',
      accountType: 'credit',
      amount: -45,
      role: 'refund_or_credit',
    });

    expect(proposeLinks([outflow, refund])).toHaveLength(0);
  });

  test('near-date false match: the closer posting wins, the other stays unlinked', () => {
    const outflow = linkable({
      rowId: 'out-1',
      amount: 500,
      role: 'credit_card_payment',
      date: '2026-08-10',
    });
    const close = linkable({
      rowId: 'in-close',
      accountId: 'card-1',
      accountType: 'credit',
      amount: -500,
      role: 'credit_card_payment',
      date: '2026-08-11',
    });
    const far = linkable({
      rowId: 'in-far',
      accountId: 'card-2',
      accountType: 'credit',
      amount: -500,
      role: 'credit_card_payment',
      date: '2026-08-15',
    });

    const links = proposeLinks([outflow, close, far]);

    expect(links).toHaveLength(1);
    expect(links[0]?.inflowRowId).toBe('in-close');
  });

  test('different amounts never match (carried balance stays honest)', () => {
    // User pays $400 against a $1000 statement: the purchases are spend,
    // the $400 payment pair links, and nothing invents a $600 phantom.
    const purchase = linkable({
      rowId: 'purchase',
      accountId: 'card-1',
      accountType: 'credit',
      amount: 1000,
      role: 'expense',
    });
    const paymentOut = linkable({
      rowId: 'out-1',
      amount: 400,
      role: 'credit_card_payment',
    });
    const paymentIn = linkable({
      rowId: 'in-1',
      accountId: 'card-1',
      accountType: 'credit',
      amount: -400,
      role: 'credit_card_payment',
    });

    const links = proposeLinks([purchase, paymentOut, paymentIn]);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ outflowRowId: 'out-1', inflowRowId: 'in-1' });
  });

  test('same-account pairs are excluded', () => {
    const outflow = linkable({ rowId: 'out-1', amount: 100 });
    const inflow = linkable({ rowId: 'in-1', amount: -100 });

    expect(proposeLinks([outflow, inflow])).toHaveLength(0);
  });

  test('currency mismatch is excluded', () => {
    const outflow = linkable({ rowId: 'out-1', amount: 100 });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'other-1',
      amount: -100,
      isoCurrencyCode: 'EUR',
    });

    expect(proposeLinks([outflow, inflow])).toHaveLength(0);
  });

  test('postings outside the date window are excluded', () => {
    const outflow = linkable({ rowId: 'out-1', amount: 100, date: '2026-08-01' });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'other-1',
      amount: -100,
      date: '2026-08-20',
    });

    expect(proposeLinks([outflow, inflow])).toHaveLength(0);
  });

  test('pending postings never participate', () => {
    const outflow = linkable({ rowId: 'out-1', amount: 100, pending: true });
    const inflow = linkable({ rowId: 'in-1', accountId: 'other-1', amount: -100 });

    expect(proposeLinks([outflow, inflow])).toHaveLength(0);
  });

  test('two unknown postings with exact amount and near dates still pair', () => {
    const outflow = linkable({
      rowId: 'out-1',
      amount: 250,
      role: 'unknown_outflow',
      date: '2026-08-01',
    });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'other-1',
      amount: -250,
      role: 'unknown_inflow',
      date: '2026-08-01',
    });

    const links = proposeLinks([outflow, inflow]);

    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe('internal_transfer');
  });

  test('economic expenses are never link candidates', () => {
    const expense = linkable({ rowId: 'out-1', amount: 100, role: 'expense' });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'other-1',
      amount: -100,
      role: 'internal_transfer',
    });

    expect(proposeLinks([expense, inflow])).toHaveLength(0);
  });
});

describe('reconcileUserTransfers job', () => {
  function jobDeps(transactions: LinkableTransaction[]) {
    const deletes: number[] = [];
    const inserts: unknown[][] = [];
    const updates: unknown[][] = [];
    const chained: unknown[] = [];

    const db: Queryable = {
      async query<R>(text: string, values: unknown[] = []) {
        if (text.startsWith('DELETE FROM transaction_links')) {
          deletes.push(1);
          return { rows: [] as R[], rowCount: 0 };
        }

        if (text.includes('INSERT INTO transaction_links')) {
          inserts.push(values);
          return { rows: [] as R[], rowCount: 1 };
        }

        if (text.includes('UPDATE transaction_classifications')) {
          expect(text).toContain("source <> 'user_override'");
          updates.push(values);
          return { rows: [] as R[], rowCount: 2 };
        }

        throw new Error(`unexpected query: ${text.slice(0, 50)}`);
      },
    };

    const deps: ReconcileDeps = {
      db,
      listLinkable: async () => transactions,
      enqueueNextStage: async (payload) => {
        chained.push(payload);
        return null;
      },
    };

    return { deps, deletes, inserts, updates, chained };
  }

  test('persists links, refines classifications, chains recurrence', async () => {
    const outflow = linkable({ rowId: 'out-1', amount: 820, role: 'credit_card_payment' });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'card-1',
      accountType: 'credit',
      amount: -820,
      role: 'credit_card_payment',
    });

    const { deps, deletes, inserts, updates, chained } = jobDeps([outflow, inflow]);
    const result = await reconcileUserTransfers(
      { userId: 'user-1', analysisRunId: 'run-1' },
      deps,
    );

    expect(result.links).toBe(1);
    expect(deletes).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![3]).toBe('credit_card_payment');
    expect(updates[0]![0]).toEqual(['out-1', 'in-1']);
    expect(chained).toEqual([{ userId: 'user-1', analysisRunId: 'run-1' }]);
  });

  test('replay converges: rebuild produces the same links', async () => {
    const outflow = linkable({ rowId: 'out-1', amount: 400, role: 'internal_transfer' });
    const inflow = linkable({
      rowId: 'in-1',
      accountId: 'other-1',
      amount: -400,
      role: 'internal_transfer',
    });

    const first = jobDeps([outflow, inflow]);
    await reconcileUserTransfers({ userId: 'user-1', analysisRunId: 'run-1' }, first.deps);

    const second = jobDeps([outflow, inflow]);
    await reconcileUserTransfers({ userId: 'user-1', analysisRunId: 'run-1' }, second.deps);

    expect(second.deletes).toHaveLength(1);
    expect(second.inserts).toEqual(first.inserts);
  });
});
