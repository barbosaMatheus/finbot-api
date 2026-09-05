import { describe, expect, test } from '@jest/globals';

import {
  addDays,
  anchoredDate,
  dayOfMonth,
  daysBetween,
  daysInMonth,
  rangesOverlap,
} from '../src/lib/dates.js';

describe('dates', () => {
  test('day arithmetic crosses month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-09-25', '2027-03-14')).toBe(170);
    expect(daysBetween('2026-09-25', '2026-09-24')).toBe(-1);
    expect(dayOfMonth('2026-09-25')).toBe(25);
  });

  test('anchored dates clamp to the month length', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(anchoredDate('2026-01-31', 1, 31)).toBe('2026-02-28');
    expect(anchoredDate('2026-01-15', 12, 15)).toBe('2027-01-15');
    expect(anchoredDate('2026-11-05', 3, 5)).toBe('2027-02-05');
    expect(anchoredDate('2026-03-10', -1, 10)).toBe('2026-02-10');
  });

  test('closed ranges overlap inclusively', () => {
    const period = { start: '2026-09-25', end: '2026-10-08' };
    expect(rangesOverlap({ start: '2026-10-08', end: '2026-10-12' }, period)).toBe(true);
    expect(rangesOverlap({ start: '2026-10-09', end: '2026-10-12' }, period)).toBe(false);
    expect(rangesOverlap({ start: '2026-09-20', end: '2026-09-25' }, period)).toBe(true);
  });
});
