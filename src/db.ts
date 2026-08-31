import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
export const pgVectorSize = Number.isNaN(Number.parseInt(process.env.PG_VECTOR_SIZE ?? '768', 10))
  ? 768
  : Number.parseInt(process.env.PG_VECTOR_SIZE ?? '768', 10);

if (!connectionString) {
  console.warn(
    '[db] DATABASE_URL is not set — database-backed features will be unavailable.',
  );
}

export const pool = new Pool(
  connectionString ? { connectionString } : undefined,
);

pool.on('error', (err) => {
  console.error('[db] unexpected error on idle client', err);
});

/**
 * Run `fn` inside one BEGIN/COMMIT on a dedicated client, rolling back on
 * any throw. The transaction boundary is the caller's — nest reads and
 * writes that must land (or fail) together.
 */
export async function withTransaction<T>(
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('[db] connectivity check failed', err);
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
