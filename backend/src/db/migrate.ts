import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

// Load env manually for migration script (before full app init)
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
  ssl: false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Create migrations tracking table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(50) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const scriptsDir = path.resolve(__dirname, '../../../scripts');
    const files = fs
      .readdirSync(scriptsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace('.sql', '');
      const { rows } = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (rows.length > 0) {
        console.log(`[SKIP] ${file} already applied`);
        continue;
      }

      const sql = fs.readFileSync(path.join(scriptsDir, file), 'utf-8');
      console.log(`[RUN]  ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version]
        );
        await client.query('COMMIT');
        console.log(`[DONE] ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[FAIL] ${file}:`, err);
        throw err;
      }
    }

    console.log('\nAll migrations completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
