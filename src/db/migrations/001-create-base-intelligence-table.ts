import 'dotenv/config';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const createTableQuery = `
  CREATE TABLE IF NOT EXISTS base_intelligence (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    contents TEXT NOT NULL
  );
`;

async function main(): Promise<void> {
  const client = new Client({ connectionString });

  try {
    await client.connect();
    await client.query(createTableQuery);
    console.log('Created table base_intelligence');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
