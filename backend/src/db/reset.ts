import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const pool = new Pool({ connectionString: process.env['DATABASE_URL'], ssl: false });

async function reset() {
  const client = await pool.connect();
  try {
    console.log('[RESET] Dropping all tables and enums...');
    await client.query(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT typname FROM pg_type
                  JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
                  WHERE pg_namespace.nspname = 'public' AND pg_type.typtype = 'e') LOOP
          EXECUTE 'DROP TYPE IF EXISTS ' || quote_ident(r.typname) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    console.log('[RESET] Done. Now re-running migrations...');
  } finally {
    client.release();
    await pool.end();
  }

  // Re-run migrations
  const { execSync } = await import('child_process');
  execSync('npm run db:migrate', { stdio: 'inherit', cwd: path.resolve(__dirname, '../..') });
}

reset().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
