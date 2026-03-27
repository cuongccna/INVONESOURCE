/**
 * Shared PostgreSQL pool for the bot module.
 * Uses WORKER_DB_URL (separate low-privilege DB user) or falls back to DATABASE_URL.
 */
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env['WORKER_DB_URL'] ?? process.env['DATABASE_URL'],
  max: 5,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[Bot DB] Unexpected pool error', err);
});
