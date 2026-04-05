/**
 * test-company-delete.js
 *
 * Diagnostic test for company delete.
 * Steps:
 *   1. Query all FK constraints referencing companies(id) WITHOUT ON DELETE CASCADE
 *   2. Create a test company with data in every affected table (or use real company if --tax-code given)
 *   3. Run the delete sequence from companies.ts step by step and report which step fails
 *   4. Verify the test company is fully deleted or report remaining rows
 *
 * Run (test mode):  node scripts/test-company-delete.js
 * Run (real delete): node scripts/test-company-delete.js --tax-code 0102721191
 */
const { Client } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const DB_URL = process.env.DATABASE_URL;
const TEST_TAG = 'TEST_DELETE_' + Date.now();

// Parse --tax-code argument
const taxCodeArgIdx = process.argv.indexOf('--tax-code');
const TARGET_TAX_CODE = taxCodeArgIdx !== -1 ? process.argv[taxCodeArgIdx + 1] : null;

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  console.log('✅ Connected to DB:', DB_URL.replace(/:\/\/[^@]+@/, '://***@'));

  // ─── Step 1: Find all FK constraints to companies WITHOUT cascade ─────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('STEP 1: FK constraints referencing companies(id) in actual DB');
  console.log('═══════════════════════════════════════════════════════════');
  const fkResult = await db.query(`
    SELECT
      tc.table_name         AS child_table,
      kcu.column_name       AS fk_column,
      rc.delete_rule        AS on_delete,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema    = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name  = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.key_column_usage ccu
      ON ccu.constraint_name = rc.unique_constraint_name
     AND ccu.table_schema    = rc.unique_constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name     = 'companies'
      AND ccu.column_name    = 'id'
    ORDER BY rc.delete_rule, tc.table_name
  `);

  const noAction = fkResult.rows.filter(r => r.on_delete !== 'CASCADE' && r.on_delete !== 'SET NULL');
  const withCascade = fkResult.rows.filter(r => r.on_delete === 'CASCADE');
  const withSetNull = fkResult.rows.filter(r => r.on_delete === 'SET NULL');

  console.log(`\n🔴 NO ACTION / RESTRICT (MUST be manually deleted): ${noAction.length} tables`);
  noAction.forEach(r => console.log(`   - ${r.child_table}.${r.fk_column}  [${r.on_delete}]`));

  console.log(`\n🟢 CASCADE (auto-deleted with company): ${withCascade.length} tables`);
  withCascade.forEach(r => console.log(`   - ${r.child_table}.${r.fk_column}`));

  console.log(`\n🟡 SET NULL: ${withSetNull.length} tables`);
  withSetNull.forEach(r => console.log(`   - ${r.child_table}.${r.fk_column}`));

  // Tables the current handler manually deletes
  const handlerDeletedTables = [
    'gdt_bot_runs',
    'import_temp_files',
    'bot_failed_jobs',
    'audit_logs',
    'gdt_validation_queue',  // via invoice FK
  ];

  const MISSING_FROM_HANDLER = noAction.filter(r =>
    !handlerDeletedTables.includes(r.child_table)
  );

  if (MISSING_FROM_HANDLER.length > 0) {
    console.log('\n🚨 TABLES WITH FK BUT NOT IN DELETE HANDLER — this WILL cause 500:');
    MISSING_FROM_HANDLER.forEach(r =>
      console.log(`   ❌ ${r.child_table}.${r.fk_column}  [delete_rule: ${r.on_delete}]`)
    );
  } else {
    console.log('\n✅ All NO-ACTION FK tables are covered by the delete handler (from schema analysis)');
  }

  // ─── Step 2: Resolve or create company ──────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  if (TARGET_TAX_CODE) {
    console.log(`STEP 2: Lookup REAL company by tax code: ${TARGET_TAX_CODE}`);
  } else {
    console.log('STEP 2: Create test company + seed data in affected tables');
  }
  console.log('═══════════════════════════════════════════════════════════');

  let companyId;
  let isRealCompany = false;

  if (TARGET_TAX_CODE) {
    // ── Real company mode: look up by tax code ──────────────────────────────
    const lookup = await db.query(
      `SELECT id, name, tax_code FROM companies WHERE tax_code = $1 AND deleted_at IS NULL LIMIT 1`,
      [TARGET_TAX_CODE]
    );
    if (lookup.rows.length === 0) {
      console.error(`❌ No active company found with tax_code = '${TARGET_TAX_CODE}'`);
      await db.end();
      return;
    }
    const co = lookup.rows[0];
    companyId = co.id;
    isRealCompany = true;
    console.log(`ℹ  Found company  : ${co.name}`);
    console.log(`ℹ  Tax code       : ${co.tax_code}`);
    console.log(`ℹ  Company ID     : ${co.id}`);
    console.log(`\n⚠️  WARNING: This will PERMANENTLY DELETE the company and ALL its data.`);
    console.log(`   Press Ctrl+C within 5 seconds to abort...`);
    await new Promise(r => setTimeout(r, 5000));
    console.log('   Proceeding with delete...\n');
  } else {
    // ── Test mode: create a throwaway company ───────────────────────────────
    companyId = require('crypto').randomUUID();
    const userId = (await db.query(`SELECT id FROM users LIMIT 1`)).rows[0]?.id;
    if (!userId) {
      console.error('❌ No users found in DB — cannot run test');
      await db.end();
      return;
    }
    console.log(`ℹ  Using userId: ${userId}`);
    console.log(`ℹ  Test companyId: ${companyId}`);

    await db.query('BEGIN');
    try {
      // Create company — use last 10 digits of timestamp as unique tax code
      const testTaxCode = String(Date.now()).slice(-10);
      await db.query(`
        INSERT INTO companies (id, name, tax_code, address)
        VALUES ($1, $2, $3, 'Test Address')
      `, [companyId, TEST_TAG, testTaxCode]);

      // Link to user
      await db.query(`
        INSERT INTO user_companies (user_id, company_id, role) VALUES ($1, $2, 'OWNER')
      `, [userId, companyId]);

      // Insert into every NO-ACTION FK table found
      for (const { child_table, fk_column } of noAction) {
        try {
          await db.query(
            `INSERT INTO ${child_table} (${fk_column}) VALUES ($1)`,
            [companyId]
          );
          console.log(`   ✅ Seeded row in ${child_table}`);
        } catch (e) {
          // Table may have NOT NULL columns — try with minimal required fields using a direct check
          console.log(`   ⚠️  Could not seed ${child_table} (${e.message.slice(0, 80)})`);
        }
      }

      await db.query('COMMIT');
      console.log(`\n✅ Test company created: ${companyId}`);
    } catch (e) {
      await db.query('ROLLBACK');
      console.error('❌ Failed to create test company:', e.message);
      await db.end();
      return;
    }
  }

  // ─── Step 3: Run delete sequence from companies.ts ───────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('STEP 3: Run delete sequence (same as companies.ts handler)');
  console.log('═══════════════════════════════════════════════════════════');

  const deleteSteps = [
    { name: 'gdt_bot_runs',        sql: 'DELETE FROM gdt_bot_runs      WHERE company_id = $1' },
    { name: 'import_temp_files',   sql: 'DELETE FROM import_temp_files WHERE company_id = $1' },
    { name: 'bot_failed_jobs',     sql: 'DELETE FROM bot_failed_jobs   WHERE company_id = $1' },
    { name: 'audit_logs',          sql: 'DELETE FROM audit_logs        WHERE company_id = $1' },
    { name: 'gdt_validation_queue (via invoices)', sql: `
        DELETE FROM gdt_validation_queue
        WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)
      ` },
    { name: 'companies (final)',   sql: 'DELETE FROM companies WHERE id = $1' },
  ];

  let failed = false;
  let failTable = '';

  const txClient = new Client({ connectionString: DB_URL });
  await txClient.connect();
  await txClient.query('BEGIN');

  for (const step of deleteSteps) {
    try {
      const r = await txClient.query(step.sql, [companyId]);
      console.log(`   ✅ ${step.name}: ${r.rowCount} row(s) deleted`);
    } catch (e) {
      console.error(`\n   ❌ FAILED at step: ${step.name}`);
      console.error(`      PG code   : ${e.code}`);
      console.error(`      constraint: ${e.constraint}`);
      console.error(`      table     : ${e.table}`);
      console.error(`      detail    : ${e.detail}`);
      console.error(`      message   : ${e.message}`);
      failed = true;
      failTable = step.name;
      break;
    }
  }

  if (failed) {
    await txClient.query('ROLLBACK');
    console.log('\n⚠️  Transaction rolled back due to error above');
    console.log(`\n🔍 Checking which tables still reference company ${companyId}:`);

    // Check all tables with company_id to see which has rows
    const checkTables = noAction.map(r => r.child_table).concat(withCascade.map(r => r.child_table));
    for (const tbl of [...new Set(checkTables)]) {
      try {
        const check = await db.query(`SELECT COUNT(*) FROM ${tbl} WHERE company_id = $1`, [companyId]);
        if (check.rows[0].count > 0) {
          console.log(`   🔴 ${tbl}: ${check.rows[0].count} row(s) remaining`);
        }
      } catch { /* table may not have company_id */ }
    }
  } else {
    await txClient.query('COMMIT');
    console.log('\n✅ All steps succeeded — delete sequence is CORRECT');
  }

  await txClient.end();

  // Cleanup if still exists (in case of rollback) — only for test companies
  if (!isRealCompany) {
    try {
      await db.query('DELETE FROM audit_logs WHERE company_id = $1', [companyId]);
      await db.query('DELETE FROM gdt_bot_runs WHERE company_id = $1', [companyId]);
      await db.query('DELETE FROM bot_failed_jobs WHERE company_id = $1', [companyId]);
      await db.query('DELETE FROM companies WHERE id = $1', [companyId]);
      console.log('\n🧹 Cleanup done (test company removed)');
    } catch { /* already deleted */ }
  }

  // ─── Step 4: Summary ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  if (failed) {
    console.log('🚨 RESULT: DELETE FAILED at step: ' + failTable);
    if (MISSING_FROM_HANDLER.length > 0) {
      console.log('💡 FIX NEEDED: Add these tables to delete handler in companies.ts:');
      MISSING_FROM_HANDLER.forEach(r =>
        console.log(`   await client.query('DELETE FROM ${r.child_table} WHERE ${r.fk_column} = $1', [companyId]);`)
      );
    }
  } else {
    console.log('✅ RESULT: Delete sequence is CORRECT — all steps pass');
    console.log('💡 If production still fails, check: build was deployed AND pm2 restarted');
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  await db.end();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
