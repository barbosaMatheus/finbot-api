/**
 * Prompts for the three narration calls and the heads-up parser (§5). The
 * structured input is the only source of numbers; the voice rules come
 * from the cadence note (plain language, positives first, constant across
 * paces, no judgment) and the gameplan note ("lands", "around", never
 * "due").
 */

import { z } from 'zod';

import type {
  Adjustment,
  AdjustmentResult,
  AdjustmentVocabulary,
  Period,
  PeriodGrade,
  Shortlist,
} from '../gameplan/types.js';

export const VOICE_RULES = `You write for a budgeting app that never invents a number.
Rules:
- Use only numbers that appear in the JSON you are given. Do not add, round, sum or estimate any figure. If you need a number that is not there, leave it out.
- Plain language, short sentences, no budgeting jargon, no exclamation marks, no judgment.
- Positives first. The same calm voice whatever the pace.
- Bills "land" or "come out" "around" a date. Never say "due".
- Dollar amounts as whole dollars with a $ sign, e.g. $1,472.
- Return only the JSON asked for.`;

export const planOutputSchema = z.object({
  items: z.array(z.object({ id: z.string(), why: z.string() })),
});

export const gradeOutputSchema = z.object({
  lines: z.array(z.object({ index: z.number().int(), text: z.string() })),
  improvements: z.string().nullable(),
});

export const diffOutputSchema = z.object({
  reply: z.string(),
});

/** What the model sees for a plan: the targets, their reasons, and the period's numbers. Nothing else. */
export function planPayload(shortlist: Shortlist): Record<string, unknown> {
  const describe = (role: 'plan' | 'alternate') => (candidate: Shortlist['plan'][number]) => ({
    id: candidate.id,
    role,
    target: candidate.definition,
    reasons: candidate.reasons,
  });

  return {
    period: shortlist.period,
    pace: shortlist.pace,
    freeCash: shortlist.freeCash,
    shelf: { total: shortlist.shelf.total, byDate: shortlist.shelf.earliestWindowStart },
    planReasons: shortlist.reasons,
    targets: [...shortlist.plan.map(describe('plan')), ...shortlist.alternates.map(describe('alternate'))],
  };
}

export function planPrompt(shortlist: Shortlist): { system: string; user: string } {
  return {
    system: `${VOICE_RULES}
Task: for each target, write one "why this" sentence (at most 25 words) that ties the target to the numbers behind it. Return {"items":[{"id":"<target id>","why":"<sentence>"}]} with one item per target, plan targets and alternates alike.`,
    user: JSON.stringify(planPayload(shortlist)),
  };
}

export function gradePayload(grade: PeriodGrade, period: Period): Record<string, unknown> {
  return {
    period,
    results: grade.results.map((result, index) => ({
      index,
      outcome: result.outcome,
      target: result.target,
      details: result.details,
    })),
    billOverrunTotal: grade.billOverrunTotal,
  };
}

export function gradePrompt(grade: PeriodGrade, period: Period): { system: string; user: string } {
  return {
    system: `${VOICE_RULES}
Task: the results are already ordered so the positives come first. For each result, write one sentence (at most 30 words) saying how it went and the number that decided it. A bill that never landed is neither met nor missed: say it was expected and ask whether it moved. Then write one short "where you could improve" paragraph (at most 40 words), or null if nothing was missed or close. Return {"lines":[{"index":<result index>,"text":"<sentence>"}],"improvements":<paragraph or null>}.`,
    user: JSON.stringify(gradePayload(grade, period)),
  };
}

export function diffPayload(result: AdjustmentResult, adjustment: Adjustment): Record<string, unknown> {
  return {
    headsUp: adjustment.text,
    kind: adjustment.kind,
    confirmedAmount: adjustment.amount,
    outcome: result.outcome,
    // Unchanged entries stay in, so the reply can say what did not move.
    changes: result.diff,
    freeCashAfter: result.after.freeCash.freeCash,
  };
}

export function diffPrompt(result: AdjustmentResult, adjustment: Adjustment): { system: string; user: string } {
  return {
    system: `${VOICE_RULES}
Task: the user gave a heads-up and the plan was re-computed. In at most two sentences, say what changed and why, using the user's own words for the reason; entries whose change is "unchanged" did not move. If nothing moved, say so plainly and why. Return {"reply":"<text>"}.`,
    user: JSON.stringify(diffPayload(result, adjustment)),
  };
}

export function adjustmentPrompt(text: string, vocabulary: AdjustmentVocabulary): { system: string; user: string } {
  return {
    system: `You turn one line a user wrote at their budget check-in into a structured record. You may only point at the categories, bills and dates listed. Never guess an amount: set "amount" only when the text states a figure (as digits or as words), otherwise null.
kind: "cost" for a one-off expense coming up, "spend_event" for something that will raise spending in a category (a visit, a trip, a busy week), "income_change" for more or less money coming in (amount is the change, negative for less), "bill_change" for a listed bill changing size (amount is the new size), "other" for anything else.
affectedCategory: one of the listed category names, or null. affectedStream: one of the listed bill keys, or null. timing: {"start","end"} within the period as YYYY-MM-DD, or null. text: the user's line, unchanged.
Return only the JSON.`,
    user: JSON.stringify({
      text,
      categories: vocabulary.categories,
      bills: vocabulary.bills,
      period: vocabulary.period,
    }),
  };
}
