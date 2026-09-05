import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const mockAuthService = {
  registerUser: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  loginUser: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  refreshSession: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  logoutSession: jest.fn<(...args: unknown[]) => Promise<void>>(),
};

jest.mock('../src/services/auth.service', () => mockAuthService);

import request from 'supertest';

import app from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import { requireAuth } from '../src/middleware/require-auth.js';
import type { NextFunction, Request, Response } from 'express';

const authResult = {
  user: { id: 'user-1', email: 'a@b.co', onboardingComplete: false },
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  refreshMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = 'test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
});

describe('native auth routes (API-018)', () => {
  test('native login returns tokens in the body and sets no cookies', async () => {
    mockAuthService.loginUser.mockResolvedValue(authResult);

    const response = await request(app)
      .post('/auth/native/login')
      .send({ email: 'a@b.co', password: 'password1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: authResult.user,
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      refreshExpiresInSeconds: 604800,
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('native register mirrors the login shape', async () => {
    mockAuthService.registerUser.mockResolvedValue(authResult);

    const response = await request(app)
      .post('/auth/native/register')
      .send({ email: 'a@b.co', password: 'password1' });

    expect(response.status).toBe(201);
    expect(response.body.accessToken).toBe('access-token-value');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  test('native refresh rotates via the shared session service', async () => {
    mockAuthService.refreshSession.mockResolvedValue({
      ...authResult,
      accessToken: 'rotated-access',
      refreshToken: 'rotated-refresh',
    });

    const response = await request(app)
      .post('/auth/native/refresh')
      .send({ refreshToken: 'refresh-token-value' });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBe('rotated-access');
    expect(response.body.refreshToken).toBe('rotated-refresh');
    expect(mockAuthService.refreshSession).toHaveBeenCalledWith('refresh-token-value');
  });

  test('native logout revokes the session', async () => {
    mockAuthService.logoutSession.mockResolvedValue(undefined);

    const response = await request(app)
      .post('/auth/native/logout')
      .send({ refreshToken: 'refresh-token-value' });

    expect(response.status).toBe(204);
    expect(mockAuthService.logoutSession).toHaveBeenCalledWith('refresh-token-value');
  });

  test('web cookie flow is unchanged: login still sets HttpOnly cookies', async () => {
    mockAuthService.loginUser.mockResolvedValue(authResult);

    const response = await request(app)
      .post('/auth/login')
      .send({ email: 'a@b.co', password: 'password1' });

    expect(response.status).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((cookie) => cookie.includes('HttpOnly'))).toBe(true);
    // The body of the web flow never carries tokens.
    expect(response.body.accessToken).toBeUndefined();
  });
});

describe('requireAuth dual transport (API-018)', () => {
  function run(headers: Record<string, string>, cookies: Record<string, string> = {}) {
    const req = {
      headers,
      cookies,
    } as unknown as Request;

    let statusCode = 0;
    let jsonBody: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        jsonBody = body;
        return this;
      },
    } as unknown as Response;

    let nexted = false;
    const next: NextFunction = () => {
      nexted = true;
    };

    return requireAuth(req, res, next).then(() => ({
      statusCode,
      jsonBody,
      nexted,
      req,
    }));
  }

  test('a valid Bearer token authenticates', async () => {
    const token = await signAccessToken({ sub: 'user-1', email: 'a@b.co' });

    const result = await run({ authorization: `Bearer ${token}` });

    expect(result.nexted).toBe(true);
    expect(result.req.user).toEqual({ id: 'user-1', email: 'a@b.co' });
    expect(result.req.authTransport).toBe('bearer');
  });

  test('a valid cookie authenticates through the same path', async () => {
    const token = await signAccessToken({ sub: 'user-1', email: 'a@b.co' });

    const result = await run({}, { finbot_access: token });

    expect(result.nexted).toBe(true);
    expect(result.req.authTransport).toBe('cookie');
  });

  test('an invalid Bearer token is rejected even with a valid cookie', async () => {
    const good = await signAccessToken({ sub: 'user-1', email: 'a@b.co' });

    const result = await run(
      { authorization: 'Bearer tampered-token' },
      { finbot_access: good },
    );

    expect(result.nexted).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  test('no credentials at all is 401', async () => {
    const result = await run({});

    expect(result.statusCode).toBe(401);
  });
});
