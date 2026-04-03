/**
 * GhostCompanyDetector — GHOST-03
 *
 * Analyses all unique seller/buyer tax codes in a company's input invoices
 * and flags those that exhibit ghost-company characteristics.
 *
 * Runs after every sync (queued as background BullMQ job).
 * Results stored in company_risk_flags table.
 */
import { pool } from '../db/pool';
import { companyVerificationService, CompanyInfo } from './CompanyVerificationService';

export interface RiskFlag {
  code:        string;
  level:       'critical' | 'high' | 'medium' | 'low';
  message:     string;
  vat_at_risk?: number;
  details?:    Record<string, unknown>;
}

export class GhostCompanyDetector {

  /**
   * Analyse a single partner tax code against a company's invoice history.
   * Returns an array of detected risk flags (may be empty).
   */
  async analyzeCompany(
    companyId: string,
    partnerTaxCode: string,
    partnerType: 'seller' | 'buyer',
  ): Promise<RiskFlag[]> {
    const flags: RiskFlag[] = [];

    const info = await companyVerificationService.verify(partnerTaxCode);

    const col = partnerType === 'seller' ? 'seller_tax_code' : 'buyer_tax_code';
    const nameCol = partnerType === 'seller' ? 'seller_name' : 'buyer_name';

    const invRes = await pool.query<{
      id: string; invoice_date: Date; invoice_number: string; total_amount: string;
      vat_amount: string; seller_name: string; buyer_name: string;
    }>(
      `SELECT id, invoice_date, invoice_number, total_amount, vat_amount,
              seller_name, buyer_name
       FROM active_invoices
       WHERE company_id = $1 AND ${col} = $2
       ORDER BY invoice_date DESC`,
      [companyId, partnerTaxCode],
    );
    const invList = invRes.rows;
    const totalVatAtRisk = invList.reduce((s, i) => s + parseFloat(i.vat_amount ?? '0'), 0);

    // FLAG 1: MST không tồn tại
    if (info.mst_status === 'not_found') {
      flags.push({
        code: 'MST_NOT_FOUND',
        level: 'critical',
        message: `MST ${partnerTaxCode} không tồn tại trên hệ thống GDT`,
        vat_at_risk: totalVatAtRisk,
      });
    }

    // FLAG 2: MST đã giải thể — và vẫn còn HĐ sau ngày giải thể
    if (info.mst_status === 'dissolved') {
      const lastInv = invList[0];
      const dissolvedDate = info.dissolved_date ? new Date(info.dissolved_date) : null;
      if (lastInv && dissolvedDate && new Date(lastInv.invoice_date) > dissolvedDate) {
        flags.push({
          code: 'MST_DISSOLVED',
          level: 'critical',
          message: `${info.company_name ?? partnerTaxCode} đã giải thể từ ${dissolvedDate.toLocaleDateString('vi-VN')} nhưng vẫn xuất HĐ sau đó`,
          vat_at_risk: totalVatAtRisk,
          details: { dissolved_date: info.dissolved_date },
        });
      }
    }

    // FLAG 3: MST đang tạm ngừng
    if (info.mst_status === 'suspended') {
      flags.push({
        code: 'MST_SUSPENDED',
        level: 'high',
        message: `${info.company_name ?? partnerTaxCode} đang tạm ngừng hoạt động — HĐ có thể không hợp lệ để khấu trừ`,
        vat_at_risk: totalVatAtRisk,
      });
    }

    // FLAG 4: Tên trên HĐ không khớp với GDT (< 40% từ chung)
    if (info.company_name && invList.length > 0) {
      const invName = invList[0]![nameCol] ?? '';
      const similarity = companyVerificationService.compareNames(invName, info.company_name);
      if (invName && similarity < 0.4) {
        flags.push({
          code: 'NAME_MISMATCH',
          level: 'high',
          message: `Tên trên HĐ "${invName}" khác biệt với GDT "${info.company_name}" (chỉ ${Math.round(similarity * 100)}% trùng)`,
          details: { invoice_name: invName, gdt_name: info.company_name, similarity: Math.round(similarity * 100) + '%' },
        });
      }
    }

    // FLAG 5: DN mới (< 6 tháng) + HĐ lớn (> 50 triệu) — chỉ kiểm tra seller
    if (info.registered_date && partnerType === 'seller') {
      const monthsOld =
        (Date.now() - new Date(info.registered_date).getTime()) / (1000 * 60 * 60 * 24 * 30);
      const bigInvs = invList.filter(i => parseFloat(i.total_amount) > 50_000_000);
      if (monthsOld < 6 && bigInvs.length > 0) {
        flags.push({
          code: 'NEW_COMPANY_BIG_INV',
          level: 'high',
          message: `DN mới thành lập ${Math.round(monthsOld)} tháng nhưng có ${bigInvs.length} HĐ > 50 triệu VND`,
          details: { months_old: Math.round(monthsOld), big_invoice_count: bigInvs.length },
        });
      }
    }

    // FLAG 6: Nhiều HĐ nhỏ cùng ngày (tránh ngưỡng duyệt)
    const byDate: Record<string, number> = {};
    invList.forEach(i => {
      const d = new Date(i.invoice_date).toISOString().slice(0, 10);
      byDate[d] = (byDate[d] ?? 0) + 1;
    });
    const splitDays = Object.values(byDate).filter(count => count >= 3);
    if (splitDays.length > 0) {
      flags.push({
        code: 'SPLIT_INVOICE',
        level: 'medium',
        message: `Phát hiện ${splitDays.length} ngày có ≥3 HĐ từ cùng 1 đối tác — có thể chia nhỏ để tránh ngưỡng duyệt`,
        details: { affected_days: splitDays.length },
      });
    }

    // FLAG 7: Toàn bộ HĐ có số tiền tròn (>90% chia hết cho 1 triệu)
    if (invList.length >= 3) {
      const roundCount = invList.filter(i => {
        const amt = parseFloat(i.total_amount);
        return amt > 0 && amt % 1_000_000 === 0;
      }).length;
      if (roundCount / invList.length > 0.9) {
        flags.push({
          code: 'ROUND_AMOUNTS',
          level: 'medium',
          message: `${roundCount}/${invList.length} HĐ có số tiền tròn chính xác (triệu VND) — dấu hiệu bất thường`,
        });
      }
    }

    return flags;
  }

  /**
   * Scan all unique seller tax codes in a company's input invoices
   * and save any detected risk flags.  Rate-limited to 1 lookup/2s.
   */
  async runForCompany(companyId: string): Promise<{ scanned: number; flagged: number }> {
    const sellers = await pool.query<{
      seller_tax_code: string; seller_name: string; total_vat: string; invoice_count: string;
    }>(
      `SELECT seller_tax_code, seller_name,
              SUM(vat_amount)::text AS total_vat,
              COUNT(*)::text        AS invoice_count
       FROM active_invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND seller_tax_code IS NOT NULL
         AND seller_tax_code != 'B2C'
       GROUP BY seller_tax_code, seller_name
       HAVING SUM(vat_amount) > 0
       ORDER BY SUM(vat_amount) DESC`,
      [companyId],
    );

    let flagged = 0;
    for (const seller of sellers.rows) {
      await new Promise(r => setTimeout(r, 2_000)); // 1 req/2s
      try {
        const flags = await this.analyzeCompany(companyId, seller.seller_tax_code, 'seller');
        if (flags.length > 0) {
          await this.saveRiskFlags(
            companyId,
            seller.seller_tax_code,
            'seller',
            flags,
            parseFloat(seller.total_vat),
          );
          flagged++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[GhostDetector] Error analysing ${seller.seller_tax_code}: ${msg}`);
      }
    }

    return { scanned: sellers.rowCount ?? 0, flagged };
  }

  /**
   * Upsert risk flags into company_risk_flags.
   * Critical flags trigger a notification.
   */
  async saveRiskFlags(
    companyId: string,
    taxCode: string,
    partnerType: 'seller' | 'buyer',
    flags: RiskFlag[],
    totalVatAtRisk: number,
  ): Promise<void> {
    const maxLevel = flags.some(f => f.level === 'critical') ? 'critical'
      : flags.some(f => f.level === 'high') ? 'high' : 'medium';

    const invRes = await pool.query<{ id: string }>(
      `SELECT id FROM active_invoices
       WHERE company_id = $1
         AND CASE WHEN $3='seller' THEN seller_tax_code ELSE buyer_tax_code END = $2
       LIMIT 200`,
      [companyId, taxCode, partnerType],
    );
    const invoiceIds = invRes.rows.map(r => r.id);

    await pool.query(
      `INSERT INTO company_risk_flags
         (company_id, tax_code, partner_type, risk_level, flag_types, flag_details,
          invoice_ids, total_vat_at_risk, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (company_id, tax_code) DO UPDATE SET
         risk_level        = EXCLUDED.risk_level,
         flag_types        = EXCLUDED.flag_types,
         flag_details      = EXCLUDED.flag_details,
         invoice_ids       = EXCLUDED.invoice_ids,
         total_vat_at_risk = EXCLUDED.total_vat_at_risk,
         is_acknowledged   = false,
         updated_at        = NOW()`,
      [
        companyId, taxCode, partnerType, maxLevel,
        flags.map(f => f.code),
        JSON.stringify(flags),
        invoiceIds,
        totalVatAtRisk,
      ],
    );

    // Notification for critical flags (best-effort — don't fail if this errors)
    if (maxLevel === 'critical') {
      const info = await companyVerificationService.getFromCache(taxCode);
      const name = info?.company_name ?? taxCode;
      const vatStr = new Intl.NumberFormat('vi-VN').format(Math.round(totalVatAtRisk)) + 'đ';
      await pool.query(
        `INSERT INTO notifications (id, company_id, type, title, body, data, created_at)
         VALUES (gen_random_uuid(), $1, 'GHOST_COMPANY_CRITICAL',
           '🚨 Phát hiện công ty nghi ngờ ma',
           $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [
          companyId,
          `NCC "${name}" có dấu hiệu bất thường nghiêm trọng — VAT có nguy cơ: ${vatStr}`,
          JSON.stringify({ tax_code: taxCode, risk_level: maxLevel, flag_count: flags.length }),
        ],
      ).catch(() => { /* non-fatal */ });
    }
  }
}

export const ghostCompanyDetector = new GhostCompanyDetector();
