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
      /** Which transport authenticated this request. */
      authTransport?: 'cookie' | 'bearer';
    }
  }
}

/**
 * Dual-transport authentication (API-018): web sends the HttpOnly access
 * cookie; native clients send `Authorization: Bearer <accessToken>` from
 * SecureStore. Both paths verify the same token and produce the same
 * req.user, so authorization checks downstream are identical.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  let accessToken: string | undefined;
  let transport: 'cookie' | 'bearer' = 'cookie';

  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    accessToken = header.slice('Bearer '.length).trim();
    transport = 'bearer';
  } else {
    const cookieToken = req.cookies?.[ACCESS_COOKIE_NAME];
    accessToken = typeof cookieToken === 'string' ? cookieToken : undefined;
  }

  if (!accessToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const payload = await verifyAccessToken(accessToken);
    req.user = {
      id: payload.sub,
      email: payload.email,
    };
    req.authTransport = transport;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
