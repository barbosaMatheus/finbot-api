/**
 * The LlmProvider port (§5, §5a, decisions 5 and 13).
 *
 * `explain` narrates a plan, a grade or a heads-up diff from structured
 * input. What comes back is parsed, validated against the output schema,
 * and checked so that every number in the words exists in the input; on
 * any failure the plain template speaks and the reason is recorded.
 *
 * `parseAdjustment` turns a heads-up line into the engine's structured
 * record. The model may only point at the closed vocabulary, and an amount
 * it proposes must be one the text actually states — otherwise it is
 * dropped and the box opens empty. Nothing here applies anything: the
 * record is a proposal until the user confirms it.
 */

import type { z } from 'zod';

import { adjustmentSchema, validateAdjustment } from '../gameplan/adjustment.js';
import type { Adjustment, AdjustmentVocabulary } from '../gameplan/types.js';
import { logger } from '../lib/logger.js';
import { allowedNumbers, checkContainment, numbersInText } from './containment.js';
import { AnthropicClient } from './anthropic-client.js';
import { OllamaClient } from './ollama-client.js';
import {
  adjustmentPrompt,
  diffOutputSchema,
  diffPayload,
  diffPrompt,
  gradeOutputSchema,
  gradePayload,
  gradePrompt,
  planOutputSchema,
  planPayload,
  planPrompt,
} from './prompts.js';
import { templateDiff, templateGrade, templatePlan } from './templates.js';
import {
  LlmClientError,
  type DiffExplanation,
  type ExplainInput,
  type ExplainKind,
  type ExplainOutputFor,
  type GradeExplanation,
  type LlmClient,
  type LlmProvider,
  type Narration,
  type NarrationFallbackReason,
  type ParsedAdjustment,
  type PlanExplanation,
} from './types.js';

const NARRATION_MAX_TOKENS = 4096;
const ADJUSTMENT_MAX_TOKENS = 1024;

// The engine owns the record's schema; the adapters constrain the model to
// exactly what validateAdjustment accepts.
export const adjustmentRecordSchema = adjustmentSchema;

type ModelJson<T> = { ok: true; value: T; model: string } | { ok: false; reason: NarrationFallbackReason; model: string | null };

/** Call the client, parse JSON, validate the schema. Never throws. */
async function askForJson<T>(
  client: LlmClient,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  maxTokens: number,
): Promise<ModelJson<T>> {
  let text: string;
  let model: string;

  try {
    const response = await client.completeJson({ system, user, schema, maxTokens });
    text = response.text;
    model = response.model;
  } catch (error) {
    logger.warn('llm call failed; falling back to template', {
      client: client.name,
      code: error instanceof LlmClientError ? error.code : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'client_error', model: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    logger.warn('llm output was not JSON; falling back to template', { client: client.name, model });
    return { ok: false, reason: 'malformed', model };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    logger.warn('llm output did not match the schema; falling back to template', { client: client.name, model });
    return { ok: false, reason: 'malformed', model };
  }

  return { ok: true, value: result.data, model };
}

/** Tolerate a model that wraps its JSON in prose or a code fence. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function fallback<T>(output: T, reason: NarrationFallbackReason, model: string | null): Narration<T> {
  return { output, source: 'template', model, fallbackReason: reason };
}

/** Every string the model produced must pass containment against the payload it was given. */
function contained(texts: string[], payload: unknown, client: LlmClient, model: string): boolean {
  const allowed = allowedNumbers(payload);
  for (const text of texts) {
    const check = checkContainment(text, allowed);
    if (!check.ok) {
      logger.warn('llm narration carried a number not in its input; falling back to template', {
        client: client.name,
        model,
        invented: check.invented,
      });
      return false;
    }
  }
  return true;
}

async function explainWith(client: LlmClient | null, input: ExplainInput): Promise<Narration<PlanExplanation | GradeExplanation | DiffExplanation>> {
  switch (input.kind) {
    case 'plan': {
      const template = templatePlan(input.shortlist);
      if (!client) return fallback(template, 'no_provider', null);

      const { system, user } = planPrompt(input.shortlist);
      const answer = await askForJson(client, system, user, planOutputSchema, NARRATION_MAX_TOKENS);
      if (!answer.ok) return fallback(template, answer.reason, answer.model);

      // Every target must get a line, and every line must be contained;
      // a missing line means the template speaks for the whole plan.
      const why: Record<string, string> = {};
      for (const item of answer.value.items) {
        if (item.id in template.why && item.why.trim()) why[item.id] = item.why.trim();
      }
      const complete = Object.keys(template.why).every((id) => id in why);
      if (!complete) return fallback(template, 'malformed', answer.model);
      if (!contained(Object.values(why), planPayload(input.shortlist), client, answer.model)) {
        return fallback(template, 'number_invented', answer.model);
      }
      return { output: { why }, source: 'model', model: answer.model, fallbackReason: null };
    }

    case 'grade': {
      const template = templateGrade(input.grade);
      if (!client) return fallback(template, 'no_provider', null);

      const { system, user } = gradePrompt(input.grade, input.period);
      const answer = await askForJson(client, system, user, gradeOutputSchema, NARRATION_MAX_TOKENS);
      if (!answer.ok) return fallback(template, answer.reason, answer.model);

      const lines: string[] = [];
      for (let index = 0; index < input.grade.results.length; index += 1) {
        const line = answer.value.lines.find((entry) => entry.index === index);
        if (!line || !line.text.trim()) return fallback(template, 'malformed', answer.model);
        lines.push(line.text.trim());
      }
      const improvements = answer.value.improvements?.trim() || null;
      const texts = improvements ? [...lines, improvements] : lines;
      if (!contained(texts, gradePayload(input.grade, input.period), client, answer.model)) {
        return fallback(template, 'number_invented', answer.model);
      }
      return { output: { lines, improvements }, source: 'model', model: answer.model, fallbackReason: null };
    }

    case 'diff': {
      const template = templateDiff(input.result, input.adjustment);
      if (!client) return fallback(template, 'no_provider', null);

      const { system, user } = diffPrompt(input.result, input.adjustment);
      const answer = await askForJson(client, system, user, diffOutputSchema, NARRATION_MAX_TOKENS);
      if (!answer.ok) return fallback(template, answer.reason, answer.model);

      const reply = answer.value.reply.trim();
      if (!reply) return fallback(template, 'malformed', answer.model);
      if (!contained([reply], diffPayload(input.result, input.adjustment), client, answer.model)) {
        return fallback(template, 'number_invented', answer.model);
      }
      return { output: { reply }, source: 'model', model: answer.model, fallbackReason: null };
    }
  }
}

async function parseAdjustmentWith(
  client: LlmClient | null,
  text: string,
  vocabulary: AdjustmentVocabulary,
): Promise<ParsedAdjustment> {
  const none = (reason: NarrationFallbackReason, model: string | null): ParsedAdjustment => ({
    adjustment: null,
    problems: [],
    amountDropped: false,
    source: 'none',
    model,
    fallbackReason: reason,
  });

  if (!client) return none('no_provider', null);

  const { system, user } = adjustmentPrompt(text, vocabulary);
  const answer = await askForJson(client, system, user, adjustmentRecordSchema, ADJUSTMENT_MAX_TOKENS);
  if (!answer.ok) return none(answer.reason, answer.model);

  const validated = validateAdjustment({ ...answer.value, text }, vocabulary);
  if (!validated) return none('malformed', answer.model);

  // The only door for a number is the box the user confirms (§5a); the
  // model may pre-fill it only with a figure the text actually states.
  let adjustment: Adjustment = validated.adjustment;
  let amountDropped = false;
  if (adjustment.amount !== null) {
    const stated = numbersInText(text);
    const proposal = Math.abs(adjustment.amount);
    const present = stated.some((n) => Math.abs(Math.abs(n) - proposal) < 0.005);
    if (!present) {
      logger.warn('llm proposed an amount the heads-up never stated; dropped', {
        client: client.name,
        model: answer.model,
        proposed: adjustment.amount,
      });
      adjustment = { ...adjustment, amount: null };
      amountDropped = true;
    }
  }

  return {
    adjustment,
    problems: validated.problems,
    amountDropped,
    source: 'model',
    model: answer.model,
    fallbackReason: amountDropped ? 'number_invented' : null,
  };
}

/** Build the port over a client; `null` gives the template-only provider. */
export function createLlmProvider(client: LlmClient | null): LlmProvider {
  return {
    name: client ? client.name : 'template',
    explain<I extends ExplainInput>(input: I): Promise<Narration<ExplainOutputFor<I['kind']>>> {
      return explainWith(client, input) as Promise<Narration<ExplainOutputFor<I['kind']>>>;
    },
    parseAdjustment(text: string, vocabulary: AdjustmentVocabulary): Promise<ParsedAdjustment> {
      return parseAdjustmentWith(client, text, vocabulary);
    },
  };
}

export type LlmEnv = {
  LLM_PROVIDER?: string;
  OLLAMA_URL?: string;
  OLLAMA_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_EFFORT?: string;
  LLM_TIMEOUT_MS?: string;
};

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'llama3.1';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
export const DEFAULT_LLM_TIMEOUT_MS = 20_000;

/**
 * The provider the environment selects. Template-only unless LLM_PROVIDER
 * is set, so a fresh stack narrates plainly rather than failing against a
 * model host that is not running.
 */
export function llmProviderFromEnv(env: LlmEnv = process.env): LlmProvider {
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) > 0 ? Number(env.LLM_TIMEOUT_MS) : DEFAULT_LLM_TIMEOUT_MS;

  switch ((env.LLM_PROVIDER ?? 'template').toLowerCase()) {
    case 'ollama':
      return createLlmProvider(
        new OllamaClient({
          baseUrl: env.OLLAMA_URL || DEFAULT_OLLAMA_URL,
          model: env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
          timeoutMs,
        }),
      );
    case 'anthropic': {
      const effort = env.ANTHROPIC_EFFORT === 'medium' || env.ANTHROPIC_EFFORT === 'high' ? env.ANTHROPIC_EFFORT : 'low';
      return createLlmProvider(
        new AnthropicClient({
          model: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
          timeoutMs,
          effort,
          ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
        }),
      );
    }
    case 'template':
    default:
      return createLlmProvider(null);
  }
}

export type { ExplainKind };
