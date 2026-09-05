import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/middleware/require-auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'user-1', email: 'user@test.com' };
    next();
  },
}));

const anchorService = {
  getAnchor: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  acknowledgeAnchor: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  swapAnchorTarget: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  parseHeadsUp: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  applyHeadsUp: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  addReflection: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  completeAwareness: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  getSettings: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  updateSettings: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
};

jest.mock('../src/services/gameplan-anchor.service', () => anchorService);

import gameplanRouter from '../src/routes/gameplan.js';
import { GameplanError } from '../src/types/gameplan.js';

const app = express();
app.use(express.json());
app.use('/gameplan', gameplanRouter);

beforeEach(() => {
  for (const fn of Object.values(anchorService)) fn.mockReset();
});

const plan = {
  targets: [{ id: 'savings_transfer', rank: 1, role: 'plan', definition: { type: 'savings_transfer', amount: 112 }, reasons: [], why: 'Move $112.', whySource: 'template' }],
  alternates: [{ id: 'frequency_cap:Shopping', rank: 4, role: 'alternate', definition: { type: 'frequency_cap' }, reasons: [], why: 'No more than 4.', whySource: 'template' }],
  swapUsed: false,
};

describe('the anchor routes walk open → swap → heads-up → got-it', () => {
  test('GET /gameplan/anchor returns the read model for the authenticated user', async () => {
    anchorService.getAnchor.mockResolvedValue({ status: 'ready', period: { id: 'p1' }, plan, previousGrade: null, reengage: false });

    const response = await request(app).get('/gameplan/anchor');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ready', plan: { swapUsed: false } });
    expect(anchorService.getAnchor).toHaveBeenCalledWith('user-1');
  });

  test('POST /gameplan/anchor/swap validates the body and forwards the ids', async () => {
    anchorService.swapAnchorTarget.mockResolvedValue({ plan: { ...plan, swapUsed: true }, diff: [] });

    const bad = await request(app).post('/gameplan/anchor/swap').send({ outId: 'savings_transfer' });
    expect(bad.status).toBe(400);
    expect(anchorService.swapAnchorTarget).not.toHaveBeenCalled();

    const response = await request(app)
      .post('/gameplan/anchor/swap')
      .send({ outId: 'savings_transfer', inId: 'frequency_cap:Shopping' });

    expect(response.status).toBe(200);
    expect(response.body.plan.swapUsed).toBe(true);
    expect(anchorService.swapAnchorTarget).toHaveBeenCalledWith('user-1', {
      outId: 'savings_transfer',
      inId: 'frequency_cap:Shopping',
    });
  });

  test('a second swap maps the domain error to 409 with its code', async () => {
    anchorService.swapAnchorTarget.mockRejectedValue(new GameplanError('One swap per period', 409, 'SWAP_ALREADY_USED'));

    const response = await request(app)
      .post('/gameplan/anchor/swap')
      .send({ outId: 'savings_transfer', inId: 'frequency_cap:Shopping' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'One swap per period', code: 'SWAP_ALREADY_USED' });
  });

  test('the heads-up is two steps: parse proposes, apply carries the confirmed amount', async () => {
    anchorService.parseHeadsUp.mockResolvedValue({
      adjustment: { kind: 'cost', amount: 400, affectedCategory: null, affectedStream: null, timing: null, text: 'car repair, about $400' },
      needsAmount: true,
      proposedAmount: 400,
      amountDropped: false,
      problems: [],
      source: 'model',
      fallbackReason: null,
    });

    const parsed = await request(app).post('/gameplan/anchor/heads-up/parse').send({ text: 'car repair, about $400' });
    expect(parsed.status).toBe(200);
    expect(parsed.body).toMatchObject({ needsAmount: true, proposedAmount: 400 });
    expect(anchorService.parseHeadsUp).toHaveBeenCalledWith('user-1', 'car repair, about $400');

    anchorService.applyHeadsUp.mockResolvedValue({
      outcome: 'applied',
      applied: true,
      reply: 'Got it: the transfer is $62 for now instead of $112.',
      replySource: 'template',
      diff: [],
      plan,
    });

    const applied = await request(app)
      .post('/gameplan/anchor/heads-up')
      .send({
        text: 'car repair, about $400',
        adjustment: { kind: 'cost', affectedCategory: null, affectedStream: null, timing: null },
        amount: 400,
      });

    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(anchorService.applyHeadsUp).toHaveBeenCalledWith('user-1', {
      text: 'car repair, about $400',
      adjustment: { kind: 'cost', affectedCategory: null, affectedStream: null, timing: null },
      amount: 400,
    });

    // A skipped box is an explicit null, never a missing field.
    const missing = await request(app)
      .post('/gameplan/anchor/heads-up')
      .send({ text: 'car trouble', adjustment: { kind: 'cost', affectedCategory: null, affectedStream: null, timing: null } });
    expect(missing.status).toBe(400);
  });

  test('POST /gameplan/anchor/got-it opens the period', async () => {
    anchorService.acknowledgeAnchor.mockResolvedValue({ periodId: 'p1', status: 'open', anchorOpenedAt: '2026-09-25T18:00:00.000Z' });

    const response = await request(app).post('/gameplan/anchor/got-it');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('open');
  });

  test('reflections, awareness and settings', async () => {
    anchorService.addReflection.mockResolvedValue({ id: 'r1', periodId: 'p0', kind: 'got_in_the_way', attribution: 'one_off', attributed: null });
    const reflection = await request(app)
      .post('/gameplan/anchor/reflection')
      .send({ kind: 'got_in_the_way', text: 'my sister visited that weekend' });
    expect(reflection.status).toBe(201);
    expect(reflection.body.attribution).toBe('one_off');

    anchorService.completeAwareness.mockResolvedValue({ periodId: 'p1', awarenessCompletedAt: '2026-09-26T10:00:00.000Z' });
    expect((await request(app).post('/gameplan/anchor/awareness-done')).status).toBe(200);

    anchorService.getSettings.mockResolvedValue({ settings: { anchorMode: 'auto', anchorDay: 0, anchorTimeOfDay: 'evening' }, effectiveFrom: 'next_period' });
    expect((await request(app).get('/gameplan/settings')).body.settings.anchorDay).toBe(0);

    anchorService.updateSettings.mockResolvedValue({ settings: { anchorMode: 'fixed_day', anchorDay: 3, anchorTimeOfDay: 'evening' }, effectiveFrom: 'next_period' });
    const updated = await request(app).put('/gameplan/settings').send({ anchorMode: 'fixed_day', anchorDay: 3 });
    expect(updated.status).toBe(200);
    expect(anchorService.updateSettings).toHaveBeenCalledWith('user-1', { anchorMode: 'fixed_day', anchorDay: 3 });

    expect((await request(app).put('/gameplan/settings').send({ anchorDay: 7 })).status).toBe(400);
    expect((await request(app).put('/gameplan/settings').send({})).status).toBe(400);
  });

  test('a period that does not exist yet is a 409 the client can route on', async () => {
    anchorService.acknowledgeAnchor.mockRejectedValue(new GameplanError('No period is open yet', 409, 'NO_LIVE_PERIOD'));
    const response = await request(app).post('/gameplan/anchor/got-it');
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('NO_LIVE_PERIOD');
  });
});
