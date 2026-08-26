import { describe, expect, jest, test } from '@jest/globals';

import {
  applyOverride,
  classifyTransaction,
  classifyUserTransactions,
  type ClassifyDeps,
} from '../src/services/classification.service.js';
import type {
  ClassifiableTransaction,
  ClassificationOverride,
} from '../src/types/classification.js';
import type { Queryable } from '../src/lib/db-types.js';

jest.spyOn(console, 'log').mockImplementation(() => {});

function txn(overrides: Partial<ClassifiableTransaction> = {}): ClassifiableTransaction {
  return {
    rowId: 'row-1',
    amount: 25,
    accountType: 'depository',
    accountSubtype: 'checking',
    pfcPrimary: null,
    pfcDetailed: null,
    pfcConfidence: null,
    merchantNormalized: null,
    name: null,
    transactionCode: null,
    ...overrides,
  };
}

describe('classifyTransaction — purchases and fees', () => {
  test('a categorized card purchase is economic spend', () => {
    const result = classifyTransaction(
      txn({
        accountType: 'credit',
        amount: 54.2,
        pfcPrimary: 'FOOD_AND_DRINK',
        pfcDetailed: 'FOOD_AND_DRINK_RESTAURANT',
        pfcConfidence: 'VERY_HIGH',
      }),
    );

    expect(result.role).toBe('expense');
    expect(result.displayBucket).toBe('Food & Drink');
    expect(result.confidence).toBe('high');
  });

  test('a categorized checking purchase is economic spend', () => {
    const result = classifyTransaction(
      txn({ amount: 120, pfcPrimary: 'GENERAL_MERCHANDISE', pfcConfidence: 'HIGH' }),
    );

    expect(result.role).toBe('expense');
    expect(result.displayBucket).toBe('Shopping');
  });

  test('card purchase without category is still spend, uncategorized', () => {
    const result = classifyTransaction(txn({ accountType: 'credit', amount: 33 }));

    expect(result.role).toBe('expense');
    expect(result.displayBucket).toBe('Uncategorized');
  });

  test('interest on a card is an economic expense, not movement', () => {
    const result = classifyTransaction(
      txn({
        accountType: 'credit',
        amount: 12.4,
        name: 'INTEREST CHARGE ON PURCHASES',
      }),
    );

    expect(result.role).toBe('interest_or_fee');
    expect(result.displayBucket).toBe('Fees & Interest');
  });

  test('bank fees on checking are interest_or_fee', () => {
    const result = classifyTransaction(
      txn({ amount: 35, pfcPrimary: 'BANK_FEES', pfcConfidence: 'HIGH' }),
    );

    expect(result.role).toBe('interest_or_fee');
  });
});

describe('classifyTransaction — income and false-income prevention', () => {
  test('payroll deposit via PFC is earned income', () => {
    const result = classifyTransaction(
      txn({
        amount: -2600,
        pfcPrimary: 'INCOME',
        pfcDetailed: 'INCOME_WAGES',
        pfcConfidence: 'VERY_HIGH',
      }),
    );

    expect(result.role).toBe('earned_income');
    expect(result.confidence).toBe('high');
  });

  test('payroll deposit via description is earned income', () => {
    const result = classifyTransaction(
      txn({ amount: -1950, name: 'ACME CORP DES: PAYROLL' }),
    );

    expect(result.role).toBe('earned_income');
  });

  test('NEVER income: a refund on a credit card', () => {
    const result = classifyTransaction(
      txn({
        accountType: 'credit',
        amount: -45,
        merchantNormalized: 'target',
        pfcPrimary: 'GENERAL_MERCHANDISE',
      }),
    );

    expect(result.role).toBe('refund_or_credit');
    expect(result.role).not.toBe('earned_income');
  });

  test('NEVER income: an incoming card payment on the card side', () => {
    const result = classifyTransaction(
      txn({
        accountType: 'credit',
        amount: -820,
        name: 'ONLINE PAYMENT THANK YOU',
      }),
    );

    expect(result.role).toBe('credit_card_payment');
  });

  test('NEVER income: even INCOME-tagged inflow on a credit account', () => {
    const result = classifyTransaction(
      txn({
        accountType: 'credit',
        amount: -100,
        pfcPrimary: 'INCOME',
        pfcDetailed: 'INCOME_WAGES',
        pfcConfidence: 'VERY_HIGH',
      }),
    );

    expect(result.role).not.toBe('earned_income');
  });

  test('NEVER income: incoming transfers stay account movement', () => {
    const result = classifyTransaction(
      txn({
        amount: -500,
        pfcPrimary: 'TRANSFER_IN',
        pfcDetailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
        pfcConfidence: 'HIGH',
      }),
    );

    expect(result.role).toBe('internal_transfer');
  });

  test('NEVER income: tax refunds are refunds', () => {
    const result = classifyTransaction(
      txn({
        amount: -1200,
        pfcPrimary: 'INCOME',
        pfcDetailed: 'INCOME_TAX_REFUND',
        pfcConfidence: 'HIGH',
      }),
    );

    expect(result.role).toBe('refund_or_credit');
  });

  test('a returned purchase on checking is a refund, not income', () => {
    const result = classifyTransaction(
      txn({ amount: -60, pfcPrimary: 'GENERAL_MERCHANDISE', pfcConfidence: 'MEDIUM' }),
    );

    expect(result.role).toBe('refund_or_credit');
  });
});

describe('classifyTransaction — payments and transfers', () => {
  test('checking-side card payment via PFC is account movement', () => {
    const result = classifyTransaction(
      txn({
        amount: 820,
        pfcPrimary: 'LOAN_PAYMENTS',
        pfcDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        pfcConfidence: 'HIGH',
      }),
    );

    expect(result.role).toBe('credit_card_payment');
    expect(result.displayBucket).toBeNull();
  });

  test('checking-side card payment via description', () => {
    const result = classifyTransaction(
      txn({ amount: 500, name: 'AUTOPAY CARD PAYMENT' }),
    );

    expect(result.role).toBe('credit_card_payment');
  });

  test('mortgage payment is debt principal, not spend', () => {
    const result = classifyTransaction(
      txn({
        amount: 1900,
        pfcPrimary: 'LOAN_PAYMENTS',
        pfcDetailed: 'LOAN_PAYMENTS_MORTGAGE_PAYMENT',
        pfcConfidence: 'VERY_HIGH',
      }),
    );

    expect(result.role).toBe('debt_principal_payment');
  });

  test('transfer to savings is savings movement', () => {
    const result = classifyTransaction(
      txn({
        amount: 400,
        pfcPrimary: 'TRANSFER_OUT',
        pfcDetailed: 'TRANSFER_OUT_SAVINGS',
        pfcConfidence: 'HIGH',
      }),
    );

    expect(result.role).toBe('savings_or_investment_transfer');
  });

  test('generic outgoing transfer is internal movement', () => {
    const result = classifyTransaction(
      txn({
        amount: 250,
        pfcPrimary: 'TRANSFER_OUT',
        pfcDetailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
        pfcConfidence: 'MEDIUM',
      }),
    );

    expect(result.role).toBe('internal_transfer');
    expect(result.confidence).toBe('medium');
  });
});

describe('classifyTransaction — explicit unknowns', () => {
  test('unresolvable outflow stays unknown_outflow', () => {
    const result = classifyTransaction(txn({ amount: 77, name: 'CHECK 1042' }));

    expect(result.role).toBe('unknown_outflow');
    expect(result.source).toBe('fallback');
    expect(result.confidence).toBe('low');
  });

  test('unresolvable inflow stays unknown_inflow, never income', () => {
    const result = classifyTransaction(txn({ amount: -300, name: 'DEPOSIT' }));

    expect(result.role).toBe('unknown_inflow');
  });
});

describe('applyOverride', () => {
  const overrides: ClassificationOverride[] = [
    {
      scope: 'transaction',
      transactionRowId: 'row-1',
      merchantNormalized: null,
      role: 'expense',
      displayBucket: 'Food & Drink',
    },
    {
      scope: 'merchant',
      transactionRowId: null,
      merchantNormalized: 'netflix',
      role: 'expense',
      displayBucket: 'Entertainment',
    },
  ];

  test('transaction-scope override wins for its transaction', () => {
    const result = applyOverride(txn({ rowId: 'row-1' }), overrides);

    expect(result?.role).toBe('expense');
    expect(result?.source).toBe('user_override');
    expect(result?.ruleId).toBe('override-transaction');
  });

  test('merchant-scope override applies to matching merchants', () => {
    const result = applyOverride(
      txn({ rowId: 'row-9', merchantNormalized: 'netflix' }),
      overrides,
    );

    expect(result?.ruleId).toBe('override-merchant');
    expect(result?.displayBucket).toBe('Entertainment');
  });

  test('transaction scope outranks merchant scope', () => {
    const result = applyOverride(
      txn({ rowId: 'row-1', merchantNormalized: 'netflix' }),
      overrides,
    );

    expect(result?.ruleId).toBe('override-transaction');
  });

  test('no matching override returns null', () => {
    expect(applyOverride(txn({ rowId: 'row-5' }), overrides)).toBeNull();
  });
});

describe('classifyUserTransactions job', () => {
  test('classifies every transaction, applies overrides, chains next stage', async () => {
    const upserts: Array<{ rowId: string; role: string; source: string }> = [];
    const chained: unknown[] = [];

    const db: Queryable = {
      async query<R>(text: string, values: unknown[] = []) {
        if (text.includes('FROM user_classification_overrides')) {
          return {
            rows: [
              {
                scope: 'transaction',
                transaction_row_id: 'row-2',
                merchant_normalized: null,
                economic_role: 'internal_transfer',
                display_bucket: null,
              } as R,
            ],
            rowCount: 1,
          };
        }

        if (text.includes('INSERT INTO transaction_classifications')) {
          upserts.push({
            rowId: values[0] as string,
            role: values[2] as string,
            source: values[4] as string,
          });
          return { rows: [] as R[], rowCount: 1 };
        }

        throw new Error(`unexpected query: ${text.slice(0, 50)}`);
      },
    };

    const deps: ClassifyDeps = {
      db,
      listTransactions: async () => [
        txn({ rowId: 'row-1', amount: 30, pfcPrimary: 'FOOD_AND_DRINK', pfcConfidence: 'HIGH' }),
        txn({ rowId: 'row-2', amount: 200, name: 'MYSTERY OUTFLOW' }),
      ],
      enqueueNextStage: async (payload) => {
        chained.push(payload);
        return null;
      },
    };

    const result = await classifyUserTransactions(
      { userId: 'user-1', analysisRunId: 'run-1' },
      deps,
    );

    expect(result.classified).toBe(2);
    expect(upserts).toEqual([
      { rowId: 'row-1', role: 'expense', source: 'pfc' },
      { rowId: 'row-2', role: 'internal_transfer', source: 'user_override' },
    ]);
    expect(chained).toEqual([{ userId: 'user-1', analysisRunId: 'run-1' }]);
  });
});
