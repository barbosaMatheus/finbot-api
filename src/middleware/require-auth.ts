import type { NextFunction, Request, Response } from 'express';

import { ACCESS_COOKIE_NAME } from '../lib/cookies.js';
import { verifyAccessToken } from '../lib/jwt.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
      };
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const accessToken = req.cookies?.[ACCESS_COOKIE_NAME];

  if (!accessToken || typeof accessToken !== 'string') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = await verifyAccessToken(accessToken);
    req.user = {
      id: payload.sub,
      email: payload.email,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
