import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from 'plaid';

import { PlaidError } from '../types/plaid.js';

/**
 * Shared Plaid API client and the env-backed configuration around it.
 *
 * Everything here reads `process.env` lazily. Under ESM, imports are hoisted
 * and evaluated before `dotenv.config()` runs in app.ts, so module-scope env
 * reads would see an empty value when the API is started outside Docker.
 */

let client: PlaidApi | null = null;

/**
 * Configuration problems surface as 503 rather than a bare 500, so a developer
 * who has not filled in their Plaid keys gets told exactly that.
 */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new PlaidError(
      `Plaid is not configured: ${name} is not set. See .env.example.`,
      503,
    );
  }

  return value;
}

function getBasePath(): string {
  const env = (process.env.PLAID_ENV ?? 'sandbox').trim().toLowerCase();
  const basePath = PlaidEnvironments[env];

  if (!basePath) {
    throw new PlaidError(
      `Plaid is not configured: PLAID_ENV must be one of ${Object.keys(
        PlaidEnvironments,
      ).join(', ')} (got "${env}")`,
      503,
    );
  }

  return basePath;
}

export function getPlaidClient(): PlaidApi {
  if (client) {
    return client;
  }

  const configuration = new Configuration({
    basePath: getBasePath(),
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': requireEnv('PLAID_CLIENT_ID'),
        'PLAID-SECRET': requireEnv('PLAID_SECRET'),
      },
    },
  });

  client = new PlaidApi(configuration);

  return client;
}

/** Parses a comma-separated env list, e.g. `PLAID_PRODUCTS=transactions,auth`. */
function parseList(value: string | undefined, fallback: string[]): string[] {
  const parsed = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : fallback;
}

export function getPlaidProducts(): Products[] {
  return parseList(process.env.PLAID_PRODUCTS, ['transactions']) as Products[];
}

export function getPlaidCountryCodes(): CountryCode[] {
  return parseList(process.env.PLAID_COUNTRY_CODES, ['US']).map((code) =>
    code.toUpperCase(),
  ) as CountryCode[];
}

/**
 * OAuth redirect URI for the native Link flow. Must be registered in the Plaid
 * Dashboard. Optional: sandbox testing works without it.
 */
export function getPlaidRedirectUri(): string | undefined {
  const value = process.env.PLAID_REDIRECT_URI?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Android package name, required by Plaid for OAuth institutions on Android.
 * Optional for the same reason as the redirect URI.
 */
export function getPlaidAndroidPackageName(): string | undefined {
  const value = process.env.PLAID_ANDROID_PACKAGE_NAME?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Where Hosted Link sends the browser once the user finishes. Only used by the
 * web fallback; defaults to the configured web origin.
 */
export function getHostedLinkRedirectUri(): string | undefined {
  const explicit = process.env.PLAID_HOSTED_LINK_REDIRECT_URI?.trim();

  if (explicit && explicit.length > 0) {
    return explicit;
  }

  const corsOrigin = process.env.CORS_ORIGIN?.trim();

  return corsOrigin && corsOrigin.length > 0 ? corsOrigin : undefined;
}

/**
 * Public URL Plaid delivers webhooks to (`POST /plaid/webhook`). Without it
 * Plaid sends no SYNC_UPDATES_AVAILABLE or ITEM events, so transactions stop
 * updating after the initial import. Optional only for local sandbox work.
 */
export function getPlaidWebhookUrl(): string | undefined {
  const value = process.env.PLAID_WEBHOOK_URL?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** Shown to the user inside Link. Plaid caps this at 30 characters. */
export const PLAID_CLIENT_NAME = 'FinBot';

/** How many days of history to request from Plaid (design default: 180). */
export function getRequestedHistoryDays(): number {
  const parsed = Number.parseInt(process.env.PLAID_TRANSACTION_DAYS ?? '180', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 730) : 180;
}
