/**
 * Plaid webhook verification (API-007).
 *
 * Plaid signs every webhook with an ES256 JWT in the `Plaid-Verification`
 * header. The JWT's claims carry a SHA-256 of the raw request body; the
 * public key is fetched (and cached) from /webhook_verification_key/get by
 * the token's key id. Verification failures reject the request before any
 * processing happens.
 *
 * PLAID_WEBHOOK_VERIFY=false disables verification for local development
 * where webhooks are simulated without Plaid's signature.
 */

import { createHash } from 'node:crypto';

import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/** Seconds a webhook token stays acceptable after being issued. */
const MAX_TOKEN_AGE_SECONDS = 5 * 60;

export type VerifyDeps = {
  /** Fetch the JWK for a key id (network call in production, cached). */
  getKey(keyId: string): Promise<JWK>;
  now?: () => Date;
};

const keyCache = new Map<string, JWK>();

/** Production key fetcher backed by the Plaid client, with an in-memory cache. */
export async function fetchPlaidWebhookKey(keyId: string): Promise<JWK> {
  const cached = keyCache.get(keyId);

  if (cached) {
    return cached;
  }

  const { getPlaidClient } = await import('./plaid.js');
  const { data } = await getPlaidClient().webhookVerificationKeyGet({
    key_id: keyId,
  });

  const key = data.key as unknown as JWK;
  keyCache.set(keyId, key);
  return key;
}

export function isWebhookVerificationEnabled(): boolean {
  return (process.env.PLAID_WEBHOOK_VERIFY ?? 'true').toLowerCase() !== 'false';
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Verify one webhook delivery. Throws WebhookVerificationError on any
 * mismatch; resolves silently when the delivery is authentic.
 */
export async function verifyPlaidWebhook(
  rawBody: Buffer | string,
  verificationJwt: string | undefined,
  deps: VerifyDeps = { getKey: fetchPlaidWebhookKey },
): Promise<void> {
  if (!verificationJwt) {
    throw new WebhookVerificationError('Missing Plaid-Verification header');
  }

  let header: ReturnType<typeof decodeProtectedHeader>;

  try {
    header = decodeProtectedHeader(verificationJwt);
  } catch {
    throw new WebhookVerificationError('Malformed verification token');
  }

  if (header.alg !== 'ES256') {
    throw new WebhookVerificationError(`Unexpected signing algorithm ${header.alg}`);
  }

  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new WebhookVerificationError('Verification token has no key id');
  }

  let payload: { iat?: number; request_body_sha256?: string };

  try {
    const jwk = await deps.getKey(header.kid);
    const key = await importJWK(jwk, 'ES256');
    const result = await jwtVerify(verificationJwt, key, {
      algorithms: ['ES256'],
    });
    payload = result.payload as typeof payload;
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      throw err;
    }

    throw new WebhookVerificationError('Signature verification failed');
  }

  const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);

  if (typeof payload.iat !== 'number' || nowSeconds - payload.iat > MAX_TOKEN_AGE_SECONDS) {
    throw new WebhookVerificationError('Verification token is too old');
  }

  const bodyHash = sha256Hex(rawBody);

  if (payload.request_body_sha256 !== bodyHash) {
    throw new WebhookVerificationError('Body hash mismatch');
  }
}

/** Exposed for tests. */
export const __internal = { keyCache };
