import { SignJWT, jwtVerify } from 'jose';

export type AccessTokenPayload = {
  sub: string;
  email: string;
};

export type RefreshTokenPayload = {
  sub: string;
  sid: string;
};

function getAccessSecret(): Uint8Array {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new Error('JWT_ACCESS_SECRET is not set');
  }
  return new TextEncoder().encode(secret);
}

function getRefreshSecret(): Uint8Array {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET is not set');
  }
  return new TextEncoder().encode(secret);
}

function parseTtl(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value : fallback;
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  const ttl = parseTtl(process.env.JWT_ACCESS_TTL, '15m');

  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(getAccessSecret());
}

export async function signRefreshToken(payload: RefreshTokenPayload): Promise<string> {
  const ttl = parseTtl(process.env.JWT_REFRESH_TTL, '7d');

  return new SignJWT({ sid: payload.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(getRefreshSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getAccessSecret());

  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new Error('Invalid access token payload');
  }

  return {
    sub: payload.sub,
    email: payload.email,
  };
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(token, getRefreshSecret());

  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw new Error('Invalid refresh token payload');
  }

  return {
    sub: payload.sub,
    sid: payload.sid,
  };
}

export function getRefreshTtlMs(): number {
  const ttl = parseTtl(process.env.JWT_REFRESH_TTL, '7d');
  const match = ttl.match(/^(\d+)([smhd])$/);

  if (!match) {
    return 7 * 24 * 60 * 60 * 1000;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}
