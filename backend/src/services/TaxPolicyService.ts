/**
 * TaxPolicyService — tra tham số pháp lý theo KỲ TÍNH THUẾ
 *
 * Nguyên tắc: không hard-code con số của chính sách thuế trong mã nguồn.
 * Mỗi tham số có ngày hiệu lực; tính thuế cho kỳ nào thì tra theo ngày của kỳ đó,
 * nên tờ khai kỳ cũ vẫn tính đúng theo luật cũ sau khi chính sách thay đổi.
 *
 * Dữ liệu: bảng tax_policy_params và vat_reduction_policies (migration 062).
 */
import { pool } from '../db/pool';

export interface PolicyValue {
  value:      number;
  legalBasis: string;
  note:       string | null;
  from:       string;
}

export interface VatReductionPolicy {
  standardRate: number;
  reducedRate:  number;
  xmlBlockTag:  string;
  legalBasis:   string;
  note:         string | null;
  from:         string;
  to:           string;
}

/** Giá trị mặc định khi DB chưa có dữ liệu — luôn là mức MỚI NHẤT đã biết */
const FALLBACKS: Record<string, { value: number; legalBasis: string }> = {
  'vat.non_cash_payment_threshold': {
    value: 5_000_000,
    legalBasis: 'Luật Thuế GTGT 48/2024/QH15 (mặc định dự phòng)',
  },
  'hkd.revenue_exempt_threshold_year': {
    value: 500_000_000,
    legalBasis: 'Thông tư 152/2025/TT-BTC (mặc định dự phòng)',
  },
  'hkd.license_fee_applicable': {
    value: 0,
    legalBasis: 'Nghị quyết 198/2025/QH15 (mặc định dự phòng)',
  },
  'hkd.book_group_small_max':  { value: 500_000_000,   legalBasis: 'Thông tư 152/2025/TT-BTC' },
  'hkd.book_group_medium_max': { value: 3_000_000_000, legalBasis: 'Thông tư 152/2025/TT-BTC' },
};

/** Cache 5 phút — tham số pháp lý gần như không đổi trong phiên làm việc */
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: PolicyValue }>();

function periodDate(year: number, month: number): string {
  return `${year}-${String(Math.min(Math.max(month, 1), 12)).padStart(2, '0')}-01`;
}

export class TaxPolicyService {

  /**
   * Giá trị tham số áp dụng cho một ngày cụ thể (mặc định: hôm nay).
   * Trả kèm căn cứ pháp lý để hiển thị/ghi log — người dùng luôn biết số này từ đâu ra.
   */
  async get(paramKey: string, onDate?: Date | string): Promise<PolicyValue> {
    const date = typeof onDate === 'string'
      ? onDate
      : (onDate ?? new Date()).toISOString().slice(0, 10);

    const cacheKey = `${paramKey}@${date}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const { rows } = await pool.query<{
      num_value: string | null; legal_basis: string; note: string | null; effective_from: Date;
    }>(
      `SELECT num_value, legal_basis, note, effective_from
         FROM tax_policy_params
        WHERE param_key = $1
          AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC
        LIMIT 1`,
      [paramKey, date],
    );

    const row = rows[0];
    const result: PolicyValue = row
      ? {
          value:      Number(row.num_value ?? 0),
          legalBasis: row.legal_basis,
          note:       row.note,
          from:       row.effective_from.toISOString().slice(0, 10),
        }
      : {
          value:      FALLBACKS[paramKey]?.value ?? 0,
          legalBasis: FALLBACKS[paramKey]?.legalBasis ?? 'Chưa cấu hình trong tax_policy_params',
          note:       'Chưa có dữ liệu trong bảng tham số — đang dùng giá trị dự phòng',
          from:       date,
        };

    cache.set(cacheKey, { at: Date.now(), value: result });
    return result;
  }

  /** Tra theo kỳ tính thuế (tháng/quý) thay vì ngày */
  async getForPeriod(paramKey: string, year: number, month: number): Promise<PolicyValue> {
    return this.get(paramKey, periodDate(year, month));
  }

  /** Ngưỡng bắt buộc chứng từ thanh toán không dùng tiền mặt (F3) */
  async nonCashPaymentThreshold(year?: number, month?: number): Promise<PolicyValue> {
    return year && month
      ? this.getForPeriod('vat.non_cash_payment_threshold', year, month)
      : this.get('vat.non_cash_payment_threshold');
  }

  /**
   * Chính sách giảm thuế GTGT áp dụng cho kỳ (F5).
   * Trả null nếu kỳ đó không có chính sách giảm — khi ấy không xuất phụ lục.
   */
  async vatReduction(year: number, month: number, quarterly = false): Promise<VatReductionPolicy | null> {
    // Kỳ quý: lấy tháng đầu quý làm mốc tra
    const refMonth = quarterly ? (month - 1) * 3 + 1 : month;
    const date = periodDate(year, refMonth);

    const { rows } = await pool.query<{
      standard_rate: string; reduced_rate: string; xml_block_tag: string;
      legal_basis: string; note: string | null; effective_from: Date; effective_to: Date;
    }>(
      `SELECT standard_rate, reduced_rate, xml_block_tag, legal_basis, note, effective_from, effective_to
         FROM vat_reduction_policies
        WHERE effective_from <= $1::date AND effective_to >= $1::date
        ORDER BY effective_from DESC
        LIMIT 1`,
      [date],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      standardRate: Number(row.standard_rate),
      reducedRate:  Number(row.reduced_rate),
      xmlBlockTag:  row.xml_block_tag,
      legalBasis:   row.legal_basis,
      note:         row.note,
      from:         row.effective_from.toISOString().slice(0, 10),
      to:           row.effective_to.toISOString().slice(0, 10),
    };
  }

  /** Xoá cache khi admin sửa tham số */
  clearCache(): void {
    cache.clear();
  }
}

export const taxPolicyService = new TaxPolicyService();

/**
 * Trạng thái hoá đơn ĐƯỢC kê khai thuế — dùng chung cho tờ khai, bảng kê và đối chiếu (F2).
 *
 *   valid             — hoá đơn thường
 *   replaced          — hoá đơn thay thế (tthai=5): là hoá đơn có hiệu lực, phải kê khai
 *   adjusted          — hoá đơn điều chỉnh (tthai=6): làm thay đổi số liệu, phải kê khai
 *
 * KHÔNG gồm: cancelled (đã huỷ), replaced_original (bản gốc đã bị thay thế),
 * adjusted_original (bản gốc đã bị điều chỉnh), invalid.
 */
export const DECLARABLE_INVOICE_STATUSES = ['valid', 'replaced', 'adjusted'] as const;

/** Mệnh đề SQL dùng chung; truyền alias khi truy vấn có JOIN */
export function declarableStatusSql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return `${p}status IN ('valid', 'replaced', 'adjusted')`;
}
