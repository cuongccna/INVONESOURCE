/**
 * HkdDeclarationEngine — tính thuế khoán quý cho Hộ Kinh Doanh / Cá Nhân KD.
 *
 * Thuế suất GTGT: lấy từ companies.vat_rate_hkd (mặc định 1%)
 * Thuế TNCN: cố định 0.5% doanh thu
 *
 * Doanh thu chia theo từng tháng trong quý để khớp XML TT40/2021
 * (ct28 = tháng 1, ct29 = tháng 2, ct30 = tháng 3 trong quý).
 */
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

export interface HkdDeclaration {
  id: string;
  company_id: string;
  period_quarter: number;
  period_year: number;
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

    // Doanh thu hóa đơn đầu ra hợp lệ, chia theo tháng
    const { rows: revRows } = await pool.query<{ month: string; revenue: string }>(
      `SELECT EXTRACT(MONTH FROM invoice_date)::int AS month,
              COALESCE(SUM(subtotal), 0)::bigint     AS revenue
       FROM invoices
       WHERE company_id = $1
         AND direction  = 'output'
         AND status     = 'valid'
         AND deleted_at IS NULL
         AND EXTRACT(YEAR  FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
       GROUP BY EXTRACT(MONTH FROM invoice_date)`,
      [companyId, year, [m1, m2, m3]],
    );

    const revMap: Record<number, number> = {};
    for (const r of revRows) revMap[Number(r.month)] = Number(r.revenue);

    const revenueM1 = revMap[m1] ?? 0;
    const revenueM2 = revMap[m2] ?? 0;
    const revenueM3 = revMap[m3] ?? 0;
    const revenueTotal = revenueM1 + revenueM2 + revenueM3;

    // Tỷ lệ VAT khoán từ company settings
    const { rows: compRows } = await pool.query<{ vat_rate_hkd: string }>(
      `SELECT COALESCE(vat_rate_hkd, 1.0) AS vat_rate_hkd FROM companies WHERE id = $1`,
      [companyId],
    );
    const vatRate = Number(compRows[0]?.vat_rate_hkd ?? 1.0);

    // Thuế GTGT = doanh thu × tỷ lệ VAT
    const vatM1 = Math.round(revenueM1 * vatRate / 100);
    const vatM2 = Math.round(revenueM2 * vatRate / 100);
    const vatM3 = Math.round(revenueM3 * vatRate / 100);
    const vatTotal = vatM1 + vatM2 + vatM3;

    // Thuế TNCN = 0.5% doanh thu
    const pitM1 = Math.round(revenueM1 * 0.005);
    const pitM2 = Math.round(revenueM2 * 0.005);
    const pitM3 = Math.round(revenueM3 * 0.005);
    const pitTotal = pitM1 + pitM2 + pitM3;

    const totalPayable = vatTotal + pitTotal;

    // Upsert vào hkd_declarations
    const id = uuidv4();
    await pool.query(
      `INSERT INTO hkd_declarations (
        id, company_id, period_quarter, period_year,
        revenue_m1, revenue_m2, revenue_m3, revenue_exempt, revenue_total,
        vat_rate,
        vat_m1, vat_m2, vat_m3, vat_total,
        pit_m1, pit_m2, pit_m3, pit_total,
        total_payable,
        submission_status, created_by, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft',$19,NOW()
      )
      ON CONFLICT (company_id, period_quarter, period_year) DO UPDATE SET
        revenue_m1     = EXCLUDED.revenue_m1,
        revenue_m2     = EXCLUDED.revenue_m2,
        revenue_m3     = EXCLUDED.revenue_m3,
        revenue_total  = EXCLUDED.revenue_total,
        vat_rate       = EXCLUDED.vat_rate,
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
        revenueM1, revenueM2, revenueM3, revenueTotal,
        vatRate,
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
