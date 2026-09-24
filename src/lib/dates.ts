/**
 * Calendar arithmetic on YYYY-MM-DD strings, UTC, no clock. Shared by the
 * gameplan engine (periods, bill windows, accrual) so every module counts
 * days the same way.
 */

const MS_PER_DAY = 86_400_000;

export type CalendarDate = { year: number; month: number; day: number };

export function parseIsoDate(iso: string): CalendarDate {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid ISO date: ${iso}`);
  }

  return { year, month, day };
}

export function toIsoDate(date: CalendarDate): string {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

/** Whole days since the Unix epoch. */
export function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / MS_PER_DAY);
}

export function addDays(iso: string, days: number): string {
  return new Date((dayNumber(iso) + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** `to` − `from` in whole days; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dayOfMonth(iso: string): number {
  return parseIsoDate(iso).day;
}

/**
 * The given day-of-month in the month `months` after (or before) `iso`'s
 * month, clamped to that month's last day: the 31st in February is the
 * 28th or 29th.
 */
export function anchoredDate(iso: string, months: number, day: number): string {
  const { year, month } = parseIsoDate(iso);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;

  return toIsoDate({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
}

/** Inclusive overlap of two closed date ranges. */
export function rangesOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  return dayNumber(a.start) <= dayNumber(b.end) && dayNumber(b.start) <= dayNumber(a.end);
}

export function minIso(a: string, b: string): string {
  return dayNumber(a) <= dayNumber(b) ? a : b;
}

export function maxIso(a: string, b: string): string {
  return dayNumber(a) >= dayNumber(b) ? a : b;
}
