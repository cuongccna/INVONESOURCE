/**
 * AmendedInvoiceRouter — P50.2
 *
 * Detects and routes replacement / adjustment invoices that span different
 * declaration periods — a common source of incorrect VAT submissions.
 *
 * Rules (NĐ70/2025):
 *  - Replacement (thay thế):  kê khai bổ sung kỳ của HĐ gốc
 *  - Adjustment (điều chỉnh): kê phần chênh lệch vào kỳ của HĐ điều chỉnh
 */
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

export type RoutingType =
  | 'same_period'
  | 'cross_period_replacement'
  | 'cross_period_adjustment'
  | 'user_confirmed';

export interface RoutingRule {
  type:                   RoutingType;
  action:                 string;
  declarationPeriod:      string; // 'YYYY-MM'
  requiresSupplemental:   boolean;
  supplementalInstructions?: string[];
  adjustmentNote?:        string;
}

export interface AmendmentAnalysis {
  invoiceId:           string;
  invoiceNumber:       string;
  relationType:        'replacement' | 'adjustment';
  invPeriod:           string;
  origPeriod:          string | null;
  isCrossPeriod:       boolean;
  rule:                RoutingRule;
}

export class AmendedInvoiceRouter {

  /**
   * Scan for unrouted replacement/adjustment invoices and persist routing decisions.
   */
  async analyzeAmendments(companyId: string): Promise<AmendmentAnalysis[]> {
    const amended = await pool.query<{
      id: string; invoice_number: string; invoice_date: Date;
      invoice_relation_type: string; related_invoice_number: string | null;
      related_invoice_period: string | null;
      related_date: Date | null; related_db_id: string | null;
      total_amount: string; vat_amount: string;
    }>(
      `SELECT i.id, i.invoice_number, i.invoice_date,
              i.invoice_relation_type, i.related_invoice_number, i.related_invoice_period,
              related.invoice_date  AS related_date,
              related.id            AS related_db_id
       FROM invoices i
       LEFT JOIN invoices related
         ON related.company_id = i.company_id
        AND related.invoice_number = i.related_invoice_number
        AND related.deleted_at IS NULL
       WHERE i.company_id = $1
         AND i.invoice_relation_type IN ('replacement','adjustment')
         AND i.deleted_at IS NULL
         AND (i.routing_decision IS NULL OR i.routing_decision = '')
       ORDER BY i.invoice_date DESC`,
      [companyId],
    );

    const analyses: AmendmentAnalysis[] = [];

    for (const inv of amended.rows) {
      const invPeriod = this.toPeriod(inv.invoice_date);
      const origPeriod = inv.related_date
        ? this.toPeriod(inv.related_date)
        : inv.related_invoice_period ?? null;

      const isCrossPeriod = !!origPeriod && origPeriod !== invPeriod;
      const relationType = inv.invoice_relation_type as 'replacement' | 'adjustment';

      const rule = this.buildRule(relationType, isCrossPeriod, invPeriod, origPeriod);

      await pool.query(
        `UPDATE invoices SET
           cross_period_flag               = $1,
           supplemental_declaration_needed = $2,
           routing_decision                = $3,
           related_invoice_period          = COALESCE(related_invoice_period, $4),
           updated_at                      = NOW()
         WHERE id = $5`,
        [isCrossPeriod, rule.requiresSupplemental, rule.type, origPeriod, inv.id],
      );

      analyses.push({
        invoiceId:     inv.id,
        invoiceNumber: inv.invoice_number,
        relationType,
        invPeriod,
        origPeriod,
        isCrossPeriod,
        rule,
      });
    }

    return analyses;
  }

  /**
   * Create or locate a draft supplemental declaration for the given original period.
   */
  async createSupplementalDraft(
    companyId: string,
    originalPeriod: string, // 'YYYY-MM'
    triggeredByInvoiceId: string,
  ): Promise<{ declarationId: string; isNew: boolean }> {
    const [yr, mo] = originalPeriod.split('-').map(Number) as [number, number];

    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM tax_declarations
       WHERE company_id=$1 AND period_month=$2 AND period_year=$3
         AND declaration_type='supplemental'
       ORDER BY created_at DESC LIMIT 1`,
      [companyId, mo, yr],
    );
    if (existing.rows.length > 0) {
      return { declarationId: existing.rows[0]!.id, isNew: false };
    }

    // Find original declaration to copy baseline values
    const original = await pool.query<{ id: string; form_version_id: string | null; field_values: string }>(
      `SELECT id, form_version_id, field_values
       FROM tax_declarations
       WHERE company_id=$1 AND period_month=$2 AND period_year=$3
         AND (declaration_type='initial' OR declaration_type IS NULL)
       ORDER BY created_at DESC LIMIT 1`,
      [companyId, mo, yr],
    );

    const newId = uuidv4();
    await pool.query(
      `INSERT INTO tax_declarations
         (id, company_id, form_version_id, period_month, period_year,
          declaration_type, submission_status, field_values, base_declaration_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,'supplemental','draft',$6,$7,NOW())`,
      [
        newId, companyId,
        original.rows[0]?.form_version_id ?? null,
        mo, yr,
        original.rows[0]?.field_values ?? '{}',
        original.rows[0]?.id ?? null,
      ],
    );

    return { declarationId: newId, isNew: true };
  }

  /** Mark an invoice's routing as user-confirmed. */
  async confirmRouting(invoiceId: string, companyId: string): Promise<void> {
    await pool.query(
      `UPDATE invoices SET routing_decision='user_confirmed', updated_at=NOW()
       WHERE id=$1 AND company_id=$2`,
      [invoiceId, companyId],
    );
  }

  /** Count unrouted cross-period amendments (used for declaration gate). */
  async countUnrouted(companyId: string, month: number, year: number): Promise<number> {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM invoices
       WHERE company_id=$1
         AND cross_period_flag=true
         AND (routing_decision IS NULL OR routing_decision='')
         AND EXTRACT(MONTH FROM invoice_date)=$2
         AND EXTRACT(YEAR  FROM invoice_date)=$3
         AND deleted_at IS NULL`,
      [companyId, month, year],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private toPeriod(date: Date | string): string {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  private buildRule(
    relationType: 'replacement' | 'adjustment',
    isCrossPeriod: boolean,
    invPeriod: string,
    origPeriod: string | null,
  ): RoutingRule {
    if (!isCrossPeriod || !origPeriod) {
      return {
        type: 'same_period',
        action: `Kê khai bình thường trên tờ khai kỳ ${invPeriod}`,
        declarationPeriod: invPeriod,
        requiresSupplemental: false,
      };
    }

    if (relationType === 'replacement') {
      return {
        type: 'cross_period_replacement',
        action: `HĐ thay thế phải kê trên tờ khai BỔ SUNG kỳ ${origPeriod}`,
        declarationPeriod: origPeriod,
        requiresSupplemental: true,
        supplementalInstructions: [
          `Bước 1: Lập tờ khai bổ sung cho kỳ ${origPeriod}`,
          `Bước 2: Xóa HĐ gốc khỏi bảng kê kỳ ${origPeriod}`,
          `Bước 3: Thêm HĐ thay thế này vào bảng kê kỳ ${origPeriod}`,
          `Bước 4: KHÔNG kê HĐ thay thế này trên tờ khai kỳ ${invPeriod}`,
        ],
      };
    }

    // adjustment
    return {
      type: 'cross_period_adjustment',
      action: `Kê phần chênh lệch trên tờ khai kỳ ${invPeriod} (kỳ phát sinh HĐ điều chỉnh)`,
      declarationPeriod: invPeriod,
      requiresSupplemental: false,
      adjustmentNote:
        'Chỉ kê phần giá trị chênh lệch tăng/giảm, KHÔNG kê toàn bộ giá trị HĐ điều chỉnh',
    };
  }
}

export const amendedInvoiceRouter = new AmendedInvoiceRouter();
