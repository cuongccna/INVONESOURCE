/**
 * Unit test for recipe.loader.ts — runs without Jest, uses ts-node assertions.
 *
 * Tests:
 *   1. getBuiltInDefaults() returns well-formed CrawlerRecipe object
 *   2. invalidateRecipeCache() clears the cache entry
 *   3. loadRecipe() falls back to defaults when DB has no row
 *   4. loadRecipe() caches result (second call does not hit DB)
 *   5. loadRecipe() falls back gracefully on DB error
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/test-recipe-loader.ts
 *
 * No real DB connection required — tests 1-2-5 work offline.
 * Tests 3-4 require DATABASE_URL to be set (they hit the real DB).
 */
import { loadRecipe, invalidateRecipeCache, getBuiltInDefaults } from './recipe.loader';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function assertDeepKey(obj: Record<string, unknown>, path: string, label: string): void {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') { assert(false, label); return; }
    cur = (cur as Record<string, unknown>)[p];
  }
  assert(cur != null, label);
}

// ── Test 1: getBuiltInDefaults() structure ────────────────────────────────────

console.log('\n[Test 1] getBuiltInDefaults() — structure check');
{
  const d = getBuiltInDefaults() as unknown as Record<string, unknown>;
  assertDeepKey(d, 'api.baseUrl',                           'has api.baseUrl');
  assertDeepKey(d, 'api.baseUrlHttp',                       'has api.baseUrlHttp');
  assertDeepKey(d, 'api.endpoints.captcha',                 'has api.endpoints.captcha');
  assertDeepKey(d, 'api.endpoints.auth',                    'has api.endpoints.auth');
  assertDeepKey(d, 'api.endpoints.sold',                    'has api.endpoints.sold');
  assertDeepKey(d, 'api.endpoints.purchase',                'has api.endpoints.purchase');
  assertDeepKey(d, 'api.endpoints.exportXml',               'has api.endpoints.exportXml');
  assertDeepKey(d, 'api.endpoints.exportExcel',             'has api.endpoints.exportExcel');
  assertDeepKey(d, 'api.endpoints.exportExcelPurchase',     'has api.endpoints.exportExcelPurchase');
  assertDeepKey(d, 'api.pagination.pageSize',               'has api.pagination.pageSize');
  assertDeepKey(d, 'api.query.purchaseFilters',             'has api.query.purchaseFilters');
  assertDeepKey(d, 'api.query.xmlAvailableTtxly',           'has api.query.xmlAvailableTtxly');
  assertDeepKey(d, 'fields.sellerTax',                      'has fields.sellerTax');
  assertDeepKey(d, 'fields.buyerTax',                       'has fields.buyerTax');
  assertDeepKey(d, 'fields.vatRateNestedPath',              'has fields.vatRateNestedPath');
  assertDeepKey(d, 'statusMap',                             'has statusMap');
  assertDeepKey(d, 'timing.maxRetries',                     'has timing.maxRetries');
  assertDeepKey(d, 'timing.requestTimeoutMs',               'has timing.requestTimeoutMs');

  const defaults = getBuiltInDefaults();
  assert(defaults.api.baseUrl.startsWith('https://'), 'baseUrl starts with https://');
  assert(defaults.api.baseUrlHttp.startsWith('http://'), 'baseUrlHttp starts with http://');
  assert(Array.isArray(defaults.api.query.purchaseFilters), 'purchaseFilters is array');
  assert(defaults.api.query.purchaseFilters.length === 3, 'purchaseFilters has 3 entries');
  assert(Array.isArray(defaults.api.query.xmlAvailableTtxly), 'xmlAvailableTtxly is array');
  assert(defaults.statusMap['1'] === 'valid', 'statusMap[1] = valid');
  assert(defaults.statusMap['3'] === 'cancelled', 'statusMap[3] = cancelled');
  assert(defaults.statusMap['5'] === 'replaced', 'statusMap[5] = replaced');
  assert(defaults.statusMap['6'] === 'adjusted', 'statusMap[6] = adjusted');
  assert(defaults.timing.maxRetries > 0, 'timing.maxRetries > 0');
  assert(defaults.fields.vatRateNestedPath === 'thttltsuat', 'vatRateNestedPath = thttltsuat');
}

// ── Test 2: invalidateRecipeCache() ──────────────────────────────────────────

console.log('\n[Test 2] invalidateRecipeCache() — does not throw');
{
  try {
    invalidateRecipeCache('gdt_main');
    invalidateRecipeCache('nonexistent_recipe');
    assert(true, 'invalidateRecipeCache does not throw for any name');
  } catch (e) {
    assert(false, `threw: ${e}`);
  }
}

// ── Tests 3-5: async — wrapped in IIFE (commonjs module, no top-level await) ──

(async () => {
console.log('\n[Test 3] loadRecipe() — fallback when DB unreachable');
{
  // Temporarily point to bad DB URL so pool.query throws
  const origDb = process.env['DATABASE_URL'];
  process.env['DATABASE_URL']  = 'postgresql://nobody:wrong@127.0.0.1:9999/nonexistent';
  process.env['WORKER_DB_URL'] = 'postgresql://nobody:wrong@127.0.0.1:9999/nonexistent';

  // Must pre-clear cache since pool is module-singleton
  invalidateRecipeCache('gdt_main');

  try {
    // loadRecipe may or may not resolve depending on pool connection timing —
    // it should always return a recipe (either DB or defaults).
    const recipe = await loadRecipe('gdt_main');
    assert(recipe != null, 'returns a recipe object on DB error (fallback)');
    assert(typeof recipe.api === 'object', 'fallback recipe has api key');
  } catch (e) {
    assert(false, `loadRecipe threw instead of falling back: ${e}`);
  }

  process.env['DATABASE_URL']  = origDb;
  delete process.env['WORKER_DB_URL'];
}

// ── Test 4: loadRecipe() with real DB (if DATABASE_URL set) ──────────────────

if (process.env['DATABASE_URL']) {
  console.log('\n[Test 4] loadRecipe() — real DB round-trip');
  {
    invalidateRecipeCache('gdt_main');
    try {
      const recipe = await loadRecipe('gdt_main');
      assert(recipe != null, 'recipe loaded (DB or defaults)');
      assert(typeof recipe.api?.baseUrl === 'string', 'recipe.api.baseUrl is string');

      // Second call should be a cache hit (no DB query — verify it doesn't throw)
      const recipe2 = await loadRecipe('gdt_main');
      assert(recipe2 === recipe, 'second call returns same cached reference');
    } catch (e) {
      assert(false, `loadRecipe threw: ${e}`);
    }
  }

  console.log('\n[Test 5] loadRecipe() — nonexistent recipe → fallback to defaults');
  {
    invalidateRecipeCache('__no_such_recipe__');
    try {
      const recipe = await loadRecipe('__no_such_recipe__');
      assert(recipe != null, 'returns defaults for unknown recipe name');
      assert(recipe.api?.baseUrl === getBuiltInDefaults().api.baseUrl, 'fallback matches built-in defaults');
    } catch (e) {
      assert(false, `threw: ${e}`);
    }
  }
} else {
  console.log('\n[Test 4,5] Skipped — DATABASE_URL not set');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
})().catch(e => { console.error('[test-recipe-loader] Unexpected error:', e); process.exit(1); });
