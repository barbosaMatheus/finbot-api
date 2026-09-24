import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  acknowledgeAnchor,
  addReflection,
  applyHeadsUp,
  completeAwareness,
  getAnchor,
  getSettings,
  parseHeadsUp,
  swapAnchorTarget,
  updateSettings,
} from '../services/gameplan-anchor.service.js';
import { GameplanError } from '../types/gameplan.js';

const router = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const swapSchema = z.object({
  outId: z.string().trim().min(1).max(120),
  inId: z.string().trim().min(1).max(120),
});

export const headsUpParseSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

export const headsUpSchema = z.object({
  text: z.string().trim().min(1).max(500),
  adjustment: z.object({
    kind: z.enum(['cost', 'spend_event', 'income_change', 'bill_change', 'other']),
    affectedCategory: z.string().trim().max(80).nullable(),
    affectedStream: z.string().trim().max(160).nullable(),
    timing: z.object({ start: isoDate, end: isoDate }).nullable(),
  }),
  /** The confirmed box amount; null when skipped (§5a). */
  amount: z.number().finite().max(1_000_000).nullable(),
});

export const reflectionSchema = z.object({
  // heads_up here is the context-only path: a line the port could not turn
  // into an adjustment (or with no model host) is still kept for chat.
  kind: z.enum(['got_in_the_way', 'whats_been_hard', 'heads_up']),
  text: z.string().trim().min(1).max(1000),
  category: z.string().trim().max(80).nullable().optional(),
  start: isoDate.nullable().optional(),
  end: isoDate.nullable().optional(),
  structural: z.boolean().optional(),
});

export const settingsSchema = z
  .object({
    anchorMode: z.enum(['auto', 'payday', 'fixed_day']).optional(),
    anchorDay: z.number().int().min(0).max(6).optional(),
    anchorTimeOfDay: z.enum(['morning', 'midday', 'evening']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

type Handler = (userId: string, req: Request, res: Response) => Promise<void>;

/** Auth, the user id, and GameplanError → status + code, in one wrapper. */
function handle(handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      await handler(userId, req, res);
    } catch (err) {
      if (err instanceof GameplanError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }

      next(err);
    }
  };
}

/** The anchor in one read: period, plan with why lines, the last grade, settings. */
router.get(
  '/anchor',
  requireAuth,
  handle(async (userId, _req, res) => {
    res.status(200).json(await getAnchor(userId));
  }),
);

/** "Got it": acknowledges the anchor and opens the period. */
router.post(
  '/anchor/got-it',
  requireAuth,
  handle(async (userId, _req, res) => {
    res.status(200).json(await acknowledgeAnchor(userId));
  }),
);

/** Exchange one plan target for one alternate; once per period. */
router.post(
  '/anchor/swap',
  requireAuth,
  validateBody(swapSchema),
  handle(async (userId, req, res) => {
    res.status(200).json(await swapAnchorTarget(userId, req.body as z.infer<typeof swapSchema>));
  }),
);

/** Heads-up, step one: the line becomes a proposal; says whether the amount box follows. */
router.post(
  '/anchor/heads-up/parse',
  requireAuth,
  validateBody(headsUpParseSchema),
  handle(async (userId, req, res) => {
    const { text } = req.body as z.infer<typeof headsUpParseSchema>;
    res.status(200).json(await parseHeadsUp(userId, text));
  }),
);

/** Heads-up, step two: apply the record with the confirmed amount and explain the diff. */
router.post(
  '/anchor/heads-up',
  requireAuth,
  validateBody(headsUpSchema),
  handle(async (userId, req, res) => {
    res.status(200).json(await applyHeadsUp(userId, req.body as z.infer<typeof headsUpSchema>));
  }),
);

/** "What got in the way?" / "what's been hard?" — stored, embedded, attributed. */
router.post(
  '/anchor/reflection',
  requireAuth,
  validateBody(reflectionSchema),
  handle(async (userId, req, res) => {
    res.status(201).json(await addReflection(userId, req.body as z.infer<typeof reflectionSchema>));
  }),
);

/** The awareness target is done. */
router.post(
  '/anchor/awareness-done',
  requireAuth,
  handle(async (userId, _req, res) => {
    res.status(200).json(await completeAwareness(userId));
  }),
);

router.get(
  '/settings',
  requireAuth,
  handle(async (userId, _req, res) => {
    res.status(200).json(await getSettings(userId));
  }),
);

/** Anchor settings; they take effect from the next period. */
router.put(
  '/settings',
  requireAuth,
  validateBody(settingsSchema),
  handle(async (userId, req, res) => {
    res.status(200).json(await updateSettings(userId, req.body as z.infer<typeof settingsSchema>));
  }),
);

export default router;
