/**
 * The one figure a target is sized by: the cap, the count or the amount.
 * Null for awareness, which has none.
 */

import type { TargetDefinition } from './types.js';

export function amountOf(definition: TargetDefinition): number | null {
  switch (definition.type) {
    case 'spend_cap':
      return definition.cap;
    case 'frequency_cap':
      return definition.maxCount;
    case 'bill_readiness':
    case 'savings_transfer':
    case 'debt_payment':
      return definition.amount;
    case 'awareness':
      return null;
  }
}

/**
 * How far a target moved between two plans, as a positive figure, or null
 * when either side has no amount or nothing moved. The engine works this
 * out so the narration can quote it: a model that subtracts states a
 * number it was never given, and the number check withholds it.
 */
export function changeAmountOf(before: TargetDefinition | null, after: TargetDefinition | null): number | null {
  const from = before ? amountOf(before) : null;
  const to = after ? amountOf(after) : null;
  if (from === null || to === null || from === to) return null;
  return Math.round(Math.abs(from - to) * 100) / 100;
}
