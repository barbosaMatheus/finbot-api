import type { CookieOptions, Response } from 'express';

export const ACCESS_COOKIE_NAME = 'finbot_access';
export const REFRESH_COOKIE_NAME = 'finbot_refresh';

function getSameSite(): CookieOptions['sameSite'] {
  const value = process.env.COOKIE_SAME_SITE?.toLowerCase();

  if (value === 'strict' || value === 'none' || value === 'lax') {
    return value;
  }

  return 'lax';
}

function baseCookieOptions(maxAgeMs: number): CookieOptions {
  const secure = process.env.COOKIE_SECURE === 'true';

  return {
    httpOnly: true,
    secure,
    sameSite: getSameSite(),
    maxAge: maxAgeMs,
  };
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  refreshMaxAgeMs: number,
): void {
  const accessMaxAgeMs = 15 * 60 * 1000;

  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...baseCookieOptions(accessMaxAgeMs),
    path: '/',
  });

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(refreshMaxAgeMs),
    path: '/auth',
  });
}

export function clearAuthCookies(res: Response): void {
  const secure = process.env.COOKIE_SECURE === 'true';
  const sameSite = getSameSite();

  res.clearCookie(ACCESS_COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
  });

  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite,
    path: '/auth',
  });
}
