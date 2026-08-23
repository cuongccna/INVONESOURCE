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

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let singleQuote = false;
  let doubleQuote = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      current += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i++;
        blockComment = false;
      }
      continue;
    }

    if (dollarQuote) {
      current += ch;
      if (sql.startsWith(dollarQuote, i)) {
        current += sql.slice(i + 1, i + dollarQuote.length);
        i += dollarQuote.length - 1;
        dollarQuote = null;
      }
      continue;
    }

    if (singleQuote) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i++;
      } else if (ch === "'") {
        singleQuote = false;
      }
      continue;
    }

    if (doubleQuote) {
      current += ch;
      if (ch === '"' && next === '"') {
        current += next;
        i++;
      } else if (ch === '"') {
        doubleQuote = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      current += ch + next;
      i++;
      lineComment = true;
      continue;
    }

    if (ch === '/' && next === '*') {
      current += ch + next;
      i++;
      blockComment = true;
      continue;
    }

    if (ch === "'") {
      current += ch;
      singleQuote = true;
      continue;
    }

    if (ch === '"') {
      current += ch;
      doubleQuote = true;
      continue;
    }

    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        current += dollarQuote;
        i += dollarQuote.length - 1;
        continue;
      }
    }

    if (ch === ';') {
      const stmt = current.trim();
      if (stmt.length > 0) statements.push(stmt);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

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

      // CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
      // For migrations that contain it, run each statement individually outside a transaction,
      // then record the version separately inside a small transaction.
      const needsNoTransaction =
        /CREATE\s+INDEX\s+CONCURRENTLY/i.test(sql) ||
        /ALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i.test(sql);

      if (needsNoTransaction) {
        // Run each statement individually (no wrapping transaction).
        // PostgreSQL dollar-quoted blocks can contain semicolons, so use a tiny splitter.
        const stmts = splitSqlStatements(sql);
        try {
          for (const stmt of stmts) {
            await client.query(stmt);
          }
          // Record version in its own small transaction
          await client.query('BEGIN');
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
          await client.query('COMMIT');
          console.log(`[DONE] ${file}`);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error(`[FAIL] ${file}:`, err);
          throw err;
        }
      } else {
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
