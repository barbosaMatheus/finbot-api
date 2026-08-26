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

/**
 * Native session flow (API-018). Same registration/login/rotation logic as
 * the cookie flow, but tokens travel in the response body for Expo
 * SecureStore instead of Set-Cookie — native fetch cannot rely on browser
 * cookie behavior. Refresh tokens are single-use and rotate server-side.
 */

const nativeRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function nativeAuthBody(result: {
  user: unknown;
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeMs: number;
}) {
  return {
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    refreshExpiresInSeconds: Math.floor(result.refreshMaxAgeMs / 1000),
  };
}

router.post(
  '/native/register',
  validateBody(credentialsSchema),
  async (req, res, next) => {
    try {
      const { email, password } = req.body as z.infer<typeof credentialsSchema>;
      const result = await registerUser(email, password);

      res.status(201).json(nativeAuthBody(result));
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }

      next(err);
    }
  },
);

router.post(
  '/native/login',
  validateBody(credentialsSchema),
  async (req, res, next) => {
    try {
      const { email, password } = req.body as z.infer<typeof credentialsSchema>;
      const result = await loginUser(email, password);

      res.status(200).json(nativeAuthBody(result));
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }

      next(err);
    }
  },
);

router.post(
  '/native/refresh',
  validateBody(nativeRefreshSchema),
  async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof nativeRefreshSchema>;
      const result = await refreshSession(refreshToken);

      res.status(200).json(nativeAuthBody(result));
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }

      next(err);
    }
  },
);

router.post(
  '/native/logout',
  validateBody(nativeRefreshSchema),
  async (req, res, next) => {
    try {
      const { refreshToken } = req.body as z.infer<typeof nativeRefreshSchema>;
      await logoutSession(refreshToken);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

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
