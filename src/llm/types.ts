/**
 * The model boundary (§5 of the gameplan note, decision 5).
 *
 * Two layers. An `LlmClient` is a thin adapter over one model host and
 * knows nothing about plans: it takes a system prompt, a user message and
 * a schema, and returns the raw text the model produced. The `LlmProvider`
 * is the port the app calls: it builds the prompts, validates what comes
 * back, checks that no number was invented, and falls back to a plain
 * template when anything fails. The model writes words around numbers it
 * was given; it never chooses one.
 */

import type { z } from 'zod';

import type {
  Adjustment,
  AdjustmentResult,
  AdjustmentVocabulary,
  Period,
  PeriodGrade,
  Shortlist,
} from '../gameplan/types.js';
import type { AdjustmentProblem } from '../gameplan/adjustment.js';

// ---------------------------------------------------------------------------
// Client (one model host)
// ---------------------------------------------------------------------------

export type LlmJsonRequest<T> = {
  system: string;
  user: string;
  /** The shape the model must return; adapters pass it as a JSON schema. */
  schema: z.ZodType<T>;
  maxTokens: number;
};

export type LlmJsonResponse = {
  /** The raw text; the provider parses and validates it. */
  text: string;
  model: string;
};

export type LlmClient = {
  readonly name: string;
  completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResponse>;
};

/** Thrown by adapters for transport, auth, timeout and refusal failures. */
export class LlmClientError extends Error {
  constructor(
    message: string,
    public readonly code: 'transport' | 'auth' | 'timeout' | 'refusal' | 'bad_response',
  ) {
    super(message);
    this.name = 'LlmClientError';
  }
}

// ---------------------------------------------------------------------------
// Provider (the port)
// ---------------------------------------------------------------------------

export type ExplainInput =
  | { kind: 'plan'; shortlist: Shortlist }
  | { kind: 'grade'; grade: PeriodGrade; period: Period }
  | { kind: 'diff'; result: AdjustmentResult; adjustment: Adjustment };

export type ExplainKind = ExplainInput['kind'];

/** One "why this" line per plan target and alternate, keyed by candidate id. */
export type PlanExplanation = { why: Record<string, string> };

/** One line per graded target, in the grade's order, then the improvements paragraph. */
export type GradeExplanation = { lines: string[]; improvements: string | null };

/** The heads-up reply: what changed and why, in the user's own words. */
export type DiffExplanation = { reply: string };

export type ExplainOutputFor<K extends ExplainKind> = K extends 'plan'
  ? PlanExplanation
  : K extends 'grade'
    ? GradeExplanation
    : DiffExplanation;

export type NarrationFallbackReason =
  | 'no_provider'
  | 'client_error'
  | 'malformed'
  | 'number_invented';

export type Narration<T> = {
  output: T;
  /** Where the words came from. A template is never wrong, only plain. */
  source: 'model' | 'template';
  model: string | null;
  fallbackReason: NarrationFallbackReason | null;
};

export type ParsedAdjustment = {
  /**
   * The validated record. `amount` is the model's proposal for the box
   * (§5a); nothing applies it until the user confirms. Null when the
   * model's output was malformed or the client failed: the line is kept as
   * context and the plan stands.
   */
  adjustment: Adjustment | null;
  problems: AdjustmentProblem[];
  /** True when a proposed amount was dropped because the text never said it. */
  amountDropped: boolean;
  source: 'model' | 'none';
  model: string | null;
  fallbackReason: NarrationFallbackReason | null;
};

export type LlmProvider = {
  readonly name: string;
  explain<I extends ExplainInput>(input: I): Promise<Narration<ExplainOutputFor<I['kind']>>>;
  parseAdjustment(text: string, vocabulary: AdjustmentVocabulary): Promise<ParsedAdjustment>;
};
