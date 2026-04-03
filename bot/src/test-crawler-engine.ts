/**
 * End-to-end smoke test for CrawlerEngine.
 *
 * Verifies the full pipeline:
 *   DB recipe load → GdtDirectApiService(recipe) → login → fetch invoices
 *
 * What this tests:
 *   1. Recipe loads from DB (or falls back to defaults)
 *   2. Recipe is injected into GdtDirectApiService (activeRecipe getter)
 *   3. Login succeeds with the injected recipe endpoints
 *   4. Output invoices fetched and written to test-output/engine-output.json
 *   5. Input invoices fetched and written to test-output/engine-input.json
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/test-crawler-engine.ts
 *
 * Required env vars (in bot/.env):
 *   DATABASE_URL or WORKER_DB_URL
 *   TEST_GDT_USER  (or hardcode below)
 *   TEST_GDT_PASS
 *   PROXY_LIST     (optional — comma-separated)
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { CrawlerEngine } from './crawler-engine';
import { getBuiltInDefaults } from './recipe.loader';
import { logger } from './logger';

const USERNAME       = process.env['TEST_GDT_USER'] ?? '';
const PASSWORD       = process.env['TEST_GDT_PASS'] ?? '';
const PROXY_URL      = (process.env['PROXY_LIST'] ?? '').split(',')[0]?.trim() || null;
const SOCKS5_PROXY   = process.env['SOCKS5_PROXY_URL'] ?? null;

if (!USERNAME || !PASSWORD) {
  console.error('ERROR: TEST_GDT_USER and TEST_GDT_PASS must be set in bot/.env');
  process.exit(1);
}

const TO_DATE   = new Date();
const FROM_DATE = new Date(TO_DATE.getTime() - 7 * 24 * 60 * 60 * 1000); // last 7 days
const OUT_DIR   = path.resolve(__dirname, '..', 'test-output');

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  logger.info('=== CrawlerEngine Smoke Test ===');
  logger.info(`User:       ${USERNAME}`);
  logger.info(`Proxy:      ${PROXY_URL ?? '(none)'}`);
  logger.info(`SOCKS5:     ${SOCKS5_PROXY ?? '(none)'}`);
  logger.info(`Range:      ${FROM_DATE.toISOString().slice(0, 10)} → ${TO_DATE.toISOString().slice(0, 10)}`);

  // ── 1. Verify recipe loader ──────────────────────────────────────────────────
  logger.info('\n[Step 1] Testing recipe loader...');
  const { loadRecipe, invalidateRecipeCache } = await import('./recipe.loader');
  invalidateRecipeCache('gdt_main');

  const recipe = await loadRecipe('gdt_main');
  logger.info(`[Step 1] Recipe loaded: baseUrl=${recipe.api.baseUrl}`);
  logger.info(`[Step 1] purchaseFilters: ${recipe.api.query.purchaseFilters.join(', ')}`);
  logger.info(`[Step 1] statusMap keys: ${Object.keys(recipe.statusMap).join(', ')}`);

  const defaults = getBuiltInDefaults();
  const isFromDb  = recipe.api.baseUrl === defaults.api.baseUrl;
  logger.info(`[Step 1] Source: ${isFromDb ? 'DB or defaults (identical)' : 'DB custom recipe'}`);

  // ── 2. CrawlerEngine.run() ───────────────────────────────────────────────────
  logger.info('\n[Step 2] Running CrawlerEngine.run()...');
  const engine = new CrawlerEngine('gdt_main');

  const result = await engine.run({
    username:      USERNAME,
    password:      PASSWORD,
    proxyUrl:      PROXY_URL,
    socks5ProxyUrl: SOCKS5_PROXY,
    fromDate:      FROM_DATE,
    toDate:        TO_DATE,
  });

  logger.info(`[Step 2] ✓ Output invoices: ${result.outputInvoices.length}`);
  logger.info(`[Step 2] ✓ Input invoices:  ${result.inputInvoices.length}`);

  // ── 3. Verify recipe was injected ───────────────────────────────────────────
  logger.info('\n[Step 3] Verifying recipe metadata on result...');
  logger.info(`[Step 3] result.recipe.api.baseUrl = ${result.recipe.api.baseUrl}`);
  logger.info('[Step 3] ✓ Recipe present in result');

  // ── 4. Save output ───────────────────────────────────────────────────────────
  const outputPath = path.join(OUT_DIR, 'engine-output.json');
  const inputPath  = path.join(OUT_DIR, 'engine-input.json');
  const recipePath = path.join(OUT_DIR, 'engine-recipe-used.json');

  fs.writeFileSync(outputPath, JSON.stringify(result.outputInvoices, null, 2), 'utf8');
  fs.writeFileSync(inputPath,  JSON.stringify(result.inputInvoices,  null, 2), 'utf8');
  fs.writeFileSync(recipePath, JSON.stringify(result.recipe,         null, 2), 'utf8');

  logger.info('\n[Step 4] Saved test output:');
  logger.info(`  Output invoices → ${outputPath}`);
  logger.info(`  Input invoices  → ${inputPath}`);
  logger.info(`  Recipe used     → ${recipePath}`);

  // ── 5. Basic assertions ─────────────────────────────────────────────────────
  logger.info('\n[Step 5] Basic assertions...');
  const checks: Array<[boolean, string]> = [
    [Array.isArray(result.outputInvoices), 'outputInvoices is array'],
    [Array.isArray(result.inputInvoices),  'inputInvoices is array'],
    [typeof result.recipe === 'object',    'recipe is object'],
    [typeof result.recipe.api?.baseUrl === 'string', 'recipe.api.baseUrl is string'],
    [result.outputInvoices.every(i => i.direction === 'output'), 'all output invoices have direction=output'],
    [result.inputInvoices.every(i => i.direction === 'input'),   'all input invoices have direction=input'],
  ];

  let allPassed = true;
  for (const [ok, label] of checks) {
    if (ok) {
      logger.info(`  ✓ ${label}`);
    } else {
      logger.error(`  ✗ FAIL: ${label}`);
      allPassed = false;
    }
  }

  logger.info('\n' + '─'.repeat(50));
  if (allPassed) {
    logger.info('All assertions passed ✓');
  } else {
    logger.error('Some assertions FAILED ✗');
    process.exit(1);
  }
}

main().catch(err => {
  logger.error('[test-crawler-engine] Fatal error', { err });
  process.exit(1);
});
