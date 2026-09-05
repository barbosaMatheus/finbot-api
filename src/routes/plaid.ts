import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../lib/logger.js';
import {
  isWebhookVerificationEnabled,
  verifyPlaidWebhook,
} from '../lib/webhook-verify.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  completeHostedLink,
  createLinkToken,
  disconnectItem,
  exchangePublicToken,
  listConnections,
} from '../services/plaid.service.js';
import {
  processPlaidWebhook,
  type PlaidWebhookPayload,
} from '../services/webhook.service.js';
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

export const linkTokenSchema = z.object({
  mode: z.enum(['add', 'update']).optional(),
  itemId: z.string().uuid().optional(),
});

router.post('/link-token', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const parsed = linkTokenSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed' });
      return;
    }

    res.status(200).json(
      await createLinkToken(userId, {
        mode: parsed.data.mode,
        itemRowId: parsed.data.itemId,
      }),
    );
  } catch (err) {
    if (err instanceof PlaidError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }

    next(err);
  }
});

/** Disconnect one institution and rebuild dependent analysis. */
router.delete('/connections/:itemId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await disconnectItem(userId, String(req.params.itemId ?? ''));

    res.status(200).json(result);
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

/**
 * Plaid server-to-server webhook. Authenticated by signature, not session.
 * Verifies (unless PLAID_WEBHOOK_VERIFY=false for local simulation),
 * records + deduplicates the event, enqueues durable work, and returns
 * quickly — long processing never happens on this request.
 */
router.post('/webhook', async (req, res) => {
  const rawBody =
    (req as { rawBody?: Buffer }).rawBody ??
    Buffer.from(JSON.stringify(req.body ?? {}));

  if (isWebhookVerificationEnabled()) {
    try {
      const header = req.headers['plaid-verification'];
      await verifyPlaidWebhook(
        rawBody,
        typeof header === 'string' ? header : undefined,
      );
    } catch (err) {
      logger.warn('rejected unverified webhook', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(401).json({ error: 'Webhook verification failed' });
      return;
    }
  }

  try {
    await processPlaidWebhook(rawBody, (req.body ?? {}) as PlaidWebhookPayload);
    res.status(200).json({ received: true });
  } catch (err) {
    // Non-2xx makes Plaid retry the delivery, which is what we want when
    // recording/enqueueing failed.
    logger.error('webhook processing failed', {
      error: err instanceof Error ? err : String(err),
    });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

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
