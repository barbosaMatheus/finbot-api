import { describe, expect, jest, test } from '@jest/globals';

import { checkRegression, observed } from '../../src/eval/regression.js';
import { SCENARIOS } from '../../src/eval/scenarios.js';
import { buildShortlist } from '../../src/gameplan/candidates.js';
import { FakeLlmClient } from '../../src/llm/fake-client.js';
import { createLlmProvider } from '../../src/llm/provider.js';
import { LlmClientError } from '../../src/llm/types.js';

jest.spyOn(console, 'warn').mockImplementation(() => {});

describe('eval scenarios (gameplan step 7)', () => {
  for (const scenario of SCENARIOS) {
    test(`${scenario.id} builds the pinned plan`, () => {
      expect(checkRegression(scenario, buildShortlist(scenario.input))).toEqual([]);
    });
  }

  test('the six users reach the branches the harness is meant to cover', () => {
    const plans = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, observed(buildShortlist(scenario.input))]));

    expect(plans['tight']!.reasons).toContain('tight_cash_check');
    expect(plans['tight']!.planIds).not.toContain('savings_transfer');
    expect(plans['not-sure']!.planIds.some((id) => id.startsWith('awareness:'))).toBe(true);
    expect(plans['shared']!.reasons).toContain('shared_accounts');
    expect(plans['fixed-day']!.shelf).toBeLessThan(plans['sam']!.shelf);
    expect(plans['save-for-specific']!.amounts['savings_transfer']).toBeGreaterThan(plans['sam']!.amounts['savings_transfer']!);
  });

  test('a drift in the numbers is reported by name', () => {
    const sam = SCENARIOS[0]!;
    const drifted = {
      ...sam,
      expected: { ...sam.expected, amounts: { ...sam.expected.amounts, savings_transfer: 100 }, shelf: 1 },
    };
    expect(checkRegression(drifted, buildShortlist(sam.input)).map((failure) => failure.what)).toEqual([
      'amount of savings_transfer',
      'shelf',
    ]);
  });
});

describe('the raw narration the harness measures', () => {
  const shortlist = buildShortlist(SCENARIOS[0]!.input);
  const ids = [...shortlist.plan, ...shortlist.alternates].map((candidate) => candidate.id);
  const answer = (why: Record<string, string>): string =>
    JSON.stringify({ items: ids.map((id) => ({ id, why: why[id] ?? 'A smaller change you could swap in.' })) });

  test('a narration that passes carries its raw text and no invented numbers', async () => {
    const text = answer({ savings_transfer: 'Move $112 to savings after payday.' });
    const narration = await createLlmProvider(new FakeLlmClient([text])).explain({ kind: 'plan', shortlist });

    expect(narration.source).toBe('model');
    expect(narration.raw).toEqual({ text, invented: [] });
  });

  test('an invented number stays on the narration after the template replaced the words', async () => {
    const text = answer({ savings_transfer: 'Move $112 now and you will have $500 by December.' });
    const narration = await createLlmProvider(new FakeLlmClient([text])).explain({ kind: 'plan', shortlist });

    expect(narration).toMatchObject({ source: 'template', fallbackReason: 'number_invented' });
    expect(narration.raw).toEqual({ text, invented: [500] });
  });

  test('malformed output is still measured: the raw text and whatever numbers it carried', async () => {
    const text = 'Sure! Save $999 this week.';
    const narration = await createLlmProvider(new FakeLlmClient([text])).explain({ kind: 'plan', shortlist });

    expect(narration.fallbackReason).toBe('malformed');
    expect(narration.raw).toEqual({ text, invented: [999] });
  });

  test('nothing to measure when the client failed or no provider is configured', async () => {
    const failed = await createLlmProvider(new FakeLlmClient([new LlmClientError('boom', 'transport')])).explain({ kind: 'plan', shortlist });
    expect(failed.raw).toBeNull();

    const none = await createLlmProvider(null).explain({ kind: 'plan', shortlist });
    expect(none.raw).toBeNull();
  });
});
