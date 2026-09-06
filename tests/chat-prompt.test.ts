import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { beforeEach, describe, expect, jest, it } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

const USER_ID = '123e4567-e89b-12d3-a456-426614174000';

jest.mock('../src/middleware/require-auth', () => ({
  requireAuth: jest.fn((req: Request, res: Response, next: NextFunction) => {
    if (req.cookies?.finbot_access === 'valid-access-token') {
      req.user = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        email: 'user@example.com',
      };
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }),
}));

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn(),
    end: jest.fn(),
  },
  pgVectorSize: 3,
}));

jest.mock('../src/rag/build-embeddings', () => ({
  ...jest.requireActual('../src/rag/build-embeddings'),
  buildEmbeddingVector: jest.fn(() => [0.5, 0.5, 0.5]),
}));

import chatPromptRouter from '../src/routes/chat-prompt.js';
import { pool } from '../src/db.js';
import { buildEmbeddingVector } from '../src/rag/build-embeddings.js';

const mockedPool = pool as any;
const mockedBuildEmbeddingVector = buildEmbeddingVector as unknown as jest.Mock;
const mockedFetch = jest.fn() as unknown as jest.Mock;

(global as unknown as { fetch: unknown }).fetch = mockedFetch;

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/chat-prompt', chatPromptRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  res.status(500).json({ error: message });
});

function mockSuccessPath(templateContents = 'You are <BASE_INTELLIGENCE>.\nContext:\n<RETRIEVED_CONTEXT>\nTask: <PROMPT_TEXT>') {
  mockedPool.query
    .mockResolvedValueOnce({
      rows: [{ response_text: 'ctx-1' }, { response_text: 'ctx-2' }],
    })
    .mockResolvedValueOnce({
      rows: [{ prompt_contents: templateContents }],
    })
    .mockResolvedValueOnce({
      rows: [{ contents: 'base-data' }],
    });

  mockedFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ response: 'This is the model answer.' }),
  });
}

beforeEach(() => {
  mockedPool.query.mockReset();
  mockedPool.end.mockReset();
  mockedBuildEmbeddingVector.mockClear();
  mockedFetch.mockReset();
});

describe('POST /chat-prompt', () => {
  it('rejects requests without a JWT before touching the database', async () => {
    const response = await request(app)
      .post('/chat-prompt')
      .send({ userId: USER_ID, n: 3, userPromptText: 'How should I budget?' });

    expect(response.status).toBe(401);
    expect(mockedPool.query).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects a userId that does not match the authenticated user', async () => {
    const response = await request(app)
      .post('/chat-prompt')
      .set('Cookie', 'finbot_access=valid-access-token')
      .send({
        userId: '00000000-0000-4000-8000-000000000001',
        n: 3,
        userPromptText: 'How should I budget?',
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Forbidden' });
    expect(mockedPool.query).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('retrieves top-n context, renders the template, and returns the model response', async () => {
    mockSuccessPath();

    const response = await request(app)
      .post('/chat-prompt')
      .set('Cookie', 'finbot_access=valid-access-token')
      .send({
        userId: USER_ID,
        n: 2,
        userPromptText: 'How should I budget?',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ response: 'This is the model answer.' });

    expect(mockedBuildEmbeddingVector).toHaveBeenCalledWith(
      'How should I budget?',
      expect.objectContaining({ vectorDimension: 3 }),
    );

    expect(mockedPool.query).toHaveBeenCalledTimes(3);
    expect(mockedPool.query.mock.calls[0][1][0]).toBe(USER_ID);
    expect(mockedPool.query.mock.calls[0][1][2]).toBe(2);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [fetchUrl, fetchInit] = mockedFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(fetchUrl).toContain('/api/generate');

    const sentBody = JSON.parse(fetchInit.body as string) as {
      model: string;
      stream: boolean;
      prompt: string;
    };
    expect(sentBody.model).toBe('tinyllama');
    expect(sentBody.stream).toBe(false);
    expect(sentBody.prompt).toContain('ctx-1');
    expect(sentBody.prompt).toContain('ctx-2');
    expect(sentBody.prompt).toContain('base-data');
    expect(sentBody.prompt).toContain('How should I budget?');
    expect(sentBody.prompt).not.toContain('<RETRIEVED_CONTEXT>');
    expect(sentBody.prompt).not.toContain('<BASE_INTELLIGENCE>');
    expect(sentBody.prompt).not.toContain('<PROMPT_TEXT>');
  });

  it('uses the provided template name when resolving the prompt template', async () => {
    mockSuccessPath();

    const response = await request(app)
      .post('/chat-prompt')
      .set('Cookie', 'finbot_access=valid-access-token')
      .send({
        userId: USER_ID,
        n: 2,
        userPromptText: 'How should I budget?',
        promptTemplateName: 'Custom Template',
      });

    expect(response.status).toBe(200);
    expect(mockedPool.query.mock.calls[1][1]).toEqual(['Custom Template']);
  });

  it('returns 404 and skips the model when the prompt template is missing', async () => {
    mockedPool.query
      .mockResolvedValueOnce({ rows: [{ response_text: 'ctx-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const response = await request(app)
      .post('/chat-prompt')
      .set('Cookie', 'finbot_access=valid-access-token')
      .send({
        userId: USER_ID,
        n: 2,
        userPromptText: 'How should I budget?',
      });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Prompt template not found' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns 502 when the model request is not ok', async () => {
    mockedPool.query
      .mockResolvedValueOnce({ rows: [{ response_text: 'ctx-1' }] })
      .mockResolvedValueOnce({
        rows: [{ prompt_contents: 'Task: <PROMPT_TEXT>' }],
      })
      .mockResolvedValueOnce({ rows: [{ contents: 'base-data' }] });

    mockedFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const response = await request(app)
      .post('/chat-prompt')
      .set('Cookie', 'finbot_access=valid-access-token')
      .send({
        userId: USER_ID,
        n: 2,
        userPromptText: 'How should I budget?',
      });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: 'Model request failed with status 500',
    });
  });

  it('returns 502 when the model request throws', async () => {
    mockedPool.query
      .mockResolvedValueOnce({ rows: [{ response_text: 'ctx-1' }] })
      .mockResolvedValueOnce({
        rows: [{ prompt_contents: 'Task: <PROMPT_TEXT>' }],
      })
      .mockResolvedValueOnce({ rows: [{ contents: 'base-data' }] });

    mockedFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const response = await request(app)
      .post('/chat-prompt')
      .set('Cookie', 'finbot_access=valid-access-token')
      .send({
        userId: USER_ID,
        n: 2,
        userPromptText: 'How should I budget?',
      });

    expect(response.status).toBe(502);
    expect(response.body.error).toBe('Model request failed');
  });

  it('rejects invalid input before touching the database or the model', async () => {
    const response = await request(app)
      .post('/chat-prompt')
      .set('Cookie', 'finbot_access=valid-access-token')
      .send({
        userId: 'not-a-uuid',
        n: 0,
        userPromptText: ' ',
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(mockedPool.query).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});