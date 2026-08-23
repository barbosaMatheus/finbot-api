import { Router } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  completeHostedLink,
  createLinkToken,
  exchangePublicToken,
  listConnections,
} from '../services/plaid.service.js';
import { PlaidError } from '../types/plaid.js';

const router = Router();

export const exchangeSchema = z.object({
  publicToken: z.string().trim().min(1),
});

export const hostedLinkSchema = z.object({
  linkToken: z.string().trim().min(1),
});

/**
 * Standard Plaid flow:
 *   POST /plaid/link-token             -> link_token (+ hosted link URL for web)
 *   POST /plaid/exchange-public-token  -> native Link hands back a public_token
 *   POST /plaid/hosted-link/complete   -> web fallback polls until the session finishes
 *   GET  /plaid/connections            -> what this user has already linked
 */

router.post('/link-token', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.status(200).json(await createLinkToken(userId));
  } catch (err) {
    if (err instanceof PlaidError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }

    next(err);
  }
});

router.post(
  '/exchange-public-token',
  requireAuth,
  validateBody(exchangeSchema),
  async (req, res, next) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { publicToken } = req.body as z.infer<typeof exchangeSchema>;
      const connection = await exchangePublicToken(userId, publicToken);

      res.status(201).json({ connection });
    } catch (err) {
      if (err instanceof PlaidError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }

      next(err);
    }
  },
);

router.post(
  '/hosted-link/complete',
  requireAuth,
  validateBody(hostedLinkSchema),
  async (req, res, next) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { linkToken } = req.body as z.infer<typeof hostedLinkSchema>;

      res.status(200).json(await completeHostedLink(userId, linkToken));
    } catch (err) {
      if (err instanceof PlaidError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }

      next(err);
    }
  },
);

router.get('/connections', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.status(200).json({ connections: await listConnections(userId) });
  } catch (err) {
    next(err);
  }
});

export default router;
