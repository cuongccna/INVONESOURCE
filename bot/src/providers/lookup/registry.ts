/**
 * Registry plugin tra cứu — ghép MST tổ chức cung cấp giải pháp (MSTTCGP) với adapter.
 *
 * Cấu hình nằm trong bảng einvoice_providers, cache 60 giây trong tiến trình. Nhờ vậy
 * bật/tắt một nhà cung cấp, đổi base URL hay thêm nhà cung cấp mới chỉ cần sửa DB —
 * không phải deploy, và cũng không có đường nào để một cấu hình sai làm gãy worker.
 */
import { pool } from '../../db';
import { logger } from '../../logger';
import { vietInvoiceAdapter } from './adapters/vietinvoice';
import { createMinvoiceAdapter } from './adapters/minvoice';
import { createGenericAdapter, GenericLookupConfig } from './adapters/generic-query';
import { easyInvoiceAdapter } from './adapters/easyinvoice';
import type { LookupAdapter } from './types';

const CACHE_TTL_MS = 60_000;

export interface ProviderLookupConfig {
  taxCode:      string;
  name:         string;
  adapterId:    string;
  enabled:      boolean;
  apiBase:      string | null;
  apiPath:      string | null;
  params:       Record<string, string> | null;
  responseKind: string | null;
  fileUrlField: string | null;
}

let cache: { at: number; rows: Map<string, ProviderLookupConfig> } | null = null;

/** Đọc cấu hình plugin của mọi nhà cung cấp; lỗi DB → trả rỗng, KHÔNG ném */
export async function loadLookupConfigs(): Promise<Map<string, ProviderLookupConfig>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  const rows = new Map<string, ProviderLookupConfig>();
  try {
    const res = await pool.query<{
      tax_code: string; name: string; short_name: string | null;
      lookup_adapter: string | null; lookup_enabled: boolean;
      lookup_api_base: string | null; lookup_api_path: string | null;
      lookup_api_params: unknown; lookup_response: string | null;
      lookup_file_url_field: string | null;
    }>(
      `SELECT tax_code, name, short_name, lookup_adapter, COALESCE(lookup_enabled, false) AS lookup_enabled,
              lookup_api_base, lookup_api_path, lookup_api_params, lookup_response, lookup_file_url_field
         FROM einvoice_providers
        WHERE lookup_adapter IS NOT NULL`,
    );
    for (const r of res.rows) {
      rows.set(r.tax_code, {
        taxCode:      r.tax_code,
        name:         r.short_name ?? r.name,
        adapterId:    r.lookup_adapter!,
        enabled:      r.lookup_enabled,
        apiBase:      r.lookup_api_base,
        apiPath:      r.lookup_api_path,
        params:       toParams(r.lookup_api_params),
        responseKind: r.lookup_response,
        fileUrlField: r.lookup_file_url_field,
      });
    }
    cache = { at: Date.now(), rows };
  } catch (err) {
    logger.warn('[ProviderLookup] Không đọc được cấu hình plugin — bỏ qua chu kỳ này', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
  return rows;
}

function toParams(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Dựng adapter cho một MSTTCGP.
 * Trả null khi: không có cấu hình, đang tắt, hoặc cấu hình thiếu dữ liệu bắt buộc.
 */
export function buildAdapter(cfgRow: ProviderLookupConfig | undefined): LookupAdapter | null {
  if (!cfgRow || !cfgRow.enabled) return null;

  switch (cfgRow.adapterId) {
    case 'vietinvoice':
      return vietInvoiceAdapter;

    case 'minvoice':
      return createMinvoiceAdapter(cfgRow.apiBase);

    case 'easyinvoice':
      return easyInvoiceAdapter;

    case 'generic-query': {
      if (!cfgRow.apiBase || !cfgRow.apiPath || !cfgRow.params) {
        logger.warn('[ProviderLookup] Cấu hình generic-query thiếu base/path/params — bỏ qua', {
          taxCode: cfgRow.taxCode,
        });
        return null;
      }
      const generic: GenericLookupConfig = {
        providerName: cfgRow.name,
        apiBase:      cfgRow.apiBase,
        apiPath:      cfgRow.apiPath,
        params:       cfgRow.params,
        responseKind: cfgRow.responseKind === 'pdf' ? 'pdf' : 'json-file-url',
        fileUrlField: cfgRow.fileUrlField,
        requiresCode: true,
      };
      return createGenericAdapter(generic);
    }

    // Các cổng dưới đây được tra ngay trên giao diện (backend/src/services/providerPortal)
    // vì phải có người nhìn ảnh mã xác thực, hoặc vì chỉ chạy khi người dùng yêu cầu.
    // Bot bỏ qua trong im lặng — không phải cấu hình sai.
    case 'xcyber':
    case 'efy':
    case 'viettel-telecom':
      return null;

    default:
      logger.warn('[ProviderLookup] Không biết adapter này — bỏ qua', {
        adapter: cfgRow.adapterId, taxCode: cfgRow.taxCode,
      });
      return null;
  }
}

/** Xoá cache cấu hình — gọi sau khi admin sửa danh bạ */
export function invalidateLookupConfigCache(): void {
  cache = null;
}
