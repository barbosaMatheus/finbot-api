/**
 * Deterministic OpenAPI 3.1 generation (API-003).
 *
 * Builds the document object from the operation registry and the live Zod
 * schemas. `npm run openapi:generate` writes the checked-in
 * openapi/openapi.json; the contract test regenerates in memory and fails
 * on any difference, so a stale document cannot ship.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { OPERATIONS, errorEnvelopeSchema, type Operation } from './contract.js';

const OPENAPI_VERSION = '3.1.0';

/** Convert one Zod schema to JSON Schema, minus the $schema banner. */
function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Record<string, unknown>;

  delete json.$schema;
  return json;
}

function pathParameters(operationPath: string): Array<Record<string, unknown>> {
  const params = [...operationPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);

  return params.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function security(auth: Operation['auth']): Array<Record<string, unknown>> | undefined {
  switch (auth) {
    case 'user':
      return [{ cookieAuth: [] }, { bearerAuth: [] }];
    case 'plaid-signature':
      return [];
    case 'none':
      return [];
  }
}

function buildOperation(operation: Operation): Record<string, unknown> {
  const responses: Record<string, unknown> = {};

  for (const [status, response] of Object.entries(operation.responses)) {
    const entry: Record<string, unknown> = { description: response.description };

    if (response.schema) {
      const media: Record<string, unknown> = {
        schema: toJsonSchema(response.schema, 'output'),
      };

      if (response.example !== undefined) {
        media.example = response.example;
      }

      entry.content = { 'application/json': media };
    }

    responses[status] = entry;
  }

  const doc: Record<string, unknown> = {
    operationId: operation.operationId,
    summary: operation.summary,
    responses,
  };

  const parameters = pathParameters(operation.path);

  if (parameters.length > 0) {
    doc.parameters = parameters;
  }

  if (operation.requestBody) {
    doc.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: toJsonSchema(operation.requestBody, 'input'),
        },
      },
    };
  }

  const sec = security(operation.auth);

  if (operation.auth === 'user') {
    doc.security = sec;
  }

  if (operation.auth === 'plaid-signature') {
    doc['x-authentication'] = 'Plaid webhook signature (Plaid-Verification header)';
  }

  return doc;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of OPERATIONS) {
    const pathEntry = paths[operation.path] ?? {};
    pathEntry[operation.method] = buildOperation(operation);
    paths[operation.path] = pathEntry;
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'FinBot API',
      description:
        'Financial onboarding and transaction analysis. Generated from the ' +
        'route Zod schemas; regenerate with `npm run openapi:generate`.',
      version: '1.0.0',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
    paths,
    components: {
      schemas: {
        ErrorEnvelope: toJsonSchema(errorEnvelopeSchema, 'output'),
      },
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'finbot_access',
          description: 'HttpOnly access cookie set by the web auth flow.',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Short-lived access token from the native auth flow.',
        },
      },
    },
  };
}

export function renderOpenApiJson(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}

// Resolved from the package root (scripts, jest, and the container all run
// with the package as cwd), avoiding import.meta so the CJS test transform
// can load this module.
export const OPENAPI_FILE = path.resolve(process.cwd(), 'openapi', 'openapi.json');

// CLI entry: `tsx src/openapi/generate.ts --write`
if (process.argv.includes('--write')) {
  mkdirSync(path.dirname(OPENAPI_FILE), { recursive: true });
  writeFileSync(OPENAPI_FILE, renderOpenApiJson(), 'utf8');
  console.log(`[openapi] wrote ${OPENAPI_FILE}`);
}
