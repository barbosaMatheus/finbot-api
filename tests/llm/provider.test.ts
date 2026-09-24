import { describe, expect, jest, test } from '@jest/globals';

import { applyAdjustment, vocabularyFor } from '../../src/gameplan/adjustment.js';
import { buildShortlist } from '../../src/gameplan/candidates.js';
import { gradePeriod } from '../../src/gameplan/grading.js';
import type { Adjustment } from '../../src/gameplan/types.js';
import { allowedNumbers, checkContainment } from '../../src/llm/containment.js';
import { FakeLlmClient } from '../../src/llm/fake-client.js';
import { diffPayload, gradePayload, planPayload } from '../../src/llm/prompts.js';
import { createLlmProvider, llmProviderFromEnv } from '../../src/llm/provider.js';
import { templatePlan } from '../../src/llm/templates.js';
import { LlmClientError } from '../../src/llm/types.js';
import { samInput } from '../gameplan/fixtures.js';

jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'log').mockImplementation(() => {});

const CATEGORIES = ['Groceries', 'Fuel', 'Transportation', 'Eating Out', 'Shopping', 'Housing & Utilities', 'Entertainment'];

const shortlist = buildShortlist(samInput());
const ids = [...shortlist.plan, ...shortlist.alternates].map((candidate) => candidate.id);

/** A model answer that uses only the numbers in the plan. */
function goodPlanAnswer(overrides: Record<string, string> = {}): string {
  const why: Record<string, string> = {
    savings_transfer: 'Move $112 to savings after payday — a quarter of the $448 left once bills and essentials are covered.',
    'spend_cap:Eating Out': 'Keep eating out under $136 this period; it has run about $170.',
    bill_readiness: 'Have about $1,472 set aside by Sep 29 for rent, electric, internet and the insurance share.',
  };
  for (const id of ids) if (!(id in why)) why[id] = 'A smaller change you could swap in this period.';
  return JSON.stringify({ items: ids.map((id) => ({ id, why: overrides[id] ?? why[id] })) });
}

describe('explain(plan)', () => {
  test('the model writes the why lines when every number it uses was given', async () => {
    const client = new FakeLlmClient([goodPlanAnswer()]);
    const narration = await createLlmProvider(client).explain({ kind: 'plan', shortlist });

    expect(narration.source).toBe('model');
    expect(narration.fallbackReason).toBeNull();
    expect(Object.keys(narration.output.why).sort()).toEqual([...ids].sort());
    expect(narration.output.why['savings_transfer']).toContain('$112');
    // The model saw the structured plan and the voice rules, nothing else.
    expect(client.requests[0]!.system).toContain('never invents a number');
    expect(JSON.parse(client.requests[0]!.user)).toMatchObject({ freeCash: { freeCash: 448 } });
  });

  test('an invented number drops the whole narration to the template', async () => {
    const client = new FakeLlmClient([
      goodPlanAnswer({ savings_transfer: 'Move $112 now and you will have $500 by December.' }),
    ]);
    const narration = await createLlmProvider(client).explain({ kind: 'plan', shortlist });

    expect(narration.source).toBe('template');
    expect(narration.fallbackReason).toBe('number_invented');
    expect(narration.output).toEqual(templatePlan(shortlist));
  });

  test('malformed output — not JSON, or a target left out — is dropped', async () => {
    const notJson = await createLlmProvider(new FakeLlmClient(['Sure! Here is the plan.'])).explain({ kind: 'plan', shortlist });
    expect(notJson).toMatchObject({ source: 'template', fallbackReason: 'malformed' });

    const missing = JSON.stringify({ items: [{ id: 'savings_transfer', why: 'Move $112 to savings.' }] });
    const partial = await createLlmProvider(new FakeLlmClient([missing])).explain({ kind: 'plan', shortlist });
    expect(partial).toMatchObject({ source: 'template', fallbackReason: 'malformed' });

    const wrongShape = await createLlmProvider(new FakeLlmClient([JSON.stringify({ why: 'x' })])).explain({ kind: 'plan', shortlist });
    expect(wrongShape.fallbackReason).toBe('malformed');
  });

  test('a client failure falls back and never throws', async () => {
    const client = new FakeLlmClient([new LlmClientError('boom', 'transport')]);
    const narration = await createLlmProvider(client).explain({ kind: 'plan', shortlist });
    expect(narration).toMatchObject({ source: 'template', fallbackReason: 'client_error', model: null });
  });

  test('JSON wrapped in prose or a code fence is still read', async () => {
    const client = new FakeLlmClient(['```json\n' + goodPlanAnswer() + '\n```']);
    const narration = await createLlmProvider(client).explain({ kind: 'plan', shortlist });
    expect(narration.source).toBe('model');
  });

  test("the template speaks when no provider is configured, and Sam's lines read as designed", async () => {
    const narration = await createLlmProvider(null).explain({ kind: 'plan', shortlist });

    expect(narration).toMatchObject({ source: 'template', fallbackReason: 'no_provider' });
    expect(narration.output.why['savings_transfer']).toBe(
      'Move $112 to savings after payday — 25% of the $448 left after bills and essentials.',
    );
    expect(narration.output.why['spend_cap:Eating Out']).toBe(
      'Keep Eating Out under $136 this period — it has run about $170.',
    );
    expect(narration.output.why['bill_readiness']).toBe(
      'Have about $1,472 set aside by Sep 29 — Oak Street Lofts ($1,200), City Power (has run $90–$140), Comcast ($77) and GEICO ($55 of $712 set aside, lands around Mar 14).',
    );
  });

  test('every template line passes the same containment check the model must pass', async () => {
    const narration = await createLlmProvider(null).explain({ kind: 'plan', shortlist });
    const allowed = allowedNumbers(planPayload(shortlist));
    for (const line of Object.values(narration.output.why)) {
      expect(checkContainment(line, allowed)).toEqual({ ok: true, invented: [] });
    }
  });
});

describe('explain(grade)', () => {
  const grade = gradePeriod(
    shortlist.plan.map((candidate) => candidate.definition),
    {
      spendByBucket: { 'Eating Out': 148 },
      countByBucket: {},
      postedBills: [
        { key: 'outflow:oak street lofts', amount: 1200, date: '2026-10-01', feeOrOverdraft: false },
        { key: 'outflow:city power', amount: 210, date: '2026-10-07', feeOrOverdraft: false },
        { key: 'outflow:comcast', amount: 77, date: '2026-10-05', feeOrOverdraft: false },
      ],
      largestSavingsTransfer: 50,
      largestDebtPayment: 0,
      balanceAtClose: 400,
      awarenessCompleted: false,
    },
  );

  test('one line per result in the grade’s order, plus improvements', async () => {
    const answer = JSON.stringify({
      lines: [
        { index: 0, text: 'The bills all landed without a fee, and $400 covers the $55 still set aside.' },
        { index: 1, text: 'The transfer came in at $50 of $112 — electric ran $70 over, so that is on the estimate.' },
        { index: 2, text: 'Eating out reached $148 against $136, over by $12.' },
      ],
      improvements: 'Eating out and the transfer are the two to watch; both were close, not missed.',
    });
    const narration = await createLlmProvider(new FakeLlmClient([answer])).explain({ kind: 'grade', grade, period: shortlist.period });

    expect(narration.source).toBe('model');
    expect(narration.output.lines).toHaveLength(3);
    expect(narration.output.improvements).toContain('close');
  });

  test('a missing index, or an invented number, falls back to the template', async () => {
    const partial = JSON.stringify({ lines: [{ index: 0, text: 'fine' }], improvements: null });
    expect((await createLlmProvider(new FakeLlmClient([partial])).explain({ kind: 'grade', grade, period: shortlist.period })).fallbackReason).toBe('malformed');

    const invented = JSON.stringify({
      lines: [0, 1, 2].map((index) => ({ index, text: 'Fine.' })),
      improvements: 'Aim for $300 next time.',
    });
    expect((await createLlmProvider(new FakeLlmClient([invented])).explain({ kind: 'grade', grade, period: shortlist.period })).fallbackReason).toBe('number_invented');
  });

  test('the template grade names the deciding numbers and passes containment', async () => {
    const narration = await createLlmProvider(null).explain({ kind: 'grade', grade, period: shortlist.period });
    const allowed = allowedNumbers(gradePayload(grade, shortlist.period));

    expect(narration.output.lines[0]).toContain('met');
    expect(narration.output.lines[1]).toContain('came in $70 over');
    expect(narration.output.improvements).toContain('Where to improve');
    for (const line of [...narration.output.lines, narration.output.improvements ?? '']) {
      expect(checkContainment(line, allowed).ok).toBe(true);
    }
  });
});

describe('explain(diff)', () => {
  const adjustment: Adjustment = {
    kind: 'spend_event',
    amount: null,
    affectedCategory: 'Eating Out',
    affectedStream: null,
    timing: null,
    text: "my sister's in town next weekend",
  };
  const result = applyAdjustment(samInput(), adjustment);

  test('the model reply may mention what stayed, since unchanged entries are in its input', async () => {
    const reply = JSON.stringify({
      reply: "Got it — lifted the eating-out cap to $170 for your sister's visit. The $112 transfer and the bills don't change.",
    });
    const narration = await createLlmProvider(new FakeLlmClient([reply])).explain({ kind: 'diff', result, adjustment });
    expect(narration.source).toBe('model');
    expect(narration.output.reply).toContain('$170');
  });

  test('the template reply names the change and passes containment', async () => {
    const narration = await createLlmProvider(null).explain({ kind: 'diff', result, adjustment });
    expect(narration.output.reply).toBe(
      'Got it for "my sister\'s in town next weekend": Eating Out can run to $170 instead of $136. Everything else stays as it was.',
    );
    expect(checkContainment(narration.output.reply, allowedNumbers(diffPayload(result, adjustment))).ok).toBe(true);
  });

  test('a skipped amount box reads as nothing moved', async () => {
    const skipped = applyAdjustment(samInput(), { ...adjustment, kind: 'cost', affectedCategory: null, text: 'car trouble' });
    const narration = await createLlmProvider(null).explain({ kind: 'diff', result: skipped, adjustment: { ...adjustment, kind: 'cost', text: 'car trouble' } });
    expect(narration.output.reply).toContain('nothing in the plan moved');
  });
});

describe('parseAdjustment (§5, §5a, decision 13)', () => {
  const vocabulary = vocabularyFor(shortlist, CATEGORIES);

  test('a valid record comes back validated, with the stated amount as the box proposal', async () => {
    const client = new FakeLlmClient([
      JSON.stringify({ kind: 'cost', amount: 400, affectedCategory: null, affectedStream: null, timing: null, text: 'Car repair, about $400' }),
    ]);
    const parsed = await createLlmProvider(client).parseAdjustment('Car repair, about $400', vocabulary);

    expect(parsed.source).toBe('model');
    expect(parsed.adjustment).toMatchObject({ kind: 'cost', amount: 400, text: 'Car repair, about $400' });
    expect(parsed.amountDropped).toBe(false);
    // The closed lists travelled with the request.
    const request = JSON.parse(client.requests[0]!.user);
    expect(request.categories).toContain('Eating Out');
    expect(request.bills.map((bill: { key: string }) => bill.key)).toContain('outflow:oak street lofts');
  });

  test('an amount the text never stated is dropped; the box opens empty', async () => {
    const client = new FakeLlmClient([
      JSON.stringify({ kind: 'cost', amount: 400, affectedCategory: null, affectedStream: null, timing: null, text: 'car trouble this week' }),
    ]);
    const parsed = await createLlmProvider(client).parseAdjustment('car trouble this week', vocabulary);

    expect(parsed.adjustment).toMatchObject({ kind: 'cost', amount: null });
    expect(parsed.amountDropped).toBe(true);
    expect(parsed.fallbackReason).toBe('number_invented');
  });

  test('an amount written in words counts as stated', async () => {
    const client = new FakeLlmClient([
      JSON.stringify({ kind: 'cost', amount: 400, affectedCategory: null, affectedStream: null, timing: null, text: '' }),
    ]);
    const parsed = await createLlmProvider(client).parseAdjustment('about four hundred for the repair', vocabulary);
    expect(parsed.adjustment?.amount).toBe(400);
    expect(parsed.amountDropped).toBe(false);
  });

  test('malformed output is dropped and the line is kept as context', async () => {
    const parsed = await createLlmProvider(new FakeLlmClient(['I think this is a cost of $400.'])).parseAdjustment('car repair $400', vocabulary);
    expect(parsed).toMatchObject({ adjustment: null, source: 'none', fallbackReason: 'malformed' });

    const wrongKind = await createLlmProvider(new FakeLlmClient([JSON.stringify({ kind: 'emergency', amount: 400 })])).parseAdjustment('car repair $400', vocabulary);
    expect(wrongKind.adjustment).toBeNull();
  });

  test('a pointer outside the vocabulary is nulled and reported; matching is case-insensitive', async () => {
    const client = new FakeLlmClient([
      JSON.stringify({ kind: 'spend_event', amount: null, affectedCategory: 'eating out', affectedStream: 'landlord', timing: null, text: '' }),
    ]);
    const parsed = await createLlmProvider(client).parseAdjustment("my sister's visiting", vocabulary);

    expect(parsed.adjustment).toMatchObject({ kind: 'spend_event', affectedCategory: 'Eating Out', affectedStream: null });
    expect(parsed.problems).toEqual(['unknown_bill']);
  });

  test('without a provider nothing is parsed; the plan stands', async () => {
    const parsed = await createLlmProvider(null).parseAdjustment('busy week', vocabulary);
    expect(parsed).toMatchObject({ adjustment: null, source: 'none', fallbackReason: 'no_provider' });
  });
});

describe('llmProviderFromEnv', () => {
  test('template-only unless LLM_PROVIDER says otherwise', () => {
    expect(llmProviderFromEnv({}).name).toBe('template');
    expect(llmProviderFromEnv({ LLM_PROVIDER: 'nonsense' }).name).toBe('template');
    expect(llmProviderFromEnv({ LLM_PROVIDER: 'ollama' }).name).toBe('ollama');
  });
});
