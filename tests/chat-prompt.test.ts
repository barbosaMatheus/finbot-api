import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, jest, it } from '@jest/globals';
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
import { CHAT_RULES } from '../src/llm/prompts.js';
import { CHAT_NUMBER_WITHHELD_REPLY } from '../src/llm/templates.js';
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

/** What Ollama's /api/chat answers with. */
function ollamaReply(content: string) {
    return {
        ok: true,
        json: async () => ({ model: 'llama3.1', message: { content } }),
    };
}

function mockRetrieval(templateContents = 'You are <BASE_INTELLIGENCE>.\nContext:\n<RETRIEVED_CONTEXT>\nTask: <PROMPT_TEXT>') {
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
}

function mockSuccessPath(templateContents?: string) {
    mockRetrieval(templateContents);
    mockedFetch.mockResolvedValueOnce(ollamaReply('This is the model answer.'));
}

const MODEL_ENV = ['LLM_PROVIDER', 'OLLAMA_URL', 'OLLAMA_MODEL', 'LLM_TIMEOUT_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    mockedPool.query.mockReset();
    mockedPool.end.mockReset();
    mockedBuildEmbeddingVector.mockClear();
    mockedFetch.mockReset();

    // Chat goes through the LLM seam: LLM_PROVIDER selects the host.
    for (const key of MODEL_ENV) savedEnv[key] = process.env[key];
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.OLLAMA_MODEL = 'llama3.1';
    delete process.env.LLM_TIMEOUT_MS;
});

afterEach(() => {
    for (const key of MODEL_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
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

        // Through the seam: the Ollama adapter's /api/chat, free text, chat rules as the system message.
        expect(mockedFetch).toHaveBeenCalledTimes(1);
        const [fetchUrl, fetchInit] = mockedFetch.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(fetchUrl).toBe('http://ollama:11434/api/chat');

        const sentBody = JSON.parse(fetchInit.body as string) as {
            model: string;
            stream: boolean;
            format?: unknown;
            messages: { role: string; content: string }[];
        };
        expect(sentBody.model).toBe('llama3.1');
        expect(sentBody.stream).toBe(false);
        expect(sentBody.format).toBeUndefined();
        expect(sentBody.messages[0]).toEqual({ role: 'system', content: CHAT_RULES });

        const prompt = sentBody.messages[1]!.content;
        expect(sentBody.messages[1]!.role).toBe('user');
        expect(prompt).toContain('ctx-1');
        expect(prompt).toContain('ctx-2');
        expect(prompt).toContain('base-data');
        expect(prompt).toContain('How should I budget?');
        expect(prompt).not.toContain('<RETRIEVED_CONTEXT>');
        expect(prompt).not.toContain('<BASE_INTELLIGENCE>');
        expect(prompt).not.toContain('<PROMPT_TEXT>');
    });

    it('returns a reply whose numbers all come from the retrieved context', async () => {
        mockedPool.query
            .mockResolvedValueOnce({ rows: [{ response_text: 'Rent is $1,200 a month.' }] })
            .mockResolvedValueOnce({ rows: [{ prompt_contents: 'Context: <RETRIEVED_CONTEXT>\nTask: <PROMPT_TEXT>' }] })
            .mockResolvedValueOnce({ rows: [{ contents: 'base-data' }] });
        mockedFetch.mockResolvedValueOnce(ollamaReply('Your rent is $1,200 a month.'));

        const response = await request(app)
            .post('/chat-prompt')
            .set('Cookie', 'finbot_access=valid-access-token')
            .send({ userId: USER_ID, n: 1, userPromptText: 'What is my rent?' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ response: 'Your rent is $1,200 a month.' });
    });

    it('withholds a reply that states a number it was not given', async () => {
        mockedPool.query
            .mockResolvedValueOnce({ rows: [{ response_text: 'Rent is $1,200 a month.' }] })
            .mockResolvedValueOnce({ rows: [{ prompt_contents: 'Context: <RETRIEVED_CONTEXT>\nTask: <PROMPT_TEXT>' }] })
            .mockResolvedValueOnce({ rows: [{ contents: 'base-data' }] });
        mockedFetch.mockResolvedValueOnce(ollamaReply('You can safely spend $450 on eating out.'));

        const response = await request(app)
            .post('/chat-prompt')
            .set('Cookie', 'finbot_access=valid-access-token')
            .send({ userId: USER_ID, n: 1, userPromptText: 'How much can I spend eating out?' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ response: CHAT_NUMBER_WITHHELD_REPLY });
    });

    it('answers 503 without calling a model when LLM_PROVIDER selects no model', async () => {
        process.env.LLM_PROVIDER = 'template';
        mockRetrieval();

        const response = await request(app)
            .post('/chat-prompt')
            .set('Cookie', 'finbot_access=valid-access-token')
            .send({ userId: USER_ID, n: 2, userPromptText: 'How should I budget?' });

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            error: 'No model configured: set LLM_PROVIDER to ollama or anthropic',
        });
        expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('returns 502 with a timeout message when the model host times out', async () => {
        mockRetrieval();
        mockedFetch.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

        const response = await request(app)
            .post('/chat-prompt')
            .set('Cookie', 'finbot_access=valid-access-token')
            .send({ userId: USER_ID, n: 2, userPromptText: 'How should I budget?' });

        expect(response.status).toBe(502);
        expect(response.body).toEqual({ error: 'Model request timed out' });
    });

    it('returns 502 when the model answers with nothing', async () => {
        mockRetrieval();
        mockedFetch.mockResolvedValueOnce(ollamaReply('   '));

        const response = await request(app)
            .post('/chat-prompt')
            .set('Cookie', 'finbot_access=valid-access-token')
            .send({ userId: USER_ID, n: 2, userPromptText: 'How should I budget?' });

        expect(response.status).toBe(502);
        expect(response.body).toEqual({ error: 'Model returned an empty response' });
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
        expect(response.body).toEqual({ error: 'Model request failed' });
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
