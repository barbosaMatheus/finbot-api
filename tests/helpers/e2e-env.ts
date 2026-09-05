/**
 * Must be the FIRST import of the e2e suite: points DATABASE_URL at the
 * integration database before any module reads process.env at load time.
 */

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

process.env.PLAID_TOKEN_ENC_KEY =
  process.env.PLAID_TOKEN_ENC_KEY ?? 'ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'e2e-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'e2e-refresh-secret';

export {};
