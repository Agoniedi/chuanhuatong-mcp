import pg from 'pg';

import { runMigrations } from './migrations.mjs';

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error('[database] DATABASE_URL is required');
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: true } : undefined,
  });
  try {
    await runMigrations(pool);
  } catch (error) {
    console.error('[database] migration failed', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
