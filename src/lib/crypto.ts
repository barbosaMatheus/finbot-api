import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for secrets that must be recoverable at rest.
 *
 * Passwords and refresh tokens are hashed (see lib/password.ts) because they
 * only ever need to be compared. Plaid access tokens are different: they are
 * long-lived credentials we have to replay back to Plaid, so they must be
 * reversible. AES-256-GCM gives us confidentiality plus an authentication tag,
 * so tampered ciphertext fails to decrypt instead of yielding garbage.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

/**
 * Read the key lazily. Module-scope env reads run before `dotenv.config()`
 * under ESM import hoisting, so anything that touches process.env has to do it
 * inside a function.
 */
function getKey(): Buffer {
  const raw = process.env.PLAID_TOKEN_ENC_KEY;

  if (!raw) {
    throw new Error('PLAID_TOKEN_ENC_KEY is not set');
  }

  const key = Buffer.from(raw, 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `PLAID_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  return key;
}

/**
 * Encrypt a secret for storage. Returns `v1:<iv>:<authTag>:<ciphertext>`,
 * each part base64. The version prefix leaves room to rotate the scheme later
 * without a data migration guessing game.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Reverse `encryptSecret`. Throws if the payload was tampered with. */
export function decryptSecret(stored: string): string {
  const parts = stored.split(':');

  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error('Encrypted payload is malformed');
  }

  const iv = Buffer.from(parts[1] as string, 'base64');
  const authTag = Buffer.from(parts[2] as string, 'base64');
  const ciphertext = Buffer.from(parts[3] as string, 'base64');

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  );
}
