/**
 * Number containment: every number in the model's words must exist in the
 * structured input it was given (§5, decision 5). This is the check that
 * keeps the Phase 1 "fabricated-number rate of zero" achievable — a model
 * that rounds, sums or guesses a figure fails it and the template speaks
 * instead.
 *
 * Numbers are read from text as digits ($1,472 · 29th · 20% · 1.2k) and as
 * small number words ("four hundred", "twelve"). Numbers are allowed from
 * the input as every numeric value, every number inside a string, the
 * parts of ISO dates, the length of every array (so "three targets" or
 * "two bills" can be said), and the percent form of any share between 0
 * and 1.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000, grand: 1000, k: 1000 };

const DIGIT_PATTERN = /(?<![\w.])[-−]?\$?\d[\d,]*(?:\.\d+)?(?:\s?[kK](?![a-z]))?%?(?:st|nd|rd|th)?(?![\w.])/g;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function parseDigitToken(token: string): number | null {
  const negative = /^[-−]/.test(token);
  const thousands = /\d\s?[kK]/.test(token);
  const cleaned = token.replace(/[^\d.]/g, '');
  if (cleaned === '' || cleaned === '.') return null;

  let value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  if (thousands) value *= 1000;
  return negative ? -value : value;
}

/**
 * Number words, left to right: units and tens add, "hundred" multiplies
 * the running unit, "thousand" closes a group. "a hundred" and "a grand"
 * read as one unit; a lone "a" never counts.
 */
function parseNumberWords(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let sawNumber = false;

  for (const raw of words) {
    const word = raw.toLowerCase();

    if (word in UNITS) {
      current += UNITS[word]!;
      sawNumber = true;
    } else if (word in TENS) {
      current += TENS[word]!;
      sawNumber = true;
    } else if (word === 'a' || word === 'an') {
      if (current === 0) current = 1;
    } else if (word in MULTIPLIERS) {
      const factor = MULTIPLIERS[word]!;
      if (factor === 100) {
        current = (current === 0 ? 1 : current) * factor;
      } else {
        total += (current === 0 ? 1 : current) * factor;
        current = 0;
      }
      sawNumber = true;
    } else {
      return null;
    }
  }

  return sawNumber ? total + current : null;
}

const NUMBER_WORD = new RegExp(
  `\\b(?:${[...Object.keys(UNITS), ...Object.keys(TENS), 'hundred', 'thousand', 'grand', 'a', 'an']
    .join('|')})\\b`,
  'i',
);

/** Every number a piece of text states, as digits or as number words. */
export function numbersInText(text: string): number[] {
  const found: number[] = [];

  for (const match of text.matchAll(DIGIT_PATTERN)) {
    const value = parseDigitToken(match[0]);
    if (value !== null) found.push(value);
  }

  // Number-word runs: consecutive tokens that all belong to the vocabulary.
  const tokens = text.split(/[^A-Za-z]+/).filter(Boolean);
  let run: string[] = [];

  const flush = () => {
    // Drop leading/trailing articles so "a busy week" is not a number.
    while (run.length > 0 && /^(a|an)$/i.test(run[0]!)) run.shift();
    while (run.length > 0 && /^(a|an)$/i.test(run[run.length - 1]!)) run.pop();
    if (run.length > 0) {
      const value = parseNumberWords(run);
      if (value !== null) found.push(value);
    }
    run = [];
  };

  for (const token of tokens) {
    if (NUMBER_WORD.test(token)) run.push(token);
    else flush();
  }
  flush();

  return found;
}

/**
 * Every number a structured value may be quoted for: numeric values and
 * their rounded and percent forms, numbers inside strings, ISO date parts,
 * and array lengths.
 */
export function allowedNumbers(value: unknown): Set<number> {
  const allowed = new Set<number>();

  const admit = (n: number) => {
    if (!Number.isFinite(n)) return;
    allowed.add(round2(n));
    allowed.add(round2(Math.abs(n)));
    allowed.add(Math.round(n));
    allowed.add(Math.abs(Math.round(n)));
    if (n > 0 && n <= 1) allowed.add(Math.round(n * 100));
  };

  const walk = (node: unknown): void => {
    if (typeof node === 'number') {
      admit(node);
      return;
    }

    if (typeof node === 'string') {
      const date = ISO_DATE_PATTERN.exec(node) ?? YEAR_MONTH_PATTERN.exec(node);
      if (date) {
        for (const part of date.slice(1)) admit(Number(part));
        return;
      }
      for (const n of numbersInText(node)) admit(n);
      return;
    }

    if (Array.isArray(node)) {
      admit(node.length);
      for (const item of node) walk(item);
      return;
    }

    if (typeof node === 'object' && node !== null) {
      for (const item of Object.values(node)) walk(item);
    }
  };

  walk(value);
  return allowed;
}

export type ContainmentResult = {
  ok: boolean;
  /** Numbers in the text with no counterpart in the input. */
  invented: number[];
};

/** Check text against an allowed set; a number matches within half a cent. */
export function checkContainment(text: string, allowed: Set<number>): ContainmentResult {
  const invented: number[] = [];

  for (const n of numbersInText(text)) {
    const candidates = [n, Math.abs(n), round2(n), round2(Math.abs(n))];
    const matches = candidates.some((candidate) =>
      [...allowed].some((value) => Math.abs(value - candidate) < 0.005),
    );
    if (!matches) invented.push(n);
  }

  return { ok: invented.length === 0, invented };
}
