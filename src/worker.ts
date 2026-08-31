// Must be first: ESM hoists imports, so anything reading process.env at module
// scope would otherwise run before dotenv loads.
import 'dotenv/config';

import { runMigrations } from './db/migrate.js';
import { closePool } from './db.js';
import { getBoss, stopBoss } from './jobs/boss.js';
import { registerJobHandlers, registeredJobNames } from './jobs/register.js';
// Handler modules self-register via setJobHandler at import time. Later
// tickets add their imports here.
import './jobs/handlers/index.js';
import { logger } from './lib/logger.js';

/**
 * Background worker entry point. Runs from the same image as the API with a
 * different command (`npm run worker` / `node dist/worker.js`). Owns all
 * Plaid synchronization and analysis; never depends on a live client session.
 */
async function main(): Promise<void> {
  // The worker can win the race against the API on a fresh database, so both
  // run migrations; runMigrations is transactional and idempotent.
  await runMigrations();

  const boss = await getBoss();
  await registerJobHandlers(boss);

  logger.info('worker started', {
    handlers: registeredJobNames().join(','),
  });

  // Point Items linked before PLAID_WEBHOOK_URL was configured at the
  // webhook receiver. Best-effort: the worker must start regardless.
  const { syncItemWebhooks } = await import('./services/plaid.service.js');

  syncItemWebhooks().catch((err) => {
    logger.error('item webhook sync failed', {
      error: err instanceof Error ? err : String(err),
    });
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info('worker shutting down', { signal });

    try {
      await stopBoss();
      await closePool();
      process.exit(0);
    } catch (err) {
      logger.error('worker shutdown failed', { error: err instanceof Error ? err : String(err) });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('worker failed to start', {
    error: err instanceof Error ? err : String(err),
  });
  process.exit(1);
});
