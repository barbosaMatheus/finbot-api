import { Router } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';
import { registerPushToken, revokePushToken } from '../services/push.service.js';

const router = Router();

const registerSchema = z.object({
  token: z.string().trim().min(1),
  platform: z.enum(['ios', 'android', 'web']),
  deviceId: z.string().trim().min(1).optional(),
});

/** Register or refresh one Expo push token for this user/device. */
router.post(
  '/push-tokens',
  requireAuth,
  validateBody(registerSchema),
  async (req, res, next) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const body = req.body as z.infer<typeof registerSchema>;
      const token = await registerPushToken(userId, body);

      res.status(201).json({ token });
    } catch (err) {
      next(err);
    }
  },
);

/** Revoke one token (logout / notification opt-out). */
router.delete('/push-tokens/:tokenId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const revoked = await revokePushToken(userId, String(req.params.tokenId ?? ''));

    if (!revoked) {
      res.status(404).json({ error: 'Push token not found', code: 'PUSH_TOKEN_NOT_FOUND' });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
