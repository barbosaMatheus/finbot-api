/**
 * The API contract registry (API-003).
 *
 * Request schemas are the exact Zod schemas the routes validate with —
 * imported, not copied — so the published document cannot drift from
 * runtime validation. Response schemas are defined here in Zod and used to
 * validate the checked-in examples in the contract tests.
 */

import { z } from 'zod';

import { credentialsSchema, nativeRefreshSchema } from '../routes/auth.js';
import { registerSchema as pushRegisterSchema } from '../routes/notifications.js';
import {
  confirmSchema,
  correctionSchema,
  onboardingPayloadSchema,
  onboardingSchema,
} from '../routes/onboarding.js';
import {
  exchangeSchema,
  hostedLinkSchema,
  linkTokenSchema,
} from '../routes/plaid.js';
import { buildPromptSchema } from '../routes/prompt-template.js';
import { queryVectorDbSchema } from '../routes/query-vector-db.js';

// ---------------------------------------------------------------------------
// Shared response schemas
// ---------------------------------------------------------------------------

export const errorEnvelopeSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  onboardingComplete: z.boolean(),
});

export const webAuthResponseSchema = z.object({ user: authUserSchema });

export const nativeAuthResponseSchema = z.object({
  user: authUserSchema,
  accessToken: z.string(),
  refreshToken: z.string(),
  refreshExpiresInSeconds: z.number().int(),
});

export const linkTokenResultSchema = z.object({
  linkToken: z.string(),
  expiration: z.string().nullable(),
  hostedLinkUrl: z.string().nullable(),
});

export const accountSummarySchema = z.object({
  accountId: z.string(),
  name: z.string(),
  officialName: z.string().nullable(),
  mask: z.string().nullable(),
  type: z.string(),
  subtype: z.string().nullable(),
  currentBalance: z.number().nullable(),
  availableBalance: z.number().nullable(),
  isoCurrencyCode: z.string().nullable(),
});

export const connectionHealthSchema = z.object({
  syncStatus: z.enum(['pending', 'syncing', 'complete', 'failed']),
  updateStatus: z.string(),
  oldestTransactionDate: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
});

export const connectionSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  institutionId: z.string().nullable(),
  institutionName: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  accounts: z.array(accountSummarySchema),
  health: connectionHealthSchema.nullable().optional(),
  duplicate: z.boolean().optional(),
});

export const connectionsResponseSchema = z.object({
  connections: z.array(connectionSchema),
});

export const exchangeResponseSchema = z.object({ connection: connectionSchema });

export const hostedLinkCompletionSchema = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('connected'), connection: connectionSchema }),
]);

export const savedOnboardingResponseSchema = z.object({
  saved: z
    .object({
      // The exact shape the wizard submits, so the client resumes without
      // re-mapping and the generated types know every field.
      payload: onboardingPayloadSchema,
      updatedAt: z.string(),
    })
    .nullable(),
});

// --- Onboarding status ------------------------------------------------------

export const onboardingPhaseSchema = z.enum([
  'financial_linking',
  'manual_profile_in_progress',
  'waiting_for_history',
  'classifying',
  'review_ready',
  'recomputing',
  'failed_retryable',
  'complete',
]);

export const analysisRunStatusSchema = z.enum([
  'waiting_for_history',
  'processing',
  'review_ready',
  'recomputing',
  'confirmed',
  'failed',
  'superseded',
]);

export const onboardingStatusResponseSchema = z.object({
  phase: onboardingPhaseSchema,
  gates: z.object({
    hasLinkedInstitution: z.boolean(),
    linkingDeclaredComplete: z.boolean(),
    manualProfileComplete: z.boolean(),
    analysisReviewable: z.boolean(),
    financialReviewConfirmed: z.boolean(),
  }),
  analysis: z
    .object({
      runId: z.string(),
      status: analysisRunStatusSchema,
      requestedLookbackDays: z.number().int(),
      institutions: z.object({
        total: z.number().int(),
        ready: z.number().int(),
        limited: z.number().int(),
        failed: z.number().int(),
        pending: z.number().int(),
      }),
      startedAt: z.string(),
      reviewReadyAt: z.string().nullable(),
      retryAllowed: z.boolean(),
      errorCode: z.string().nullable(),
    })
    .nullable(),
  availableActions: z.array(z.string()),
  onboardingComplete: z.boolean(),
});

// --- Financial facts / review ----------------------------------------------

export const categoryTotalSchema = z.object({
  bucket: z.string(),
  total: z.number(),
  monthlyAverage: z.number(),
  share: z.number(),
  transactionCount: z.number().int(),
});

export const incomeStreamFactSchema = z.object({
  streamKey: z.string(),
  displayName: z.string(),
  cadence: z.string(),
  monthlyAmount: z.number(),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const recurringOutflowFactSchema = z.object({
  streamKey: z.string(),
  displayName: z.string(),
  cadence: z.string(),
  cadenceDays: z.number(),
  averageAmount: z.number(),
  lastAmount: z.number(),
  monthlyAmount: z.number(),
  amountVariance: z.number(),
  // Planning fields (gameplan note §10.2–10.3): how the plan EXPECTS the
  // next posting. Null on a stream detected before they existed.
  amountClass: z.enum(['fixed', 'variable', 'erratic']).nullable(),
  planningAmount: z.number().nullable(),
  amountRange: z.object({ low: z.number(), high: z.number() }).nullable(),
  anchorDayOfMonth: z.number().int().nullable(),
  dateJitterDays: z.number().int().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  lastDate: z.string(),
});

/** A variable-class bill as the review shows it: a range, and what a plan sets aside. */
export const recurringOutflowExample = {
  streamKey: 'outflow:city power',
  displayName: 'City Power',
  cadence: 'monthly',
  cadenceDays: 30.4,
  averageAmount: 118,
  lastAmount: 132,
  monthlyAmount: 118.16,
  amountVariance: 0.21,
  amountClass: 'variable',
  planningAmount: 140,
  amountRange: { low: 90, high: 140 },
  anchorDayOfMonth: 12,
  dateJitterDays: 3,
  confidence: 'high',
  lastDate: '2026-08-12',
} as const;

export const financialFactsSchema = z.object({
  ruleVersion: z.string(),
  period: z.object({
    oldestObservedDate: z.string().nullable(),
    throughDate: z.string(),
    observedDays: z.number().int(),
    spendWindowDays: z.number().int(),
    spendWindowStart: z.string().nullable(),
    normalizationMonths: z.number(),
  }),
  currency: z.object({
    primary: z.string().nullable(),
    excludedTransactionCount: z.number().int(),
    excludedCurrencies: z.array(z.string()),
  }),
  income: z.object({
    monthlyIncomeEstimate: z.number(),
    estimateSource: z.enum(['recurring_streams', 'observed_average', 'none']),
    totalObservedIncome: z.number(),
    incomeStreams: z.array(incomeStreamFactSchema),
  }),
  spend: z.object({
    averageMonthlyEconomicSpend: z.number(),
    grossEconomicSpend: z.number(),
    refundsAndCredits: z.number(),
    netEconomicSpend: z.number(),
    categoryTotals: z.array(categoryTotalSchema),
  }),
  cashObligations: z.object({
    averageMonthlyCashObligations: z.number(),
    components: z.object({
      netEconomicSpendMonthly: z.number(),
      debtPaymentsMonthly: z.number(),
      externalCardPaymentsMonthly: z.number(),
      declaredObligationsMonthly: z.number(),
    }),
    declaredOneTime: z.object({ total: z.number(), count: z.number().int() }),
  }),
  balances: z.object({
    totalAssets: z.number(),
    totalLiabilities: z.number(),
    netPosition: z.number(),
    availableToSpend: z.number(),
    accountCount: z.number().int(),
  }),
  recurring: z.object({
    outflows: z.array(recurringOutflowFactSchema),
  }),
  movement: z.object({
    internalTransferTotal: z.number(),
    linkedCardPaymentTotal: z.number(),
    savingsTransferTotal: z.number(),
    externalCardPaymentTotal: z.number(),
  }),
  unknowns: z.object({
    unknownOutflowTotal: z.number(),
    unknownInflowTotal: z.number(),
    unknownShareOfOutflow: z.number(),
  }),
});

export const coverageReasonSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const coverageBandSchema = z.enum(['complete', 'partial', 'insufficient']);

export const reviewItemSchema = z.object({
  id: z.string(),
  itemKey: z.string(),
  type: z.string(),
  required: z.boolean(),
  status: z.enum(['open', 'resolved', 'accepted', 'dismissed']),
  evidence: z.unknown(),
  proposedValue: z.unknown().nullable(),
  confirmedValue: z.unknown().nullable(),
  allowedActions: z.array(z.string()),
});

export const reviewResponseSchema = z.object({
  reviewId: z.string(),
  analysisRunId: z.string(),
  snapshotVersion: z.number().int(),
  status: z.enum(['needs_confirmation', 'recomputing', 'confirmed']),
  period: z.object({
    requestedDays: z.number().int(),
    oldestObservedDate: z.string().nullable(),
    throughDate: z.string(),
  }),
  coverage: z.object({
    band: coverageBandSchema,
    reasons: z.array(coverageReasonSchema),
  }),
  coverageDetail: z.record(z.string(), z.unknown()),
  facts: z.object({
    monthlyIncomeEstimate: z.number(),
    averageMonthlyEconomicSpend: z.number(),
    averageMonthlyCashObligations: z.number(),
    declaredObligationsMonthly: z.number(),
    availableToSpend: z.number(),
  }),
  fullFacts: financialFactsSchema,
  recurringStreams: z.array(recurringOutflowFactSchema),
  incomeStreams: z.array(incomeStreamFactSchema),
  categoryTotals: z.array(categoryTotalSchema),
  reviewItems: z.array(reviewItemSchema),
});

export const correctionResultSchema = z.object({
  status: z.enum(['resolved', 'accepted']),
  recomputeQueued: z.boolean(),
});

export const recomputeResultSchema = z.object({
  status: z.enum(['queued', 'already_recomputing']),
});

export const confirmResultSchema = z.object({
  onboardingComplete: z.boolean(),
  alreadyConfirmed: z.boolean(),
});

export const retryResultSchema = z.object({
  status: z.enum(['retry_queued', 'already_running']),
  code: z.string().optional(),
});

export const pushTokenResponseSchema = z.object({
  token: z.object({
    id: z.string(),
    platform: z.string(),
    createdAt: z.string(),
  }),
});

export const disconnectResultSchema = z.object({
  recomputeQueued: z.boolean(),
});

export const webhookAckSchema = z.object({ received: z.boolean() });

export const vectorSearchMatchSchema = z.object({
  id: z.string(),
  contextDocumentId: z.string(),
  responseText: z.string(),
  chunkPosition: z.number().int().nonnegative(),
  createdAt: z.string(),
  distance: z.number(),
});

export const vectorSearchResultSchema = z.object({
  userId: z.string(),
  topN: z.number().int().positive(),
  queryText: z.string(),
  results: z.array(vectorSearchMatchSchema),
});

export const promptResultSchema = z.object({ prompt: z.string() });

// ---------------------------------------------------------------------------
// Examples (normative, from the design document)
// ---------------------------------------------------------------------------

export const statusExample = {
  phase: 'waiting_for_history',
  gates: {
    hasLinkedInstitution: true,
    linkingDeclaredComplete: true,
    manualProfileComplete: true,
    analysisReviewable: false,
    financialReviewConfirmed: false,
  },
  analysis: {
    runId: '5b910c92-1890-4dce-8912-0e496d4091a4',
    status: 'waiting_for_history',
    requestedLookbackDays: 180,
    institutions: { total: 2, ready: 1, limited: 0, failed: 0, pending: 1 },
    startedAt: '2026-08-24T20:00:00Z',
    reviewReadyAt: null,
    retryAllowed: false,
    errorCode: null,
  },
  availableActions: ['view_waiting', 'manage_connections', 'manage_notifications', 'logout'],
  onboardingComplete: false,
} as const;

export const reviewExample = {
  reviewId: '5fd0bb04-1826-4444-887d-95974853f623',
  analysisRunId: '5b910c92-1890-4dce-8912-0e496d4091a4',
  snapshotVersion: 3,
  status: 'needs_confirmation',
  period: {
    requestedDays: 180,
    oldestObservedDate: '2026-03-04',
    throughDate: '2026-08-24',
  },
  coverage: {
    band: 'partial',
    reasons: [
      {
        code: 'UNLINKED_CARD_PAYMENT',
        message: 'Payments to an unlinked card represent 18% of observed cash outflow.',
      },
    ],
  },
  coverageDetail: {},
  facts: {
    monthlyIncomeEstimate: 5200,
    averageMonthlyEconomicSpend: 3410,
    averageMonthlyCashObligations: 3890,
    declaredObligationsMonthly: 0,
    availableToSpend: 7400,
  },
  fullFacts: {
    ruleVersion: 'facts-v4',
    period: {
      oldestObservedDate: '2026-03-04',
      throughDate: '2026-08-24',
      observedDays: 174,
      spendWindowDays: 174,
      spendWindowStart: '2026-03-04',
      normalizationMonths: 5.72,
    },
    currency: {
      primary: 'USD',
      excludedTransactionCount: 0,
      excludedCurrencies: [],
    },
    income: {
      monthlyIncomeEstimate: 5200,
      estimateSource: 'recurring_streams',
      totalObservedIncome: 29700,
      incomeStreams: [],
    },
    spend: {
      averageMonthlyEconomicSpend: 3410,
      grossEconomicSpend: 19800,
      refundsAndCredits: 290,
      netEconomicSpend: 19510,
      categoryTotals: [],
    },
    cashObligations: {
      averageMonthlyCashObligations: 3890,
      components: {
        netEconomicSpendMonthly: 3410,
        debtPaymentsMonthly: 0,
        externalCardPaymentsMonthly: 480,
        declaredObligationsMonthly: 0,
      },
      declaredOneTime: { total: 0, count: 0 },
    },
    balances: {
      totalAssets: 12400,
      totalLiabilities: 2100,
      netPosition: 10300,
      availableToSpend: 7400,
      accountCount: 4,
    },
    recurring: { outflows: [recurringOutflowExample] },
    movement: {
      internalTransferTotal: 2500,
      linkedCardPaymentTotal: 4100,
      savingsTransferTotal: 1200,
      externalCardPaymentTotal: 2750,
    },
    unknowns: {
      unknownOutflowTotal: 420,
      unknownInflowTotal: 130,
      unknownShareOfOutflow: 0.02,
    },
  },
  recurringStreams: [recurringOutflowExample],
  incomeStreams: [],
  categoryTotals: [],
  reviewItems: [
    {
      id: '7df09f9d-80f6-4a36-af60-66c768d57917',
      itemKey: 'external_card_payment',
      type: 'external_card_payment_unattributed',
      required: true,
      status: 'open',
      evidence: {
        description: 'AUTOPAY CARD PAYMENT',
        averageMonthlyAmount: 820,
      },
      proposedValue: null,
      confirmedValue: null,
      allowedActions: ['connect_account', 'accept_coverage_limitation'],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type OperationAuth = 'user' | 'none' | 'plaid-signature';

export type Operation = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  operationId: string;
  summary: string;
  auth: OperationAuth;
  requestBody?: z.ZodType;
  responses: Record<
    string,
    { description: string; schema?: z.ZodType; example?: unknown }
  >;
};

const error = (description: string) => ({
  description,
  schema: errorEnvelopeSchema,
});

export const OPERATIONS: Operation[] = [
  // --- Auth (web cookies) ---
  {
    method: 'post',
    path: '/auth/register',
    operationId: 'registerWeb',
    summary: 'Create an account; sets HttpOnly session cookies',
    auth: 'none',
    requestBody: credentialsSchema,
    responses: {
      '201': { description: 'Account created', schema: webAuthResponseSchema },
      '409': error('Email already registered'),
    },
  },
  {
    method: 'post',
    path: '/auth/login',
    operationId: 'loginWeb',
    summary: 'Log in; sets HttpOnly session cookies',
    auth: 'none',
    requestBody: credentialsSchema,
    responses: {
      '200': { description: 'Logged in', schema: webAuthResponseSchema },
      '401': error('Invalid email or password'),
    },
  },
  {
    method: 'post',
    path: '/auth/refresh',
    operationId: 'refreshWeb',
    summary: 'Rotate the cookie session',
    auth: 'none',
    responses: {
      '200': { description: 'Session rotated', schema: webAuthResponseSchema },
      '401': error('Invalid refresh token'),
    },
  },
  {
    method: 'post',
    path: '/auth/logout',
    operationId: 'logoutWeb',
    summary: 'Revoke the cookie session',
    auth: 'none',
    responses: { '204': { description: 'Logged out' } },
  },
  // --- Auth (native Bearer) ---
  {
    method: 'post',
    path: '/auth/native/register',
    operationId: 'registerNative',
    summary: 'Create an account; returns Bearer + rotating refresh tokens',
    auth: 'none',
    requestBody: credentialsSchema,
    responses: {
      '201': { description: 'Account created', schema: nativeAuthResponseSchema },
      '409': error('Email already registered'),
    },
  },
  {
    method: 'post',
    path: '/auth/native/login',
    operationId: 'loginNative',
    summary: 'Log in; returns Bearer + rotating refresh tokens',
    auth: 'none',
    requestBody: credentialsSchema,
    responses: {
      '200': { description: 'Logged in', schema: nativeAuthResponseSchema },
      '401': error('Invalid email or password'),
    },
  },
  {
    method: 'post',
    path: '/auth/native/refresh',
    operationId: 'refreshNative',
    summary: 'Rotate a native refresh token (single use)',
    auth: 'none',
    requestBody: nativeRefreshSchema,
    responses: {
      '200': { description: 'Session rotated', schema: nativeAuthResponseSchema },
      '401': error('Invalid refresh token'),
    },
  },
  {
    method: 'post',
    path: '/auth/native/logout',
    operationId: 'logoutNative',
    summary: 'Revoke a native refresh session',
    auth: 'none',
    requestBody: nativeRefreshSchema,
    responses: { '204': { description: 'Logged out' } },
  },
  // --- Plaid ---
  {
    method: 'post',
    path: '/plaid/link-token',
    operationId: 'createLinkToken',
    summary: 'Start an initial, add-institution, or update Link session',
    auth: 'user',
    requestBody: linkTokenSchema,
    responses: {
      '200': { description: 'Link token created', schema: linkTokenResultSchema },
      '401': error('Unauthorized'),
      '502': error('Plaid error'),
    },
  },
  {
    method: 'post',
    path: '/plaid/exchange-public-token',
    operationId: 'exchangePublicToken',
    summary: 'Persist one linked Item (duplicates detected) and start its sync',
    auth: 'user',
    requestBody: exchangeSchema,
    responses: {
      '201': { description: 'Connection persisted', schema: exchangeResponseSchema },
      '401': error('Unauthorized'),
      '502': error('Plaid error'),
    },
  },
  {
    method: 'post',
    path: '/plaid/hosted-link/complete',
    operationId: 'completeHostedLink',
    summary: 'Poll a Hosted Link session until it finishes (web fallback)',
    auth: 'user',
    requestBody: hostedLinkSchema,
    responses: {
      '200': { description: 'Session state', schema: hostedLinkCompletionSchema },
      '401': error('Unauthorized'),
    },
  },
  {
    method: 'get',
    path: '/plaid/connections',
    operationId: 'listConnections',
    summary: 'All linked Items with accounts and sync health',
    auth: 'user',
    responses: {
      '200': { description: 'Connections', schema: connectionsResponseSchema },
      '401': error('Unauthorized'),
    },
  },
  {
    method: 'delete',
    path: '/plaid/connections/{itemId}',
    operationId: 'disconnectItem',
    summary: 'Disconnect one institution and rebuild dependent analysis',
    auth: 'user',
    responses: {
      '200': { description: 'Disconnected', schema: disconnectResultSchema },
      '404': error('Connection not found'),
    },
  },
  {
    method: 'post',
    path: '/plaid/webhook',
    operationId: 'plaidWebhook',
    summary: 'Plaid server-to-server webhook (signature verified)',
    auth: 'plaid-signature',
    responses: {
      '200': { description: 'Recorded', schema: webhookAckSchema },
      '401': error('Verification failed'),
    },
  },
  // --- Onboarding ---
  {
    method: 'put',
    path: '/onboarding/manual',
    operationId: 'saveManualOnboarding',
    summary: 'Save manual answers; completes the manual gate only',
    auth: 'user',
    requestBody: onboardingSchema,
    responses: {
      '200': { description: 'Saved' },
      '400': error('Validation failed'),
      '401': error('Unauthorized'),
    },
  },
  {
    method: 'get',
    path: '/onboarding/manual',
    operationId: 'getManualOnboarding',
    summary: 'Resume saved manual answers',
    auth: 'user',
    responses: {
      '200': { description: 'Saved answers or null', schema: savedOnboardingResponseSchema },
      '401': error('Unauthorized'),
    },
  },
  {
    method: 'get',
    path: '/onboarding/status',
    operationId: 'getOnboardingStatus',
    summary: 'Gates, phase, institution progress, and available actions',
    auth: 'user',
    responses: {
      '200': {
        description: 'Status',
        schema: onboardingStatusResponseSchema,
        example: statusExample,
      },
      '401': error('Unauthorized'),
    },
  },
  {
    method: 'post',
    path: '/onboarding/linking-complete',
    operationId: 'declareLinkingComplete',
    summary: 'Declare account linking done; creates/advances the analysis run',
    auth: 'user',
    responses: {
      '200': { description: 'Updated status', schema: onboardingStatusResponseSchema },
      '409': error('No linked institution'),
    },
  },
  {
    method: 'get',
    path: '/onboarding/financial-review',
    operationId: 'getFinancialReview',
    summary: 'Latest review snapshot: facts, coverage, actionable exceptions',
    auth: 'user',
    responses: {
      '200': {
        description: 'Review snapshot',
        schema: reviewResponseSchema,
        example: reviewExample,
      },
      '409': error('ANALYSIS_NOT_REVIEWABLE — route to waiting and poll'),
    },
  },
  {
    method: 'patch',
    path: '/onboarding/financial-review/items/{id}',
    operationId: 'correctReviewItem',
    summary: 'Correct or accept one review item (scoped, audited)',
    auth: 'user',
    requestBody: correctionSchema,
    responses: {
      '200': { description: 'Applied', schema: correctionResultSchema },
      '404': error('REVIEW_ITEM_NOT_FOUND'),
      '409': error('REVIEW_VERSION_STALE or RECOMPUTE_IN_PROGRESS'),
      '422': error('INVALID_CORRECTION_SCOPE'),
    },
  },
  {
    method: 'post',
    path: '/onboarding/financial-review/recompute',
    operationId: 'recomputeReview',
    summary: 'Rebuild facts and review after corrections',
    auth: 'user',
    responses: {
      '202': { description: 'Queued', schema: recomputeResultSchema },
      '409': error('ANALYSIS_NOT_REVIEWABLE'),
    },
  },
  {
    method: 'post',
    path: '/onboarding/financial-review/confirm',
    operationId: 'confirmReview',
    summary: 'Confirm the latest review; the only path to completion',
    auth: 'user',
    requestBody: confirmSchema,
    responses: {
      '200': { description: 'Confirmed', schema: confirmResultSchema },
      '409': error('REVIEW_VERSION_STALE or REVIEW_ITEMS_UNRESOLVED or ANALYSIS_NOT_REVIEWABLE'),
    },
  },
  {
    method: 'post',
    path: '/onboarding/retry',
    operationId: 'retryAnalysis',
    summary: 'Retry a failed analysis phase or failed institution syncs',
    auth: 'user',
    responses: {
      '202': { description: 'Queued or already running', schema: retryResultSchema },
      '409': error('RETRY_NOT_AVAILABLE'),
    },
  },
  // --- Notifications ---
  {
    method: 'post',
    path: '/notifications/push-tokens',
    operationId: 'registerPushToken',
    summary: 'Register or refresh one Expo push token',
    auth: 'user',
    requestBody: pushRegisterSchema,
    responses: {
      '201': { description: 'Registered', schema: pushTokenResponseSchema },
      '401': error('Unauthorized'),
    },
  },
  {
    method: 'delete',
    path: '/notifications/push-tokens/{tokenId}',
    operationId: 'revokePushToken',
    summary: 'Revoke one push token',
    auth: 'user',
    responses: {
      '204': { description: 'Revoked' },
      '404': error('PUSH_TOKEN_NOT_FOUND'),
    },
  },
  // --- Retrieval and prompts ---
  {
    method: 'post',
    path: '/query-vector-db',
    operationId: 'queryVectorDb',
    summary: "Nearest-neighbour search over the user's embedded text",
    auth: 'user',
    requestBody: queryVectorDbSchema,
    responses: {
      '200': { description: 'Top matches ranked by distance', schema: vectorSearchResultSchema },
      '400': error('Validation failed'),
      '401': error('Unauthorized'),
    },
  },
  {
    method: 'post',
    path: '/prompt-template/basic/',
    operationId: 'buildBasicPrompt',
    summary: 'Render a named prompt template with base intelligence and prompt text',
    auth: 'user',
    requestBody: buildPromptSchema,
    responses: {
      '200': { description: 'Enriched prompt', schema: promptResultSchema },
      '400': error('Validation failed'),
      '401': error('Unauthorized'),
      '404': error('Prompt template not found'),
    },
  },
];
