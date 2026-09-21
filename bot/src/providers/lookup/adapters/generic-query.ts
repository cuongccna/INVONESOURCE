/**
 * Adapter TỔNG QUÁT — mô tả bằng dữ liệu, không cần viết mã cho từng nhà cung cấp.
 *
 * Phần lớn cổng tra cứu HĐĐT đều cùng một khuôn: gọi một URL kèm mã tra cứu (và thường
 * là MST người bán), rồi hoặc trả thẳng PDF, hoặc trả JSON chứa link tải PDF. Adapter này
 * nhận khuôn đó từ bảng einvoice_providers, nên thêm một nhà cung cấp mới = thêm MỘT DÒNG
 * trong database, không phải deploy lại.
 *
 * Cấu hình nằm ở các cột:
 *   lookup_api_base     https://tracuu.example.vn
 *   lookup_api_path     /api/invoice/download
 *   lookup_api_params   {"code":"{code}","mst":"{mst}","type":"PDF"}
 *   lookup_response     'pdf'          → thân phản hồi chính là PDF
 *                       'json-file-url'→ JSON, lấy link ở lookup_file_url_field rồi tải tiếp
 *   lookup_file_url_field  'fileURL' hoặc 'data.url' (hỗ trợ đường dẫn lồng nhau)
 *
 * Chỗ thay thế cho phép: {code} {mst} {serial} {no}
 *
 * Vì cấu hình do người vận hành nhập, adapter này luôn mang status 'unverified' —
 * runner sẽ chỉ chạy khi dòng đó được bật tường minh trong DB.
 */
import { assertPdf } from '../http';
import { LookupAdapter, LookupHttp, LookupInputError, LookupRequest } from '../types';

export interface GenericLookupConfig {
  providerName:   string;
  apiBase:        string;
  apiPath:        string;
  params:         Record<string, string>;
  responseKind:   'pdf' | 'json-file-url';
  fileUrlField:   string | null;
  requiresCode:   boolean;
}

/** Thay {code} {mst} {serial} {no} bằng dữ liệu hoá đơn */
function fill(template: string, req: LookupRequest): string {
  return template
    .replace(/\{code\}/g,   (req.lookupCode    ?? '').trim())
    .replace(/\{mst\}/g,    (req.sellerTaxCode ?? '').trim())
    .replace(/\{serial\}/g, (req.serial        ?? '').trim())
    .replace(/\{no\}/g,     (req.invoiceNumber ?? '').trim());
}

/** Đọc giá trị theo đường dẫn lồng nhau kiểu "data.file.url" */
function pick(obj: unknown, path: string): string | null {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : null;
}

export function createGenericAdapter(cfg: GenericLookupConfig): LookupAdapter {
  const base = cfg.apiBase.replace(/\/+$/, '');
  const path = cfg.apiPath.startsWith('/') ? cfg.apiPath : `/${cfg.apiPath}`;

  return {
    id:     'generic-query',
    name:   cfg.providerName,
    status: 'unverified',
    requiresLookupCode: cfg.requiresCode,

    async fetchPdf(req, http: LookupHttp) {
      if (cfg.requiresCode && !(req.lookupCode ?? '').trim()) {
        throw new LookupInputError('Hoá đơn không có mã tra cứu trong XML');
      }

      const qs = Object.entries(cfg.params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(fill(v, req))}`)
        .join('&');
      const url = `${base}${path}${qs ? `?${qs}` : ''}`;

      if (cfg.responseKind === 'pdf') {
        return { kind: 'pdf', data: assertPdf(await http.getBinary(url), `Cổng ${cfg.providerName}`) };
      }

      const json = await http.getJson<unknown>(url);
      const field = cfg.fileUrlField ?? 'fileURL';
      const fileUrl = pick(json, field);
      if (!fileUrl) {
        throw new Error(`Cổng ${cfg.providerName} không trả về trường "${field}" chứa link PDF`);
      }
      const abs = /^https?:\/\//i.test(fileUrl) ? fileUrl : `${base}${fileUrl}`;
      return { kind: 'pdf', data: assertPdf(await http.getBinary(abs), `Cổng ${cfg.providerName}`) };
    },
  };
}
