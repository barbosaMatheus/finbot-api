import { Router } from 'express';
import { z } from 'zod';

import { REFRESH_COOKIE_NAME, clearAuthCookies, setAuthCookies } from '../lib/cookies.js';
import { validateBody } from '../middleware/validate.js';
import {
  loginUser,
  logoutSession,
  refreshSession,
  registerUser,
} from '../services/auth.service.js';
import { AuthError } from '../types/auth.js';

const router = Router();

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

router.post(
  '/register',
  validateBody(credentialsSchema),
  async (req, res, next) => {
    try {
      const { email, password } = req.body as z.infer<typeof credentialsSchema>;
      const result = await registerUser(email, password);

      setAuthCookies(
        res,
        result.accessToken,
        result.refreshToken,
        result.refreshMaxAgeMs,
      );

      res.status(201).json({ user: result.user });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }

      next(err);
    }
  },
);

router.post('/login', validateBody(credentialsSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body as z.infer<typeof credentialsSchema>;
    const result = await loginUser(email, password);

    setAuthCookies(
      res,
      result.accessToken,
      result.refreshToken,
      result.refreshMaxAgeMs,
    );

    res.status(200).json({ user: result.user });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }

    next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }

  try {
    const result = await refreshSession(refreshToken);

    setAuthCookies(
      res,
      result.accessToken,
      result.refreshToken,
      result.refreshMaxAgeMs,
    );

    res.status(200).json({ user: result.user });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }

    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  try {
    if (refreshToken && typeof refreshToken === 'string') {
      await logoutSession(refreshToken);
    }

    clearAuthCookies(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
