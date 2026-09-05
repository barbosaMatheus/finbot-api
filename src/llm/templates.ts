/**
 * Plain-template narration. What the anchor says when no model is
 * configured, the model failed, or its words carried a number it was not
 * given. Every figure here is read straight from the engine's output, so a
 * template is never wrong — only plain.
 *
 * Vocabulary from the notes: "lands", "around", "set aside"; never "due".
 */

import type {
  Adjustment,
  AdjustmentResult,
  Candidate,
  ExpectedBill,
  PeriodGrade,
  PlanDiffEntry,
  Shortlist,
  TargetDefinition,
  TargetResult,
} from '../gameplan/types.js';
import type { DiffExplanation, GradeExplanation, PlanExplanation } from './types.js';

export function money(value: number): string {
  const rounded = Math.round(Math.abs(value));
  return `${value < 0 ? '−' : ''}$${rounded.toLocaleString('en-US')}`;
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 29" from an ISO date; the raw string if it is not one. */
export function shortDate(iso: string | null): string | null {
  if (iso === null) return null;
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day)) return iso;
  return `${MONTHS[month - 1]} ${day}`;
}

function billPhrase(bill: ExpectedBill): string {
  if (bill.accrual && bill.status === 'accruing') {
    return `${bill.displayName} (${money(bill.accrual.accruedAfter)} of ${money(bill.accrual.totalAmount)} set aside, lands around ${shortDate(bill.expectedDate)})`;
  }
  if (bill.amountClass === 'variable' && bill.amountRange) {
    return `${bill.displayName} (has run ${money(bill.amountRange.low)}–${money(bill.amountRange.high)})`;
  }
  return `${bill.displayName} (${money(bill.shelfAmount)})`;
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The plain "why this" line for one target (§1 vocabulary). */
export function templateWhy(candidate: Candidate, shortlist: Shortlist): string {
  const target = candidate.definition;

  switch (target.type) {
    case 'spend_cap': {
      const base = `Keep ${target.bucket} under ${money(target.cap)} this period — it has run about ${money(target.periodAverage)}.`;
      const reset = candidate.reasons.find((reason) => reason.code === 'cap_reset_from_observed');
      const relaxed = candidate.reasons.find((reason) => reason.code === 'cap_relaxed_for_event');
      const shared = target.sharedAccounts
        ? ' Someone else spends from these accounts too, so treat it as a rough guide.'
        : '';
      if (relaxed && relaxed.code === 'cap_relaxed_for_event') {
        return `${target.bucket} can run to its usual ${money(target.cap)} this period.${shared}`;
      }
      if (reset && reset.code === 'cap_reset_from_observed') {
        return `Keep ${target.bucket} under ${money(target.cap)} — set from the ${money(reset.observed)} spent last period so it is reachable.${shared}`;
      }
      return `${base}${shared}`;
    }

    case 'frequency_cap':
      return `No more than ${target.maxCount} ${target.bucket} purchases this period — it has been about ${Math.round(target.periodCount)}.`;

    case 'bill_readiness': {
      const by = target.byDate ? ` by ${shortDate(target.byDate)}` : '';
      const bills = target.bills.map(billPhrase);
      const tight = shortlist.freeCash.tightReason === 'cash_check'
        ? ' The balance does not cover these yet, so this comes first.'
        : '';
      return `Have about ${money(target.amount)} set aside${by} — ${joinNames(bills)}.${tight}`;
    }

    case 'savings_transfer': {
      if (target.goal) {
        return `Move ${money(target.amount)} to savings after payday — ${money(target.goal.remaining)} to go for ${target.goal.description} over ${target.goal.periodsLeft} periods.`;
      }
      return `Move ${money(target.amount)} to savings after payday — ${percent(target.share)} of the ${money(target.freeCash)} left after bills and essentials.`;
    }

    case 'debt_payment':
      return `Pay ${money(target.amount)} toward what you owe — ${percent(target.share)} of the ${money(target.freeCash)} left after bills and essentials.`;

    case 'awareness':
      switch (target.kind) {
        case 'tag_unknowns':
          return `Tell us what about ${money(target.unknownAmount ?? 0)} of unlabelled spending was, so the numbers get sharper.`;
        case 'biggest_purchases':
          return `Look at your ${target.count ?? 3} biggest purchases this period and see whether each one was worth it.`;
        case 'which_can_move':
          return `The bills add up to more than this period's income. Which of these can move? ${joinNames((target.bills ?? []).map((bill) => bill.displayName))}.`;
      }
  }
}

export function templatePlan(shortlist: Shortlist): PlanExplanation {
  const why: Record<string, string> = {};
  for (const candidate of [...shortlist.plan, ...shortlist.alternates]) {
    why[candidate.id] = templateWhy(candidate, shortlist);
  }
  return { why };
}

export function targetLabel(target: TargetDefinition): string {
  switch (target.type) {
    case 'spend_cap':
      return `${target.bucket} under ${money(target.cap)}`;
    case 'frequency_cap':
      return `no more than ${target.maxCount} ${target.bucket} purchases`;
    case 'bill_readiness':
      return `${money(target.amount)} set aside for the bills`;
    case 'savings_transfer':
      return `the ${money(target.amount)} transfer to savings`;
    case 'debt_payment':
      return `the ${money(target.amount)} payment on what you owe`;
    case 'awareness':
      return target.kind === 'tag_unknowns'
        ? 'tagging the unlabelled spending'
        : target.kind === 'biggest_purchases'
          ? 'looking at your biggest purchases'
          : 'deciding which bills can move';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One plain line per graded target, with the number that decided it (§7). */
export function templateGradeLine(result: TargetResult): string {
  const label = capitalize(targetLabel(result.target));
  const details = result.details;

  const overrun = details.find((detail) => detail.code === 'bill_overrun_covered');
  const over = details.find((detail) => detail.code === 'over_by');
  const short = details.find((detail) => detail.code === 'commit_short');
  const within = details.find((detail) => detail.code === 'within');
  const unresolved = details.filter((detail) => detail.code === 'bill_unresolved');
  const fees = details.filter((detail) => detail.code === 'bill_fee');
  const balanceShort = details.find((detail) => detail.code === 'balance_short');

  switch (result.outcome) {
    case 'met':
      if (within && within.code === 'within' && result.target.type !== 'awareness') {
        return `${label}: met — ${money(within.measured)} against ${money(within.threshold)}.`;
      }
      if (result.target.type === 'bill_readiness' && unresolved.length > 0) {
        return `${label}: met — though ${joinNames(unresolved.map((d) => (d.code === 'bill_unresolved' ? d.displayName : '')))} has not landed yet.`;
      }
      return `${label}: met.`;
    case 'close':
      if (overrun && overrun.code === 'bill_overrun_covered') {
        return `${label}: close — short by ${money(overrun.shortBy)}, and ${joinNames(overrun.bills)} came in ${money(overrun.overrun)} over what was set aside. That is on the estimate, not you.`;
      }
      if (over && over.code === 'over_by') {
        return `${label}: close — ${money(over.measured)} against ${money(over.threshold)}, over by ${money(over.overBy)}.`;
      }
      if (short && short.code === 'commit_short') {
        return `${label}: close — ${money(short.measured)} of ${money(short.threshold)}.`;
      }
      return `${label}: close.`;
    case 'unresolved':
      return `${label}: ${joinNames(unresolved.map((d) => (d.code === 'bill_unresolved' ? d.displayName : '')))} was expected and has not landed — did it move, or get paid another way?`;
    case 'missed':
      if (fees.length > 0) {
        return `${label}: missed — ${joinNames(fees.map((d) => (d.code === 'bill_fee' ? d.displayName : '')))} posted with a fee or overdraft.`;
      }
      if (balanceShort && balanceShort.code === 'balance_short') {
        return `${label}: missed — ${money(balanceShort.balance)} in the account against ${money(balanceShort.remaining)} still expected.`;
      }
      if (over && over.code === 'over_by') {
        return `${label}: missed — ${money(over.measured)} against ${money(over.threshold)}.`;
      }
      if (short && short.code === 'commit_short') {
        return `${label}: missed — ${money(short.measured)} of ${money(short.threshold)}.`;
      }
      return `${label}: missed.`;
  }
}

export function templateGrade(grade: PeriodGrade): GradeExplanation {
  const lines = grade.results.map(templateGradeLine);
  const misses = grade.results.filter((result) => result.outcome === 'missed' || result.outcome === 'close');
  const improvements =
    misses.length === 0
      ? null
      : `Where to improve: ${joinNames(misses.map((result) => targetLabel(result.target)))}.`;
  return { lines, improvements };
}

function diffPhrase(entry: PlanDiffEntry): string | null {
  const { before, after } = entry;

  switch (entry.change) {
    case 'shrunk':
      if (before && after && 'amount' in before && 'amount' in after) {
        return `${targetLabel(after)} is ${money(after.amount)} for now instead of ${money(before.amount)}`;
      }
      return null;
    case 'moved_to_next_period':
      if (before && 'amount' in before) {
        const replacement = after ? `; ${targetLabel(after)} takes its place` : '';
        return `${targetLabel(before)} moves to next period${replacement}`;
      }
      return null;
    case 'relaxed':
      if (before?.type === 'spend_cap' && after?.type === 'spend_cap') {
        return `${after.bucket} can run to ${money(after.cap)} instead of ${money(before.cap)}`;
      }
      return null;
    case 'resized':
      if (after?.type === 'bill_readiness') {
        return `the bills now come to ${money(after.amount)}`;
      }
      return null;
    case 'replaced':
      if (before && after) return `${targetLabel(after)} replaces ${targetLabel(before)}`;
      if (before) return `${targetLabel(before)} comes out`;
      return null;
    case 'added':
      return after ? `${targetLabel(after)} is added` : null;
    case 'bills_infeasible':
      return "the bills add up to more than this period's income, so the plan asks which of them can move";
    case 'unchanged':
      return null;
  }
}

/** The heads-up reply: what changed and why, or plainly that nothing did (§5a, §6). */
export function templateDiff(result: AdjustmentResult, adjustment: Adjustment): DiffExplanation {
  switch (result.outcome) {
    case 'no_amount':
      return { reply: 'Noted. No amount was confirmed, so nothing in the plan moved; your note is kept as context.' };
    case 'context_only':
      return { reply: 'Noted. Nothing in the plan changes.' };
    case 'unknown_category':
    case 'no_cap_on_category':
      return { reply: 'Noted. There is no cap on that in this plan to change, so the plan stands.' };
    case 'unknown_bill':
      return { reply: 'Noted. That bill is not one the plan is expecting this period, so the plan stands.' };
    case 'applied':
      break;
  }

  const phrases = result.diff.map(diffPhrase).filter((phrase): phrase is string => phrase !== null);
  if (phrases.length === 0) {
    return { reply: 'Got it. The plan already covers that, so nothing moved.' };
  }

  const because = adjustment.text.trim() ? ` for "${adjustment.text.trim()}"` : '';
  return { reply: `Got it${because}: ${joinNames(phrases)}. Everything else stays as it was.` };
}
