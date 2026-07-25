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
