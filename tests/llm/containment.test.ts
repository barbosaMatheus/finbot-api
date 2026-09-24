import { describe, expect, test } from '@jest/globals';

import { allowedNumbers, checkContainment, numbersInText } from '../../src/llm/containment.js';

describe('numbersInText', () => {
  test('reads dollars, thousands separators, percents, ordinals and k-suffixes', () => {
    expect(numbersInText('Have about $1,472 set aside by Sep 29')).toEqual([1472, 29]);
    expect(numbersInText('20% of the $448 left')).toEqual([20, 448]);
    expect(numbersInText('around the 12th')).toEqual([12]);
    expect(numbersInText('about 1.2k for the repair')).toEqual([1200]);
    expect(numbersInText('down by −$52')).toEqual([-52]);
    expect(numbersInText('$15.49 each time')).toEqual([15.49]);
  });

  test('reads number words', () => {
    expect(numbersInText('about four hundred for the repair')).toEqual([400]);
    expect(numbersInText('twelve hundred dollars')).toEqual([1200]);
    expect(numbersInText('a grand, maybe')).toEqual([1000]);
    expect(numbersInText('twenty-five delivery orders')).toEqual([25]);
    expect(numbersInText('one of the two bills')).toEqual([1, 2]);
    expect(numbersInText('two thousand three hundred')).toEqual([2300]);
  });

  test('articles alone are not numbers', () => {
    expect(numbersInText('a busy week with a lot of bills')).toEqual([]);
    expect(numbersInText('an ordinary period')).toEqual([]);
  });
});

describe('allowedNumbers', () => {
  test('admits values, their percent and rounded forms, date parts, string numbers and array lengths', () => {
    const allowed = allowedNumbers({
      share: 0.25,
      byDate: '2026-09-29',
      targetMonth: '2026-10',
      bills: ['a', 'b', 'c'],
      range: 'has run $90–$140',
      cents: 15.49,
    });

    for (const n of [0.25, 25, 2026, 9, 29, 10, 3, 90, 140, 15.49, 15]) {
      expect(allowed.has(n)).toBe(true);
    }
    expect(allowed.has(500)).toBe(false);
  });
});

describe('checkContainment', () => {
  const allowed = allowedNumbers({ amount: 112, share: 0.25, freeCash: 448, byDate: '2026-09-29' });

  test('passes when every number in the words is in the input', () => {
    expect(checkContainment('Move $112 to savings — 25% of the $448 left, by Sep 29.', allowed)).toEqual({
      ok: true,
      invented: [],
    });
  });

  test('fails on a number the input never had, and names it', () => {
    expect(checkContainment('Move $112 now and $500 next month.', allowed)).toEqual({
      ok: false,
      invented: [500],
    });
    expect(checkContainment('about four hundred', allowed).invented).toEqual([400]);
  });

  test('a sum the model computed is an invented number', () => {
    // 112 + 448 = 560: derivable, but not given, so it fails.
    expect(checkContainment('That leaves $560 in total.', allowed).ok).toBe(false);
  });
});
