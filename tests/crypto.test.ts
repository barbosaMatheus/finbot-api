import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';

const originalKey = process.env.PLAID_TOKEN_ENC_KEY;

describe('crypto', () => {
  beforeEach(() => {
    process.env.PLAID_TOKEN_ENC_KEY = randomBytes(32).toString('base64');
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.PLAID_TOKEN_ENC_KEY;
    } else {
      process.env.PLAID_TOKEN_ENC_KEY = originalKey;
    }
  });

  test('round-trips a secret', () => {
    const encrypted = encryptSecret('access-sandbox-1234');

    expect(encrypted).not.toContain('access-sandbox-1234');
    expect(decryptSecret(encrypted)).toBe('access-sandbox-1234');
  });

  test('produces a different ciphertext each time', () => {
    expect(encryptSecret('same-input')).not.toBe(encryptSecret('same-input'));
  });

  test('rejects tampered ciphertext', () => {
    const [version, iv, tag, ciphertext] = encryptSecret('access-sandbox-1234').split(
      ':',
    );
    const flipped = Buffer.from(ciphertext as string, 'base64');
    flipped[0] = (flipped[0] as number) ^ 0xff;

    expect(() =>
      decryptSecret([version, iv, tag, flipped.toString('base64')].join(':')),
    ).toThrow();
  });

  test('rejects a malformed payload', () => {
    expect(() => decryptSecret('not-encrypted')).toThrow('malformed');
  });

  test('requires a 32-byte key', () => {
    process.env.PLAID_TOKEN_ENC_KEY = Buffer.from('too-short').toString('base64');

    expect(() => encryptSecret('anything')).toThrow('32 bytes');
  });

  test('requires the key to be set', () => {
    delete process.env.PLAID_TOKEN_ENC_KEY;

    expect(() => encryptSecret('anything')).toThrow('PLAID_TOKEN_ENC_KEY is not set');
  });
});
