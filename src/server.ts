// Must be first: ESM hoists imports, so anything reading process.env at module
// scope (db.ts reads DATABASE_URL) would otherwise run before dotenv loads.
import 'dotenv/config';

import app from './app.js';
import { runMigrations } from './db/migrate.js';
import { seedDatabase } from './db/seed-database.js';

const port = Number(process.env.PORT ?? 3000);

async function start(): Promise<void> {
  await runMigrations();
  await seedDatabase();

  app.listen(port, () => {
    console.log(`[server] finbot-api listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
