/**
 * Recipe Loader — reads CrawlerRecipe from the crawler_recipes DB table.
 *
 * Features:
 *  - 30-second TTL in-process cache (no Redis needed — bot is a single process).
 *  - Falls back to built-in defaults if DB is unreachable or recipe is missing.
 *  - invalidateRecipeCache() called by admin UI after a PUT /api/crawler-recipes/:name.
 */
import { pool } from './db';
import type { CrawlerRecipe, CrawlerRecipeRow } from './types/recipe.types';
import { logger } from './logger';

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  recipe:    CrawlerRecipe;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Load a recipe by name from the DB.
 * Returns cached copy if it is still within TTL.
 * Falls back to getBuiltInDefaults() on any error or missing row.
 */
export async function loadRecipe(name: string): Promise<CrawlerRecipe> {
  const cached = cache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    logger.debug('[RecipeLoader] Cache hit', { name });
    return cached.recipe;
  }

  try {
    const result = await pool.query<CrawlerRecipeRow>(
      'SELECT recipe FROM crawler_recipes WHERE name = $1 AND is_active = true LIMIT 1',
      [name],
    );

    if (result.rows.length === 0) {
      logger.warn('[RecipeLoader] Recipe not found in DB, using built-in defaults', { name });
      return getBuiltInDefaults();
    }

    const recipe = result.rows[0]!.recipe;
    cache.set(name, { recipe, expiresAt: Date.now() + CACHE_TTL_MS });
    logger.info('[RecipeLoader] Recipe loaded from DB', { name });
    return recipe;
  } catch (err) {
    logger.error('[RecipeLoader] DB error, using built-in defaults', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    return getBuiltInDefaults();
  }
}

/**
 * Force-expire the cached entry for a recipe.
 * Call this after an admin saves a new version so the next job picks it up immediately.
 */
export function invalidateRecipeCache(name: string): void {
  cache.delete(name);
  logger.debug('[RecipeLoader] Cache invalidated', { name });
}

/**
 * Built-in defaults — exact copy of the hardcoded constants in gdt-direct-api.service.ts.
 * This is the fallback when crawler_recipes DB table is empty or unreachable.
 */
export function getBuiltInDefaults(): CrawlerRecipe {
  return {
    api: {
      baseUrl:     'https://hoadondientu.gdt.gov.vn:30000',
      baseUrlHttp: 'http://hoadondientu.gdt.gov.vn:30000',
      endpoints: {
        captcha:             '/captcha',
        auth:                '/security-taxpayer/authenticate',
        sold:                '/query/invoices/sold',
        purchase:            '/query/invoices/purchase',
        exportXml:           '/query/invoices/export-xml',
        exportExcel:         '/query/invoices/export-excel',
        exportExcelPurchase: '/query/invoices/export-excel-sold',
      },
      pagination: {
        pageSize:    50,
        zeroBased:   true,
        totalHeader: 'X-Total-Count',
      },
      query: {
        purchaseFilters:   ['ttxly==5', 'ttxly==6', 'ttxly==8'],
        xmlAvailableTtxly: [5],
      },
    },
    fields: {
      status:            ['tthai', 'ttxly', 'tthdon', 'trangThai', 'status'],
      sellerTax:         ['nbmst', 'msttcgpbh', 'mst_ban', 'msttcgp_ban', 'mstNguoiBan'],
      sellerName:        ['nbten', 'tenbh', 'ten_ban', 'tenNguoiBan', 'nguoiBanHang'],
      buyerTax:          ['nmmst', 'mnmst', 'mst_mua', 'mstnmua', 'mstNguoiMua'],
      buyerName:         ['nmten', 'tenn', 'ten_mua', 'tenNguoiMua', 'nguoiMuaHang'],
      invoiceNum:        ['shdon', 'soHoaDon', 'so_hd', 'ma_hd'],
      serial:            ['khhdon', 'kyHieuHoaDon', 'ky_hieu_hd'],
      date:              ['tdlap', 'ngayLap', 'ngay_lap'],
      subtotal:          ['tgtcthue', 'tien_chua_thue', 'tienHangChuaThue'],
      vatAmount:         ['tgtthue', 'tien_thue', 'tienThue'],
      total:             ['tgtttbso', 'thanh_toan', 'tongThanhToan', 'tongTien'],
      vatRate:           ['tsuat', 'thueSuat', 'thue_suat'],
      vatRateNestedPath: 'thttltsuat',
      invoiceType:       ['thdon', 'loaiHD', 'loai_hd', 'la'],
    },
    statusMap: {
      '1': 'valid',
      '3': 'cancelled',
      '5': 'replaced',
      '6': 'adjusted',
    },
    timing: {
      maxRetries:       3,
      retryDelayMs:     3_000,
      requestTimeoutMs: 30_000,
      binaryTimeoutMs:  60_000,
    },
  };
}
