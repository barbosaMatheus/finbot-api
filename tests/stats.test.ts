import { describe, expect, test } from '@jest/globals';

import { median, percentile } from '../src/lib/stats.js';

describe('median', () => {
  test('odd and even counts, unsorted input, empty list', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('percentile (nearest rank)', () => {
  const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];

  test('returns an observed value, never an interpolated one', () => {
    expect(percentile(values, 0.75)).toBe(8);
    expect(percentile(values, 0.9)).toBe(9);
    expect(percentile(values, 0.5)).toBe(5);
  });

  test('clamps at both ends and handles a single value', () => {
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 1)).toBe(10);
    expect(percentile([42], 0.75)).toBe(42);
    expect(percentile([], 0.75)).toBe(0);
  });
});
