/**
 * Merchant/entity name normalization.
 *
 * One normalization used everywhere a merchant identity matters — recurrence
 * grouping, merchant-scoped corrections, deterministic description rules —
 * so "NETFLIX.COM #1234" and "Netflix" agree on a key. Deliberately
 * conservative: it strips processor noise and store numbers, not meaning.
 */

/** Leading card-processor tags that hide the real merchant. */
const PROCESSOR_PREFIXES = [
  /^sq\s*\*\s*/i, // Square
  /^tst\s*\*\s*/i, // Toast
  /^pp\s*\*\s*/i, // PayPal short form
  /^paypal\s*\*\s*/i,
  /^py\s*\*\s*/i,
  /^ach\s+/i,
  /^pos\s+/i,
  /^dda\s+/i,
];

/** Corporate suffixes that vary between statements for the same merchant. */
const CORPORATE_SUFFIXES = /\b(inc|llc|ltd|co|corp|company|payments?)\.?$/i;

export function normalizeMerchant(
  merchantName: string | null | undefined,
  fallbackName?: string | null,
): string | null {
  const source = merchantName?.trim() || fallbackName?.trim();

  if (!source) {
    return null;
  }

  let value = source.toLowerCase().normalize('NFKC');

  for (const prefix of PROCESSOR_PREFIXES) {
    value = value.replace(prefix, '');
  }

  value = value
    // Store numbers and reference codes: "#1234", "no. 42".
    .replace(/#\s*\d+/g, ' ')
    .replace(/\bno\.?\s*\d+\b/g, ' ')
    // Dates that some institutions embed in descriptors.
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    // Long digit runs (phone numbers, reference ids). Keeps short numerics
    // that are part of a name (e.g. "7-eleven" keeps its 7 via word chars).
    .replace(/\b\d{4,}\b/g, ' ')
    // Vowel-less alphanumeric reference codes ("rt4z55tz0"): several digits
    // mixed into letters with no vowel is a receipt id, not a word.
    .replace(/\b(?=(?:[^\s]*\d){2})(?![^\s]*[aeiou])[a-z0-9]{6,}\b/g, ' ')
    // Web noise.
    .replace(/\b(www\.|\.com|\.net|\.org)\b/g, ' ')
    // Punctuation to spaces, keeping word/space/& only.
    .replace(/[^\p{L}\p{N}&\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // "Acme Payments LLC" sheds both trailing tokens, one pass each.
  let previous: string;
  do {
    previous = value;
    value = value.replace(CORPORATE_SUFFIXES, '').trim();
  } while (value !== previous && value.length > 0);

  return value.length > 0 ? value : null;
}
