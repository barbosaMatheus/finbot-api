import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

jest.mock('../src/middleware/require-auth', () => ({
    requireAuth: (req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: 'user-1', email: 'user@test.com' };
        next();
    },
}));

jest.mock('../src/db', () => ({
    pool: {
        connect: jest.fn(),
    },
}));

import { pool } from '../src/db.js';
import promptTemplateRouter from '../src/routes/prompt-template.js';

type MockFn = ReturnType<typeof jest.fn>;

type FakeClient = {
    query: MockFn;
    release: MockFn;
};

const mockedPool = pool as unknown as { connect: MockFn };

const app = express();
app.use(express.json());
app.use('/prompt-template', promptTemplateRouter);
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
});

const validBody = {
    user_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    prompt_template_name: 'monthly-summary',
    prompt_text: 'How much did I spend?',
};

function createFakeClient(
    options: {
        templateRows?: { prompt_contents: string }[];
        baseRows?: { contents: string }[];
        failingSqlFragment?: string;
    } = {},
): FakeClient {
    const client = {
        query: jest.fn(async (sql: string) => {
            if (
                options.failingSqlFragment !== undefined &&
                sql.includes(options.failingSqlFragment)
            ) {
                throw new Error('database exploded');
            }
            if (sql.includes('FROM prompt_templates')) {
                return { rows: options.templateRows ?? [] };
            }
            if (sql.includes('FROM base_intelligence')) {
                return { rows: options.baseRows ?? [] };
            }
            return { rows: [] };
        }),
        release: jest.fn(),
    };

    mockedPool.connect.mockResolvedValueOnce(client as unknown as never);
    return client as unknown as FakeClient;
}

beforeEach(() => {
    mockedPool.connect.mockReset();
});

describe('POST /prompt-template/basic', () => {
    test('builds the prompt from the newest template and base intelligence', async () => {
        const client = createFakeClient({
            templateRows: [
                { prompt_contents: 'You are <BASE_INTELLIGENCE>. Task: <PROMPT_TEXT>' },
            ],
            baseRows: [{ contents: 'a helpful financial assistant' }],
        });

        const response = await request(app)
            .post('/prompt-template/basic')
            .send(validBody);

        expect(client.query).toHaveBeenCalledWith(
            expect.stringContaining('FROM prompt_templates'),
            ['monthly-summary'],
        );
        expect(client.query).toHaveBeenCalledWith('BEGIN');
        expect(client.query).toHaveBeenCalledWith('COMMIT');
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            prompt: 'You are a helpful financial assistant. Task: How much did I spend?',
        });
    });

    test('falls back to empty base intelligence when no rows exist', async () => {
        const client = createFakeClient({
            templateRows: [{ prompt_contents: 'Base:[<BASE_INTELLIGENCE>] Task:<PROMPT_TEXT>' }],
            baseRows: [],
        });

        const response = await request(app)
            .post('/prompt-template/basic')
            .send(validBody);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            prompt: 'Base:[] Task:How much did I spend?',
        });
        expect(client.query).toHaveBeenCalledWith('COMMIT');
    });

    test('returns 404 and rolls back when the template does not exist', async () => {
        const client = createFakeClient({
            templateRows: [],
            baseRows: [{ contents: 'unused' }],
        });

        const response = await request(app)
            .post('/prompt-template/basic')
            .send(validBody);

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Prompt template not found' });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.query).not.toHaveBeenCalledWith('COMMIT');
        expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('rejects an invalid body before touching the database', async () => {
        const response = await request(app)
            .post('/prompt-template/basic')
            .send({
                user_id: 'not-a-uuid',
                prompt_template_name: 'monthly-summary',
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Validation failed');
        expect(Object.keys(response.body.details)).toEqual(
            expect.arrayContaining(['user_id', 'prompt_text']),
        );
        expect(mockedPool.connect).not.toHaveBeenCalled();
    });

    test('rolls back and forwards unexpected database errors', async () => {
        const client = createFakeClient({
            templateRows: [{ prompt_contents: 'Template <PROMPT_TEXT>' }],
            failingSqlFragment: 'FROM prompt_templates',
        });

        const response = await request(app)
            .post('/prompt-template/basic')
            .send(validBody);

        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: 'database exploded' });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});
