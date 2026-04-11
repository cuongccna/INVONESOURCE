/**
 * HkdDeclarationEngine — tính thuế khoán quý cho Hộ Kinh Doanh / Cá Nhân KD.
 *
 * Thuế suất theo nhóm ngành TT40/2021/TT-BTC Phụ lục I:
 *   [28] Phân phối, cung cấp hàng hóa              → GTGT 1%, TNCN 0.5%
 *   [29] Dịch vụ, xây dựng không bao thầu NVL      → GTGT 5%, TNCN 2%
 *   [30] Sản xuất, vận tải, XD có bao thầu NVL     → GTGT 3%, TNCN 1.5%
 *   [31] Hoạt động kinh doanh khác                  → GTGT 2%, TNCN 1%
 *
 * ct28..ct31 trong XML = nhóm ngành, ct32 = tổng.
 * revenue_m1/m2/m3 = doanh thu theo từng tháng trong quý (dùng cho Excel/PDF).
 */
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

/** Thuế suất theo nhóm ngành TT40/2021 Phụ lục I */
export const INDUSTRY_GROUP_RATES: Record<number, { vat: number; pit: number; label: string }> = {
  28: { vat: 1.0,  pit: 0.5, label: 'Phân phối, cung cấp hàng hóa' },
  29: { vat: 5.0,  pit: 2.0, label: 'Dịch vụ, xây dựng không bao thầu NVL' },
  30: { vat: 3.0,  pit: 1.5, label: 'Sản xuất, vận tải, XD có bao thầu NVL' },
  31: { vat: 2.0,  pit: 1.0, label: 'Hoạt động kinh doanh khác' },
};

export interface HkdDeclaration {
  id: string;
  company_id: string;
  period_quarter: number;
  period_year: number;
  industry_group: number;
  revenue_m1: number;
  revenue_m2: number;
  revenue_m3: number;
  revenue_exempt: number;
  revenue_total: number;
  vat_rate: number;
  vat_m1: number;
  vat_m2: number;
  vat_m3: number;
  vat_total: number;
  pit_rate: number;
  pit_m1: number;
  pit_m2: number;
  pit_m3: number;
  pit_total: number;
  total_payable: number;
  xml_content: string | null;
  xml_generated_at: string | null;
  submission_status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export class HkdDeclarationEngine {
  /**
   * Tính và lưu tờ khai thuế khoán quý cho HKD.
   * @param companyId UUID công ty
   * @param quarter   1..4
   * @param year      năm kê khai
   * @param createdBy UUID người tạo (nullable)
   */
  async calculateQuarterlyDeclaration(
    companyId: string,
    quarter: number,
    year: number,
    createdBy?: string,
  ): Promise<HkdDeclaration> {
    // Tháng của quý: Q1=[1,2,3], Q2=[4,5,6], Q3=[7,8,9], Q4=[10,11,12]
    const m1 = (quarter - 1) * 3 + 1;
    const m2 = m1 + 1;
    const m3 = m1 + 2;

    // Lấy nhóm ngành HKD từ company settings
    const { rows: compRows } = await pool.query<{
      hkd_industry_group: string | null;
      vat_rate_hkd: string;
    }>(
      `SELECT COALESCE(hkd_industry_group, 28) AS hkd_industry_group,
              COALESCE(vat_rate_hkd, 1.0)      AS vat_rate_hkd
       FROM companies WHERE id = $1`,
      [companyId],
    );
    const industryGroup = Number(compRows[0]?.hkd_industry_group ?? 28);
    const rates = INDUSTRY_GROUP_RATES[industryGroup] ?? INDUSTRY_GROUP_RATES[28];
    const vatRate = rates.vat;
    const pitRate = rates.pit;

    // Doanh thu hóa đơn đầu ra hợp lệ, chia theo tháng.
    // Loại trừ: cancelled, replaced, adjusted + hóa đơn gốc đã bị thay thế (tc_hdon=1).
    const { rows: revRows } = await pool.query<{ month: string; revenue: string }>(
      `SELECT EXTRACT(MONTH FROM i.invoice_date)::int AS month,
              COALESCE(SUM(i.subtotal), 0)::bigint     AS revenue
       FROM invoices i
       WHERE i.company_id = $1
         AND i.direction  = 'output'
         AND i.status     = 'valid'
         AND i.deleted_at IS NULL
         AND EXTRACT(YEAR  FROM i.invoice_date) = $2
         AND EXTRACT(MONTH FROM i.invoice_date) = ANY($3::int[])
         AND NOT EXISTS (
           SELECT 1 FROM invoices _r
           WHERE _r.tc_hdon = 1
             AND _r.deleted_at IS NULL
             AND _r.company_id      = i.company_id
             AND _r.khhd_cl_quan    = i.serial_number
             AND _r.so_hd_cl_quan   = i.invoice_number
             AND COALESCE(_r.seller_tax_code, '') = COALESCE(i.seller_tax_code, '')
         )
       GROUP BY EXTRACT(MONTH FROM i.invoice_date)`,
      [companyId, year, [m1, m2, m3]],
    );

    const revMap: Record<number, number> = {};
    for (const r of revRows) revMap[Number(r.month)] = Number(r.revenue);

    const revenueM1 = revMap[m1] ?? 0;
    const revenueM2 = revMap[m2] ?? 0;
    const revenueM3 = revMap[m3] ?? 0;
    const revenueTotal = revenueM1 + revenueM2 + revenueM3;

    // Thuế GTGT = doanh thu × tỷ lệ VAT nhóm ngành
    const vatM1 = Math.round(revenueM1 * vatRate / 100);
    const vatM2 = Math.round(revenueM2 * vatRate / 100);
    const vatM3 = Math.round(revenueM3 * vatRate / 100);
    const vatTotal = vatM1 + vatM2 + vatM3;

    // Thuế TNCN = doanh thu × tỷ lệ TNCN nhóm ngành
    const pitM1 = Math.round(revenueM1 * pitRate / 100);
    const pitM2 = Math.round(revenueM2 * pitRate / 100);
    const pitM3 = Math.round(revenueM3 * pitRate / 100);
    const pitTotal = pitM1 + pitM2 + pitM3;

    const totalPayable = vatTotal + pitTotal;

    // Upsert vào hkd_declarations
    const id = uuidv4();
    await pool.query(
      `INSERT INTO hkd_declarations (
        id, company_id, period_quarter, period_year,
        industry_group,
        revenue_m1, revenue_m2, revenue_m3, revenue_exempt, revenue_total,
        vat_rate, pit_rate,
        vat_m1, vat_m2, vat_m3, vat_total,
        pit_m1, pit_m2, pit_m3, pit_total,
        total_payable,
        submission_status, created_by, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'draft',$21,NOW()
      )
      ON CONFLICT (company_id, period_quarter, period_year) DO UPDATE SET
        industry_group = EXCLUDED.industry_group,
        revenue_m1     = EXCLUDED.revenue_m1,
        revenue_m2     = EXCLUDED.revenue_m2,
        revenue_m3     = EXCLUDED.revenue_m3,
        revenue_total  = EXCLUDED.revenue_total,
        vat_rate       = EXCLUDED.vat_rate,
        pit_rate       = EXCLUDED.pit_rate,
        vat_m1         = EXCLUDED.vat_m1,
        vat_m2         = EXCLUDED.vat_m2,
        vat_m3         = EXCLUDED.vat_m3,
        vat_total      = EXCLUDED.vat_total,
        pit_m1         = EXCLUDED.pit_m1,
        pit_m2         = EXCLUDED.pit_m2,
        pit_m3         = EXCLUDED.pit_m3,
        pit_total      = EXCLUDED.pit_total,
        total_payable  = EXCLUDED.total_payable,
        submission_status = CASE
          WHEN hkd_declarations.submission_status IN ('submitted','accepted')
            THEN hkd_declarations.submission_status
          ELSE 'draft'
        END,
        updated_at = NOW()`,
      [
        id, companyId, quarter, year,
        industryGroup,
        revenueM1, revenueM2, revenueM3, revenueTotal,
        vatRate, pitRate,
        vatM1, vatM2, vatM3, vatTotal,
        pitM1, pitM2, pitM3, pitTotal,
        totalPayable,
        createdBy ?? null,
      ],
    );

    const { rows } = await pool.query<HkdDeclaration>(
      `SELECT * FROM hkd_declarations
       WHERE company_id = $1 AND period_quarter = $2 AND period_year = $3`,
      [companyId, quarter, year],
    );
    return rows[0]!;
  }
}
