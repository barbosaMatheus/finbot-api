import { randomUUID } from 'node:crypto';

import { pool } from '../db.js';
import {
  getRefreshTtlMs,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt.js';
import { hashPassword, hashToken, verifyPassword, verifyTokenHash } from '../lib/password.js';
import { AuthError, type AuthResult, type AuthUser } from '../types/auth.js';

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  on_boarding_complete: boolean;
};

type SessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
};

function toAuthUser(
  row: Pick<UserRow, 'id' | 'email' | 'on_boarding_complete'>,
): AuthUser {
  return {
    id: row.id,
    email: row.email,
    onboardingComplete: row.on_boarding_complete,
  };
}

async function issueTokens(user: AuthUser): Promise<AuthResult> {
  const sessionId = randomUUID();
  const refreshMaxAgeMs = getRefreshTtlMs();
  const expiresAt = new Date(Date.now() + refreshMaxAgeMs);

  const refreshToken = await signRefreshToken({
    sub: user.id,
    sid: sessionId,
  });
  const tokenHash = await hashToken(refreshToken);

  await pool.query(
    `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, user.id, tokenHash, expiresAt],
  );

  const accessToken = await signAccessToken({
    sub: user.id,
    email: user.email,
  });

  return {
    user,
    accessToken,
    refreshToken,
    refreshMaxAgeMs,
  };
}

export async function registerUser(
  email: string,
  password: string,
): Promise<AuthResult> {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  let user: AuthUser;

  try {
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, password_hash, on_boarding_complete`,
      [normalizedEmail, passwordHash],
    );

    user = toAuthUser(rows[0]);
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === '23505'
    ) {
      throw new AuthError('Email already registered', 409);
    }

    throw err;
  }

  return issueTokens(user);
}

export async function loginUser(
  email: string,
  password: string,
): Promise<AuthResult> {
  const normalizedEmail = email.trim().toLowerCase();

  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, password_hash, on_boarding_complete
     FROM users
     WHERE email = $1`,
    [normalizedEmail],
  );

  const userRow = rows[0];

  if (!userRow) {
    throw new AuthError('Invalid email or password', 401);
  }

  const valid = await verifyPassword(password, userRow.password_hash);

  if (!valid) {
    throw new AuthError('Invalid email or password', 401);
  }

  return issueTokens(toAuthUser(userRow));
}

export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  let payload;

  try {
    payload = await verifyRefreshToken(refreshToken);
  } catch {
    throw new AuthError('Invalid refresh token', 401);
  }

  const { rows } = await pool.query<SessionRow>(
    `SELECT id, user_id, token_hash, expires_at, revoked_at
     FROM refresh_sessions
     WHERE id = $1`,
    [payload.sid],
  );

  const session = rows[0];

  if (!session || session.revoked_at || session.expires_at <= new Date()) {
    throw new AuthError('Invalid refresh token', 401);
  }

  const valid = await verifyTokenHash(refreshToken, session.token_hash);

  if (!valid || session.user_id !== payload.sub) {
    throw new AuthError('Invalid refresh token', 401);
  }

  const { rows: userRows } = await pool.query<UserRow>(
    `SELECT id, email, password_hash, on_boarding_complete
     FROM users
     WHERE id = $1`,
    [session.user_id],
  );

  const userRow = userRows[0];

  if (!userRow) {
    throw new AuthError('Invalid refresh token', 401);
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE refresh_sessions
       SET revoked_at = NOW()
       WHERE id = $1`,
      [session.id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return issueTokens(toAuthUser(userRow));
}

export async function logoutSession(refreshToken: string): Promise<void> {
  let payload;

  try {
    payload = await verifyRefreshToken(refreshToken);
  } catch {
    return;
  }

  await pool.query(
    `UPDATE refresh_sessions
     SET revoked_at = NOW()
     WHERE id = $1 AND revoked_at IS NULL`,
    [payload.sid],
  );
}
