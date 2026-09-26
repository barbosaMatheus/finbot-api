/**
 * The gameplan eval harness (gameplan step 7; architecture note "The
 * evaluation harness"). Two questions, answered over a fixed set of users:
 *
 *   1. Are the numbers right? Every scenario pins the plan the engine must
 *      produce — target ids, caps and amounts, free cash, the shelf, the
 *      plan-level reasons. A drift here fails the run.
 *   2. Does the model invent numbers? Every narration the configured
 *      provider produces (plan, grade, heads-up reply) is checked against
 *      its own input; the raw model text is measured even when the
 *      template replaced it. The fabricated-number rate is the Phase 1
 *      exit criterion, and it must be zero.
 *
 *   npm run eval:gameplan            # the configured LLM_PROVIDER (template by default)
 *   npm run eval:gameplan -- --traffic   # also summarize real narrations from the database
 *   npm run eval:gameplan -- --print-expected   # print the plans as JSON, to pin new scenarios
 */

import 'dotenv/config';

import { applyAdjustment } from '../gameplan/adjustment.js';
import { buildShortlist } from '../gameplan/candidates.js';
import { gradePeriod } from '../gameplan/grading.js';
import type { Shortlist } from '../gameplan/types.js';
import { llmProviderFromEnv } from '../llm/provider.js';
import type { LlmProvider, Narration } from '../llm/types.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { amountOf, checkRegression, observed, type RegressionFailure } from './regression.js';

type NarrationRow = {
  scenario: string;
  kind: 'plan' | 'grade' | 'diff';
  source: 'model' | 'template';
  fallbackReason: string | null;
  invented: number[];
  rawChars: number | null;
};

function row(scenario: string, kind: NarrationRow['kind'], narration: Narration<unknown>): NarrationRow {
  return {
    scenario,
    kind,
    source: narration.source,
    fallbackReason: narration.fallbackReason,
    invented: narration.raw?.invented ?? [],
    rawChars: narration.raw?.text.length ?? null,
  };
}

async function runScenario(
  scenario: Scenario,
  provider: LlmProvider,
): Promise<{ shortlist: Shortlist; failures: RegressionFailure[]; rows: NarrationRow[] }> {
  const shortlist = buildShortlist(scenario.input);
  const failures = checkRegression(scenario, shortlist);

  const targets = shortlist.plan.map((candidate) => candidate.definition);
  const grade = gradePeriod(targets, scenario.actuals);
  const result = applyAdjustment(scenario.input, scenario.adjustment);

  const [plan, gradeNarration, diff] = await Promise.all([
    provider.explain({ kind: 'plan', shortlist }),
    provider.explain({ kind: 'grade', grade, period: scenario.input.period }),
    provider.explain({ kind: 'diff', result, adjustment: scenario.adjustment }),
  ]);

  return {
    shortlist,
    failures,
    rows: [row(scenario.id, 'plan', plan), row(scenario.id, 'grade', gradeNarration), row(scenario.id, 'diff', diff)],
  };
}

type TrafficRow = { user: string; surface: string; source: string; fallback: string; count: number };

/** Real narrations: what the provenance columns say per user. */
async function trafficReport(): Promise<TrafficRow[]> {
  const { pool } = await import('../db.js');
  const { rows } = await pool.query<TrafficRow>(
    `SELECT u.email AS "user", 'plan' AS surface, p.plan_source AS source,
            COALESCE(p.plan_fallback_reason, '') AS fallback, COUNT(*)::int AS count
     FROM gameplan_periods p JOIN users u ON u.id = p.user_id
     WHERE p.plan_source IS NOT NULL
     GROUP BY u.email, p.plan_source, p.plan_fallback_reason
     UNION ALL
     SELECT u.email, 'grade', g.narration_source, COALESCE(g.narration_fallback_reason, ''), COUNT(*)::int
     FROM period_grades g JOIN users u ON u.id = g.user_id
     WHERE g.narration_source IS NOT NULL
     GROUP BY u.email, g.narration_source, g.narration_fallback_reason
     UNION ALL
     SELECT u.email, 'reply', r.reply_source, '', COUNT(*)::int
     FROM plan_revisions r JOIN users u ON u.id = r.user_id
     WHERE r.reply_source IS NOT NULL
     GROUP BY u.email, r.reply_source
     ORDER BY 1, 2, 3`,
  );
  await pool.end();
  return rows;
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const provider = llmProviderFromEnv();

  console.log(`gameplan eval · provider: ${provider.name} · scenarios: ${SCENARIOS.length}`);
  console.log('');

  const failures: RegressionFailure[] = [];
  const rows: NarrationRow[] = [];

  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario, provider);
    failures.push(...result.failures);
    rows.push(...result.rows);

    if (args.has('--print-expected')) {
      console.log(`${scenario.id}: ${JSON.stringify(observed(result.shortlist))}`);
      continue;
    }

    const mark = result.failures.length === 0 ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${scenario.id} — ${scenario.title}`);
    console.log(
      `     plan: ${result.shortlist.plan.map((c) => `${c.id}${amountOf(c.definition) !== null ? `=${amountOf(c.definition)}` : ''}`).join(' · ')}`,
    );
    for (const failure of result.failures) {
      console.log(`     ✗ ${failure.what}: expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)}`);
    }
  }

  if (args.has('--print-expected')) return;

  console.log('');
  console.log(`${pad('scenario', 20)}${pad('call', 7)}${pad('source', 10)}${pad('fallback', 18)}invented`);
  for (const entry of rows) {
    console.log(
      `${pad(entry.scenario, 20)}${pad(entry.kind, 7)}${pad(entry.source, 10)}${pad(entry.fallbackReason ?? '-', 18)}${
        entry.invented.length > 0 ? entry.invented.join(', ') : '-'
      }`,
    );
  }

  // The rate is measured over replies in the shape asked for: those are
  // the sentences the containment check judges. A malformed reply (a
  // loop cut off at the token cap, prose instead of JSON) is a separate
  // failure with its own count; the numbers in its text are shown but do
  // not count as fabricated, because no sentence of it was ever a
  // candidate to be shown.
  const modelCalls = rows.filter((entry) => entry.rawChars !== null);
  const wellFormed = modelCalls.filter((entry) => entry.fallbackReason === null || entry.fallbackReason === 'number_invented');
  const fabricated = wellFormed.filter((entry) => entry.fallbackReason === 'number_invented');
  const malformed = rows.filter((entry) => entry.fallbackReason === 'malformed');
  const clientErrors = rows.filter((entry) => entry.fallbackReason === 'client_error');
  const fromModel = rows.filter((entry) => entry.source === 'model').length;
  const rate = wellFormed.length === 0 ? 0 : fabricated.length / wellFormed.length;

  console.log('');
  console.log(`model calls: ${modelCalls.length} · narrated by the model: ${fromModel} · by the template: ${rows.length - fromModel}`);
  console.log(`well-formed replies: ${wellFormed.length} · malformed: ${malformed.length} · client errors: ${clientErrors.length}`);
  console.log(`fabricated-number rate (well-formed replies with an invented number): ${fabricated.length}/${wellFormed.length} = ${(rate * 100).toFixed(1)}%`);
  if (malformed.some((entry) => entry.invented.length > 0)) {
    console.log('(numbers listed on malformed rows come from text that was never a candidate to be shown; they do not count toward the rate)');
  }
  if (modelCalls.length === 0) {
    console.log('(no model host configured: set LLM_PROVIDER=ollama or anthropic to measure the real figure)');
  }

  if (args.has('--traffic')) {
    console.log('');
    console.log('real traffic (provenance columns):');
    const traffic = await trafficReport();
    if (traffic.length === 0) console.log('  none yet');
    for (const entry of traffic) {
      console.log(`  ${pad(entry.user, 28)}${pad(entry.surface, 7)}${pad(entry.source, 10)}${pad(entry.fallback || '-', 18)}${entry.count}`);
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.log(`${failures.length} regression failure(s)`);
    process.exit(1);
  }
  console.log('regression: green');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
