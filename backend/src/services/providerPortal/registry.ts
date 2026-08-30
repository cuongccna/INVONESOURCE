/**
 * Registry driver cổng tra cứu — ghép nhà cung cấp của hoá đơn với driver tương ứng.
 *
 * Cấu hình nằm trong bảng einvoice_providers (cùng bộ cột mà plugin nền của bot dùng), cache
 * 60 giây trong tiến trình. Nhờ vậy bật/tắt một nhà cung cấp, đổi base URL hay thêm nhà cung
 * cấp mới chỉ cần một câu UPDATE — không phải deploy, và một cấu hình sai cũng không có
 * đường nào làm gãy API.
 *
 * Nhận diện nhà cung cấp theo đúng thứ tự đáng tin:
 *   1. MSTTCGP  — MST tổ chức cung cấp giải pháp, chính là bên có cổng tra cứu
 *   2. tvandnkntt — tổ chức T-VAN, chỉ dùng khi XML không có MSTTCGP
 *   3. tên miền của link tra cứu in trong hoá đơn
 */
import { pool } from '../../db/pool';
import { createXcyberDriver } from './drivers/xcyber';
import { createMinvoiceDriver } from './drivers/minvoice';
import { vietInvoiceDriver } from './drivers/vietinvoice';
import { easyInvoiceDriver } from './drivers/easyinvoice';
import { efyDriver } from './drivers/efy';
import { viettelTelecomDriver } from './drivers/viettel-telecom';
import { createVnptDriver } from './drivers/vnpt';
import type { PortalDriver } from './types';

const CACHE_TTL_MS = 60_000;

export interface PortalConfigRow {
  taxCode:    string;
  name:       string;
  adapterId:  string | null;
  enabled:    boolean;
  apiBase:    string | null;
  portalUrl:  string | null;
  domain:     string | null;
}

let cache: { at: number; byTaxCode: Map<string, PortalConfigRow>; byDomain: Map<string, PortalConfigRow> } | null = null;

/** Đọc danh bạ nhà cung cấp; lỗi DB → trả rỗng, KHÔNG ném (mất tính năng, không mất API) */
async function load(): Promise<NonNullable<typeof cache>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;

  const byTaxCode = new Map<string, PortalConfigRow>();
  const byDomain  = new Map<string, PortalConfigRow>();
  try {
    // portal_domain_aliases là cột của migration 070. Chưa chạy migration thì vẫn phải
    // chạy được với tên miền chính, thay vì tắt câm cả tính năng.
    const res = await pool.query<{
      tax_code: string; name: string; short_name: string | null;
      lookup_adapter: string | null; lookup_enabled: boolean | null;
      lookup_api_base: string | null; portal_url: string | null; portal_domain: string | null;
      portal_domain_aliases: string[] | null;
    }>(
      `SELECT tax_code, name, short_name, lookup_adapter, lookup_enabled,
              lookup_api_base, portal_url, portal_domain,
              to_jsonb(p) -> 'portal_domain_aliases' AS portal_domain_aliases
         FROM einvoice_providers p`,
    );
    for (const r of res.rows) {
      const row: PortalConfigRow = {
        taxCode:   r.tax_code,
        name:      r.short_name ?? r.name,
        adapterId: r.lookup_adapter,
        enabled:   r.lookup_enabled === true,
        apiBase:   r.lookup_api_base,
        portalUrl: r.portal_url,
        domain:    r.portal_domain,
      };
      byTaxCode.set(r.tax_code, row);
      const aliases = Array.isArray(r.portal_domain_aliases) ? r.portal_domain_aliases : [];
      for (const d of [r.portal_domain, ...aliases]) {
        if (typeof d === 'string' && d.trim()) byDomain.set(d.trim().toLowerCase(), row);
      }
    }
  } catch {
    return { at: Date.now(), byTaxCode, byDomain };
  }
  cache = { at: Date.now(), byTaxCode, byDomain };
  return cache;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Tìm dòng danh bạ ứng với hoá đơn theo MSTTCGP → T-VAN → tên miền link tra cứu */
export async function resolvePortalConfig(keys: {
  solutionTaxCode: string | null;
  tvanTaxCode:     string | null;
  lookupUrl:       string | null;
  /** MST người bán — dùng để chọn đúng máy chủ khi nền tảng chia theo từng thương hiệu */
  sellerTaxCode?:  string | null;
}): Promise<PortalConfigRow | null> {
  const { byTaxCode, byDomain } = await load();

  let found: PortalConfigRow | null = null;
  for (const mst of [keys.solutionTaxCode, keys.tvanTaxCode]) {
    const hit = mst ? byTaxCode.get(mst.trim()) : undefined;
    if (hit) { found = hit; break; }
  }
  if (!found) {
    const host = hostOf(keys.lookupUrl);
    if (host) {
      found = byDomain.get(host) ?? null;
      // Cổng RIÊNG THEO TỪNG TÀI KHOẢN — ngày càng phổ biến:
      //   VNPT        https://1800546671-tt78.vnpt-invoice.com.vn
      //   EasyInvoice http://0105987432hd.easyinvoice.com.vn
      // Khớp theo tên miền cha, và lấy tên miền cha DÀI NHẤT để không vơ nhầm sang nhà
      // cung cấp khác khi hai bên cùng chạy dưới một tên miền gốc.
      if (!found) {
        let bestLen = 0;
        for (const [domain, row] of byDomain) {
          if (host.endsWith(`.${domain}`) && domain.length > bestLen) {
            found = row;
            bestLen = domain.length;
          }
        }
      }
    }
  }
  return found ? preferSellerInstance(found, keys.sellerTaxCode, byTaxCode) : null;
}

/**
 * Chọn đúng MÁY CHỦ khi một nền tảng chạy nhiều bản riêng cho từng thương hiệu.
 *
 * Vì sao cần: MSTTCGP trong hoá đơn ghi bên SỞ HỮU NỀN TẢNG, không phải bên vận hành máy
 * chủ chứa hoá đơn. Đã gặp thật trên dữ liệu PRD: hoá đơn của CÔNG TY CỔ PHẦN NEWCA ghi
 * MSTTCGP 0105232093 (CyberLotus) nhưng dữ liệu nằm trên mspapp.xcyber.vn của NewCA —
 * tra vào máy chủ của CyberLotus thì báo không có. Nền tảng M-Invoice cũng vậy: mỗi đại lý
 * (NCCA…) một host riêng.
 *
 * Quy tắc hẹp và đúng: nếu CHÍNH NGƯỜI BÁN cũng nằm trong danh bạ và chạy CÙNG nền tảng,
 * thì hoá đơn do họ phát hành nằm trên máy chủ của họ. Người bán không phải nhà cung cấp
 * thì giữ nguyên máy chủ suy từ MSTTCGP.
 */
function preferSellerInstance(
  row: PortalConfigRow,
  sellerTaxCode: string | null | undefined,
  byTaxCode: Map<string, PortalConfigRow>,
): PortalConfigRow {
  const seller = (sellerTaxCode ?? '').trim().split('-')[0];
  if (!seller || seller === row.taxCode) return row;

  const sellerRow = byTaxCode.get(seller);
  if (!sellerRow || !sellerRow.enabled) return row;
  if (sellerRow.adapterId !== row.adapterId) return row;
  if (!sellerRow.apiBase) return row;

  return sellerRow;
}

/**
 * Dựng driver cho một dòng danh bạ.
 * Trả null khi: không có cấu hình, đang tắt, hoặc adapter không được hỗ trợ ở lớp này.
 */
export function buildDriver(row: PortalConfigRow | null): PortalDriver | null {
  if (!row || !row.adapterId || !row.enabled) return null;

  switch (row.adapterId) {
    case 'xcyber':          return createXcyberDriver(row.apiBase, row.name);
    case 'minvoice':        return createMinvoiceDriver(row.apiBase, row.name);
    case 'vietinvoice':     return vietInvoiceDriver;
    case 'easyinvoice':     return easyInvoiceDriver;
    case 'efy':             return efyDriver;
    case 'viettel-telecom': return viettelTelecomDriver;
    // Cổng cấp riêng theo từng tài khoản HĐĐT — địa chỉ thật lấy từ link trong hoá đơn,
    // lookup_api_base chỉ là đường lui.
    case 'vnpt':            return createVnptDriver(row.apiBase, row.name);
    // 'generic-query' là adapter chạy nền của bot, không có luồng tương tác ở đây
    default:                return null;
  }
}

/** Xoá cache danh bạ — gọi sau khi admin sửa cấu hình nhà cung cấp */
export function invalidatePortalConfigCache(): void {
  cache = null;
}
