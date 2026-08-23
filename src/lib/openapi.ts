import { z } from 'zod';
import { createDocument, type ZodOpenApiObject } from 'zod-openapi';

import { ACCESS_COOKIE_NAME } from './cookies.js';
import { credentialsSchema } from '../routes/auth.js';
import { onboardingSchema } from '../routes/onboarding.js';
import { embedTextSchema } from '../routes/embbed-text.js';
import { queryVectorDbSchema } from '../routes/query-vector-db.js';
import { buildPromptSchema } from '../routes/prompt-template.js';
import { exchangeSchema, hostedLinkSchema } from '../routes/plaid.js';

const isoDateTime = z.iso.datetime();

const errorSchema = z
  .object({
    error: z.string(),
    details: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe('Per-field validation errors'),
  })
  .meta({ id: 'Error', description: 'Standard JSON error envelope' });

const authUserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
  })
  .meta({ id: 'AuthUser' });

const authSuccessSchema = z
  .object({
    user: authUserSchema,
  })
  .meta({
    id: 'AuthSuccess',
    description: 'Sets httpOnly finbot_access and finbot_refresh cookies',
  });

const persistedEmbeddingSchema = z
  .object({
    id: z.uuid(),
    embedding: z.array(z.number()),
    chunkPosition: z.number().int().nonnegative(),
  })
  .meta({ id: 'PersistedEmbedding' });

const embeddingResultSchema = z
  .object({
    documentId: z.uuid(),
    userId: z.uuid(),
    context: z.string(),
    source: z.string(),
    createdAt: isoDateTime,
    embeddings: z.array(persistedEmbeddingSchema),
  })
  .meta({ id: 'EmbeddingResult' });

const userInfoSchema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    fullName: z.string(),
    dateOfBirth: isoDateTime.nullable(),
    maritalStatus: z.string(),
    dependentsCount: z.number().int().nonnegative(),
    employmentStatus: z.string(),
    monthlyTakeHomeIncome: z.number(),
    monthlyHousingCosts: z.number(),
    monthlyFoodGroceryCosts: z.number(),
    monthlyTransportationCosts: z.number(),
    savingsEmergencyFunds: z.number(),
    totalDebt: z.number(),
    debtInterestFactor: z.boolean(),
    monthlyEntertainmentSubscriptionsCosts: z.number(),
    entertainmentSubscriptions: z.array(z.string()),
    financialGoals: z.array(z.string()),
    additionalMoneyPools: z.array(z.string()),
    investmentRiskComfort: z.string(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .meta({ id: 'UserInfo' });

const onboardingResultSchema = z
  .object({
    userInfo: userInfoSchema,
    additionalContextEmbedding: embeddingResultSchema.nullable(),
  })
  .meta({ id: 'OnboardingResult' });

const baseIntelligenceSchema = z
  .object({
    contents: z.string(),
  })
  .meta({ id: 'BaseIntelligence' });

const vectorSearchMatchSchema = z
  .object({
    id: z.uuid(),
    contextDocumentId: z.uuid(),
    responseText: z.string(),
    chunkPosition: z.number().int().nonnegative(),
    createdAt: isoDateTime,
    distance: z.number(),
  })
  .meta({ id: 'VectorSearchMatch' });

const vectorSearchResultSchema = z
  .object({
    userId: z.uuid(),
    topN: z.number().int().positive(),
    queryText: z.string(),
    results: z.array(vectorSearchMatchSchema),
  })
  .meta({ id: 'VectorSearchResult' });

const plaidAccountSummarySchema = z
  .object({
    accountId: z.string(),
    name: z.string(),
    officialName: z.string().nullable(),
    mask: z.string().nullable(),
    type: z.string(),
    subtype: z.string().nullable(),
    currentBalance: z.number().nullable(),
    availableBalance: z.number().nullable(),
    isoCurrencyCode: z.string().nullable(),
  })
  .meta({ id: 'PlaidAccountSummary' });

const plaidConnectionSchema = z
  .object({
    id: z.uuid(),
    itemId: z.string(),
    institutionId: z.string().nullable(),
    institutionName: z.string().nullable(),
    status: z.string(),
    createdAt: isoDateTime,
    accounts: z.array(plaidAccountSummarySchema),
  })
  .meta({ id: 'PlaidConnection' });

const linkTokenResultSchema = z
  .object({
    linkToken: z.string(),
    expiration: isoDateTime.nullable(),
    hostedLinkUrl: z.url().nullable(),
  })
  .meta({
    id: 'LinkTokenResult',
    description: 'Short-lived Plaid link_token plus hosted Link URL for web',
  });

const hostedLinkCompletionSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('pending').describe('Keep polling; session unfinished'),
    }),
    z.object({
      status: z.literal('connected'),
      connection: plaidConnectionSchema,
    }),
  ])
  .meta({ id: 'HostedLinkCompletion' });

const promptResultSchema = z
  .object({
    prompt: z.string(),
  })
  .meta({ id: 'PromptResult' });

function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return {
    description,
    content: {
      'application/json': { schema },
    },
  };
}

function errorResponse(description: string) {
  return jsonResponse(errorSchema, description);
}

const unauthorized = () => errorResponse('Missing or invalid access cookie');

const openApiObject: ZodOpenApiObject = {
  openapi: '3.1.0',
  info: {
    title: 'FinBot API',
    version: '1.0.0',
    description:
      'Express API backing FinBot: authentication, onboarding, Plaid bank linking, embeddings, and RAG utilities.',
  },
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Onboarding' },
    { name: 'Plaid' },
    { name: 'Intelligence' },
    { name: 'Embeddings' },
    { name: 'Vector Search' },
    { name: 'Prompt Templates' },
  ],
  components: {
    securitySchemes: {
      authCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: ACCESS_COOKIE_NAME,
        description:
          'httpOnly JWT access cookie issued by POST /auth/register, /auth/login, or /auth/refresh. Log in through the docs UI first; the browser stores the cookie automatically.',
      },
    },
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Service liveness and database connectivity',
        responses: {
          '200': jsonResponse(
            z.object({
              status: z.literal('ok'),
              service: z.literal('finbot-api'),
              db: z.enum(['up', 'down']),
              timestamp: isoDateTime,
            }),
            'Current service status',
          ),
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account',
        description: 'Returns 409 if the email is already registered.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: credentialsSchema } },
        },
        responses: {
          '201': jsonResponse(authSuccessSchema, 'Account created and logged in'),
          '400': errorResponse('Validation failed'),
          '409': errorResponse('Email already registered'),
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: credentialsSchema } },
        },
        responses: {
          '200': jsonResponse(authSuccessSchema, 'Logged in'),
          '400': errorResponse('Validation failed'),
          '401': errorResponse('Invalid email or password'),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate tokens using the refresh cookie',
        responses: {
          '200': jsonResponse(authSuccessSchema, 'New token pair issued'),
          '401': errorResponse('Invalid refresh token'),
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Log out',
        description: 'Revokes the refresh token and clears auth cookies.',
        responses: {
          '204': { description: 'Logged out, cookies cleared' },
        },
      },
    },
    '/onboarding': {
      put: {
        tags: ['Onboarding'],
        summary: 'Upsert onboarding profile for the authenticated user',
        security: [{ authCookie: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: onboardingSchema } },
        },
        responses: {
          '200': jsonResponse(onboardingResultSchema, 'Saved onboarding profile'),
          '400': errorResponse('Validation failed'),
          '401': unauthorized(),
          '404': errorResponse('User not found'),
        },
      },
    },
    '/plaid/link-token': {
      post: {
        tags: ['Plaid'],
        summary: 'Start a Plaid Link session',
        security: [{ authCookie: [] }],
        responses: {
          '200': jsonResponse(linkTokenResultSchema, 'Link token created'),
          '401': unauthorized(),
          '502': errorResponse('Plaid request failed'),
        },
      },
    },
    '/plaid/exchange-public-token': {
      post: {
        tags: ['Plaid'],
        summary: 'Exchange a Link public_token for a stored connection',
        security: [{ authCookie: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: exchangeSchema } },
        },
        responses: {
          '201': jsonResponse(
            z.object({ connection: plaidConnectionSchema }).meta({ id: 'PlaidConnectionEnvelope' }),
            'Connection stored',
          ),
          '401': unauthorized(),
          '502': errorResponse('Plaid request failed'),
        },
      },
    },
    '/plaid/hosted-link/complete': {
      post: {
        tags: ['Plaid'],
        summary: 'Poll a Hosted Link session',
        description:
          'Web fallback: returns pending until the browser session finishes, then connected with the stored connection.',
        security: [{ authCookie: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: hostedLinkSchema } },
        },
        responses: {
          '200': jsonResponse(hostedLinkCompletionSchema, 'Session status'),
          '401': unauthorized(),
          '502': errorResponse('Plaid request failed'),
        },
      },
    },
    '/plaid/connections': {
      get: {
        tags: ['Plaid'],
        summary: 'List linked bank connections',
        security: [{ authCookie: [] }],
        responses: {
          '200': jsonResponse(
            z
              .object({ connections: z.array(plaidConnectionSchema) })
              .meta({ id: 'PlaidConnectionsEnvelope' }),
            'Linked connections',
          ),
          '401': unauthorized(),
        },
      },
    },
    '/base-intelligence': {
      get: {
        tags: ['Intelligence'],
        summary: 'Latest base intelligence document',
        responses: {
          '200': jsonResponse(baseIntelligenceSchema, 'Latest base intelligence'),
          '404': errorResponse('No base intelligence found'),
          '500': errorResponse('Failed to fetch base intelligence'),
        },
      },
    },
    '/embeddings': {
      post: {
        tags: ['Embeddings'],
        summary: 'Chunk text and persist embeddings for a user',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: embedTextSchema } },
        },
        responses: {
          '201': jsonResponse(embeddingResultSchema, 'Embeddings stored'),
          '400': errorResponse('Validation failed'),
          '404': errorResponse('User not found'),
        },
      },
    },
    '/query-vector-db': {
      post: {
        tags: ['Vector Search'],
        summary: 'Nearest-neighbour search over the user’s embedded text',
        security: [{ authCookie: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: queryVectorDbSchema } },
        },
        responses: {
          '200': jsonResponse(vectorSearchResultSchema, 'Top matches ranked by distance'),
          '400': errorResponse('Validation failed'),
          '401': unauthorized(),
        },
      },
    },
    '/prompt-template/basic/': {
      post: {
        tags: ['Prompt Templates'],
        summary: 'Render a named template with base intelligence and prompt text',
        security: [{ authCookie: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: buildPromptSchema } },
        },
        responses: {
          '200': jsonResponse(promptResultSchema, 'Enriched prompt'),
          '400': errorResponse('Validation failed'),
          '401': unauthorized(),
          '404': errorResponse('Prompt template not found'),
        },
      },
    },
  },
};

export const openApiDocument = createDocument(openApiObject);
