import app from './app.js';
import { runMigrations } from './db/migrate.js';

const port = Number(process.env.PORT ?? 3000);

async function start(): Promise<void> {
  await runMigrations();

  app.listen(port, () => {
    console.log(`[server] finbot-api listening on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
