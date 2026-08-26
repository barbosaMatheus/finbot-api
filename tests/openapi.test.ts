import { readFileSync } from 'node:fs';

import { describe, expect, jest, test } from '@jest/globals';
import request from 'supertest';

import app from '../src/app.js';
import {
  OPERATIONS,
  onboardingStatusResponseSchema,
  reviewExample,
  reviewResponseSchema,
  statusExample,
} from '../src/openapi/contract.js';
import {
  OPENAPI_FILE,
  buildOpenApiDocument,
  renderOpenApiJson,
} from '../src/openapi/generate.js';

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

describe('OpenAPI generation (API-003)', () => {
  test('generation is deterministic', () => {
    expect(renderOpenApiJson()).toBe(renderOpenApiJson());
  });

  test('the checked-in document matches the schemas (drift check)', () => {
    // Regenerate with `npm run openapi:generate` when this fails.
    const checkedIn = readFileSync(OPENAPI_FILE, 'utf8');
    expect(JSON.parse(checkedIn)).toEqual(buildOpenApiDocument());
  });

  test('every documented operation exists in the running app', async () => {
    for (const operation of OPERATIONS) {
      const url = operation.path
        .replace('{id}', '00000000-0000-0000-0000-000000000000')
        .replace('{itemId}', '00000000-0000-0000-0000-000000000000')
        .replace('{tokenId}', '00000000-0000-0000-0000-000000000000');

      const response = await request(app)[operation.method](url).send({});

      // Unauthenticated requests may 400/401/409/…, but a 404 would mean
      // the documented route does not exist.
      expect(`${operation.method} ${url} -> ${response.status}`).not.toContain('404');
    }
  });

  test('auth-required operations declare both transports', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { security?: unknown }>>;
    };

    const status = doc.paths['/onboarding/status']?.get;
    expect(status?.security).toEqual([{ cookieAuth: [] }, { bearerAuth: [] }]);
  });

  test('security schemes cover cookies and Bearer', () => {
    const doc = buildOpenApiDocument() as {
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'bearerAuth',
      'cookieAuth',
    ]);
  });

  test('the design examples validate against their response schemas', () => {
    expect(onboardingStatusResponseSchema.safeParse(statusExample).success).toBe(true);
    expect(reviewResponseSchema.safeParse(reviewExample).success).toBe(true);
  });

  test('GET /openapi.json serves the checked-in contract', async () => {
    const response = await request(app).get('/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body).toEqual(JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')));
  });
});
