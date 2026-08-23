import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';
import { cashPaymentDetector } from '../services/CashPaymentDetector';
import { amendedInvoiceRouter } from '../services/AmendedInvoiceRouter';
import { missingInvoiceFinder } from '../services/MissingInvoiceFinder';
import {
  companyVerificationService, MST_STATUS_LABEL, MST_STATUS_RISK, MstStatus,
} from '../services/CompanyVerificationService';
import { einvoiceProviderService } from '../services/EInvoiceProviderService';

// Hợp lệ lý do ẩn hóa đơn
const DELETE_REASONS = ['duplicate', 'invalid', 'test_data', 'other'] as const;
type DeleteReason = typeof DELETE_REASONS[number];

// Ghi audit log (không throw — lỗi log không chặn nghiệp vụ)
async function writeAuditLog(
  companyId: string,
  userId: string,
  action: string,
  entityId: string | null,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, $2, $3, 'invoice', $4, $5)`,
      [companyId, userId, action, entityId, metadata ? JSON.stringify(metadata) : null]
    );
  } catch {
    // audit log failure must never break the main operation
  }
}

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  direction: z.enum(['output', 'input']).optional(),
  status: z.enum(['valid', 'cancelled', 'replaced', 'replaced_original', 'adjusted', 'adjusted_original', 'invalid']).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  search: z.string().optional(),
  importSessionId: z.string().uuid().optional(),
  invoiceGroup: z.coerce.number().int().optional(),
  isSco: z.enum(['true', 'false']).optional(),
  // Lọc theo trạng thái MST của đối tác (người bán với HĐ đầu vào, người mua với HĐ đầu ra).
  // 'risky' = gộp mọi trạng thái ảnh hưởng quyền khấu trừ.
  partnerStatus: z.enum([
    'active', 'suspended', 'inactive_at_address', 'pending_dissolution',
    'dissolved', 'moved', 'not_found', 'unknown', 'risky',
  ]).optional(),
  // Bản gốc từ cổng thuế: 'yes' = đã tải về, 'no' = chưa có (còn tải được),
  // 'impossible' = cổng thuế không lưu (HĐ nhóm 6/8)
  hasOriginal: z.enum(['yes', 'no', 'impossible']).optional(),
  // Chi tiết hàng hoá: 'no' = thiếu dòng hàng (cần bấm lấy chi tiết mới kê khai được)
  hasLineItems: z.enum(['yes', 'no']).optional(),
});

/** SQL biểu thức lấy MST đối tác của một dòng hoá đơn */
const PARTNER_TAX_CODE_SQL = `CASE
  WHEN i.direction = 'input'  THEN i.seller_tax_code
  WHEN i.direction = 'output' THEN i.buyer_tax_code
  ELSE COALESCE(i.seller_tax_code, i.buyer_tax_code)
END`;

const RISKY_MST_STATUSES = ['suspended', 'inactive_at_address', 'pending_dissolution', 'dissolved', 'not_found'];

/**
 * Dựng mệnh đề WHERE dùng chung cho danh sách / đếm / tổng hợp / thao tác hàng loạt.
 * Cột để trần (không alias) để dùng lại được cho cả truy vấn có JOIN lẫn không.
 */
function buildInvoiceFilter(
  q: Partial<z.infer<typeof listSchema>>,
  companyId: string,
): { where: string; params: unknown[]; nextIdx: number } {
  const conditions: string[] = ['company_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [companyId];
  let idx = 2;

  if (q.direction) { conditions.push(`direction = $${idx++}`); params.push(q.direction); }
  if (q.status) { conditions.push(`status = $${idx++}`); params.push(q.status); }
  if (q.fromDate) { conditions.push(`invoice_date >= $${idx++}`); params.push(q.fromDate); }
  if (q.toDate) { conditions.push(`invoice_date <= $${idx++}`); params.push(q.toDate); }
  if (q.importSessionId) { conditions.push(`import_session_id = $${idx++}`); params.push(q.importSessionId); }
  if (q.invoiceGroup != null) { conditions.push(`invoice_group = $${idx++}`); params.push(q.invoiceGroup); }
  if (q.isSco != null) { conditions.push(`is_sco = $${idx++}`); params.push(q.isSco === 'true'); }
  if (q.search) {
    conditions.push(`(invoice_number ILIKE $${idx} OR seller_name ILIKE $${idx} OR buyer_name ILIKE $${idx} OR seller_tax_code ILIKE $${idx} OR buyer_tax_code ILIKE $${idx})`);
    params.push(`%${q.search}%`);
    idx++;
  }
  if (q.partnerStatus) {
    // Subquery thay vì JOIN để điều kiện dùng lại được ở mọi truy vấn
    const partnerExpr = PARTNER_TAX_CODE_SQL.replace(/i\./g, '');
    if (q.partnerStatus === 'unknown') {
      conditions.push(`COALESCE((${partnerExpr}), '') NOT IN (SELECT tax_code FROM company_verification_cache WHERE mst_status <> 'pending')`);
    } else if (q.partnerStatus === 'risky') {
      conditions.push(`(${partnerExpr}) IN (SELECT tax_code FROM company_verification_cache WHERE mst_status = ANY($${idx++}::text[]))`);
      params.push(RISKY_MST_STATUSES);
    } else {
      conditions.push(`(${partnerExpr}) IN (SELECT tax_code FROM company_verification_cache WHERE mst_status = $${idx++})`);
      params.push(q.partnerStatus);
    }
  }
  if (q.hasOriginal === 'yes') {
    conditions.push(`COALESCE(pdf_status, 'unknown') = 'available'`);
  } else if (q.hasOriginal === 'no') {
    conditions.push(`COALESCE(pdf_status, 'unknown') NOT IN ('available', 'unavailable')`);
  } else if (q.hasOriginal === 'impossible') {
    conditions.push(`COALESCE(pdf_status, 'unknown') = 'unavailable'`);
  }
  if (q.hasLineItems === 'yes') {
    conditions.push(`has_line_items IS TRUE`);
  } else if (q.hasLineItems === 'no') {
    conditions.push(`has_line_items IS NOT TRUE`);
  }

  return { where: conditions.join(' AND '), params, nextIdx: idx };
}

// GET /api/invoices
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listSchema.safeParse(req.query);
    if (!query.success) throw new ValidationError(query.error.issues[0]?.message ?? 'Invalid query');

    const { page, pageSize } = query.data;
    const companyId = req.user!.companyId;
    const offset = (page - 1) * pageSize;

    const { where, params, nextIdx: idx } = buildInvoiceFilter(query.data, companyId!);

    const [countResult, dataResult, summaryResult, riskResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM invoices WHERE ${where}`, params),
      pool.query(
        // LEFT JOIN company_risk_flags to get vendor/buyer risk level inline.
        // CTE scoped to this company's unacknowledged flags — one row per tax code.
        // Counterparty: seller_tax_code for input invoices, buyer_tax_code for output.
        `WITH _risk AS (
           SELECT tax_code, risk_level, flag_types
           FROM company_risk_flags
           WHERE company_id = $1 AND is_acknowledged = false
         )
         SELECT i.id, i.invoice_number, i.serial_number, i.invoice_date, i.direction, i.status,
                i.seller_name, i.seller_tax_code, i.buyer_name, i.buyer_tax_code,
                i.subtotal, i.total_amount, i.vat_amount, i.vat_rate, i.gdt_validated, i.provider,
                i.invoice_group, i.serial_has_cqt, i.has_line_items,
                i.payment_method,
                COALESCE(i.customer_code, NULL)::TEXT AS customer_code,
                COALESCE(i.item_code, NULL)::TEXT     AS item_code,
                COALESCE(i.notes, NULL)::TEXT          AS notes,
                i.tc_hdon, i.khhd_cl_quan, i.so_hd_cl_quan,
                i.non_deductible,
                COALESCE(i.xml_status, 'unknown') AS xml_status,
                COALESCE(i.pdf_status, 'unknown') AS pdf_status,
                COALESCE(i.provider_pdf_status, 'unknown') AS provider_pdf_status,
                i.gdt_tvandnkntt       AS provider_tax_code,
                i.provider_lookup_code AS provider_lookup_code,
                COALESCE(_p.short_name, _p.name, _pc.company_name) AS provider_name,
                _p.portal_url          AS provider_portal_url,
                _r.risk_level  AS vendor_risk_level,
                _r.flag_types  AS vendor_flag_types,
                -- Trạng thái MST đối tác (tra từ cổng Cục Thuế, cache có TTL theo trạng thái)
                _v.mst_status                     AS partner_mst_status,
                _v.mst_status_raw                 AS partner_mst_status_raw,
                _v.company_name                   AS partner_registered_name,
                _v.tax_authority                  AS partner_tax_authority,
                _v.verified_at                    AS partner_status_checked_at,
                (_v.expires_at < NOW())           AS partner_status_stale
         FROM invoices i
         LEFT JOIN _risk _r ON _r.tax_code = ${PARTNER_TAX_CODE_SQL}
         LEFT JOIN company_verification_cache _v ON _v.tax_code = ${PARTNER_TAX_CODE_SQL}
         LEFT JOIN einvoice_providers _p ON _p.tax_code = i.gdt_tvandnkntt
         LEFT JOIN company_verification_cache _pc ON _pc.tax_code = i.gdt_tvandnkntt
         WHERE ${where}
         ORDER BY i.invoice_date DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, pageSize, offset]
      ),
      pool.query(
        `SELECT status,
                COUNT(*)                      AS count,
                COALESCE(SUM(subtotal), 0)    AS total_subtotal,
                COALESCE(SUM(vat_amount), 0)  AS total_vat
         FROM invoices WHERE ${where}
         GROUP BY status`,
        params
      ),
      // Chỉ số rủi ro thuế của đúng tập hoá đơn đang lọc — dùng cho thanh KPI bấm được
      pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE (${PARTNER_TAX_CODE_SQL.replace(/i\./g, '')}) IN (
               SELECT tax_code FROM company_verification_cache
                WHERE mst_status IN ('suspended','inactive_at_address','pending_dissolution','dissolved','not_found'))
           ) AS risky_partner_count,
           COALESCE(SUM(vat_amount) FILTER (
             WHERE direction = 'input' AND (${PARTNER_TAX_CODE_SQL.replace(/i\./g, '')}) IN (
               SELECT tax_code FROM company_verification_cache
                WHERE mst_status IN ('suspended','inactive_at_address','pending_dissolution','dissolved','not_found'))
           ), 0) AS risky_vat,
           COUNT(*) FILTER (WHERE COALESCE(pdf_status,'unknown') = 'available')                       AS with_original_count,
           COUNT(*) FILTER (WHERE COALESCE(pdf_status,'unknown') NOT IN ('available','unavailable'))  AS missing_original_count,
           COUNT(*) FILTER (WHERE COALESCE(pdf_status,'unknown') = 'unavailable')                     AS no_original_count,
           COUNT(*) FILTER (WHERE has_line_items IS NOT TRUE)                                         AS missing_items_count,
           COUNT(*) FILTER (
             WHERE COALESCE((${PARTNER_TAX_CODE_SQL.replace(/i\./g, '')}), '') NOT IN (
               SELECT tax_code FROM company_verification_cache WHERE mst_status <> 'pending')
           ) AS unchecked_partner_count
         FROM invoices WHERE ${where}`,
        params
      ),
    ]);

    // Build per-status breakdown
    type StatusRow = { status: string; count: string; total_subtotal: string; total_vat: string };
    const byStatus: Record<string, { count: number; subtotal: number; vat: number }> = {};
    let totalCount = 0;
    let totalSubtotal = 0;
    let totalVat = 0;
    for (const row of (summaryResult.rows as StatusRow[])) {
      const cnt  = Number(row.count);
      const sub  = Number(row.total_subtotal);
      const vat  = Number(row.total_vat);
      byStatus[row.status] = { count: cnt, subtotal: sub, vat };
      totalCount    += cnt;
      totalSubtotal += sub;
      totalVat      += vat;
    }

    const risk = (riskResult.rows[0] ?? {}) as Record<string, string>;
    const summary = {
      count:    totalCount,
      subtotal: totalSubtotal,
      vat:      totalVat,
      by_status: byStatus,
      // Chỉ số phục vụ thanh cảnh báo thuế trên UI
      tax_health: {
        risky_partner_count:     Number(risk['risky_partner_count'] ?? 0),
        risky_vat:               Number(risk['risky_vat'] ?? 0),
        with_original_count:     Number(risk['with_original_count'] ?? 0),
        missing_original_count:  Number(risk['missing_original_count'] ?? 0),
        no_original_count:       Number(risk['no_original_count'] ?? 0),
        missing_items_count:     Number(risk['missing_items_count'] ?? 0),
        unchecked_partner_count: Number(risk['unchecked_partner_count'] ?? 0),
      },
    };

    // Stale-while-revalidate: trả dữ liệu ngay, đẩy job tra cứu cho MST thiếu/hết hạn.
    // Bot (invone-verify-worker) sẽ tra qua proxy + captcha, UI poll lại sau.
    try {
      const staleCodes = (dataResult.rows as Array<Record<string, unknown>>)
        .filter(r => r['partner_mst_status'] == null || r['partner_status_stale'] === true)
        .map(r => String(
          r['direction'] === 'input' ? (r['seller_tax_code'] ?? '') : (r['buyer_tax_code'] ?? ''),
        ))
        .filter(Boolean);
      if (staleCodes.length > 0) {
        void companyVerificationService.enqueue(staleCodes, companyId).catch(() => undefined);
      }
    } catch { /* không bao giờ chặn danh sách hoá đơn */ }

    const total = Number(countResult.rows[0].count);
    res.json({
      success: true,
      data: dataResult.rows,
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
        summary,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── STATIC ROUTES — phải đặt trước /:id để Express không nhầm ─────────────

// GET /api/invoices/export — tải Excel toàn bộ danh sách hóa đơn (cùng bộ lọc với list)
router.get('/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { direction, search, invoiceGroup, fromDate, toDate, isSco } = req.query as Record<string, string>;

    const conditions: string[] = ['company_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [companyId];
    let idx = 2;

    if (direction) { conditions.push(`direction = $${idx++}`); params.push(direction); }
    if (fromDate)  { conditions.push(`invoice_date >= $${idx++}`); params.push(fromDate); }
    if (toDate)    { conditions.push(`invoice_date <= $${idx++}`); params.push(toDate); }
    if (invoiceGroup) { conditions.push(`invoice_group = $${idx++}`); params.push(Number(invoiceGroup)); }
    if (isSco === 'true' || isSco === 'false') { conditions.push(`is_sco = $${idx++}`); params.push(isSco === 'true'); }
    if (search) {
      conditions.push(`(invoice_number ILIKE $${idx} OR seller_name ILIKE $${idx} OR buyer_name ILIKE $${idx} OR seller_tax_code ILIKE $${idx} OR buyer_tax_code ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.join(' AND ');
    const { rows } = await pool.query(
      `SELECT i.invoice_number, i.serial_number, i.invoice_date, i.direction, i.status,
              i.seller_name, i.seller_tax_code, i.buyer_name, i.buyer_tax_code,
              i.subtotal, i.total_amount, i.vat_amount, i.vat_rate,
              i.payment_method, i.notes,
              COALESCE(i.customer_code,
                CASE WHEN i.direction = 'output'
                  THEN (SELECT cc.customer_code FROM customer_catalog cc WHERE cc.company_id = i.company_id AND cc.tax_code = i.buyer_tax_code LIMIT 1)
                  ELSE (SELECT sc.supplier_code FROM supplier_catalog sc WHERE sc.company_id = i.company_id AND sc.tax_code = i.seller_tax_code LIMIT 1)
                END
              ) AS customer_code,
              CASE WHEN i.direction='output' THEN i.buyer_name ELSE i.seller_name END AS party_name,
              COALESCE(i.item_code,
                (SELECT COALESCE(pc.item_code, li.item_code) FROM invoice_line_items li
                 LEFT JOIN product_catalog pc ON pc.company_id = i.company_id AND pc.normalized_name = LOWER(TRIM(li.item_name))
                 WHERE li.invoice_id = i.id AND li.deleted_at IS NULL LIMIT 1)
              ) AS item_code,
              (SELECT STRING_AGG(li.item_name, '; ') FROM invoice_line_items li WHERE li.invoice_id = i.id AND li.deleted_at IS NULL LIMIT 3) AS item_name
       FROM invoices i WHERE ${where}
       ORDER BY i.invoice_date DESC
       LIMIT 5000`,
      params
    );

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'AUTOPOST VN';
    const sh = wb.addWorksheet('Hóa Đơn');

    sh.columns = [
      { header: 'STT',           key: 'stt',     width: 6  },
      { header: 'Hướng',         key: 'dir',     width: 8  },
      { header: 'Số HĐ',         key: 'inv_no',  width: 16 },
      { header: 'Ký hiệu',       key: 'serial',  width: 14 },
      { header: 'Ngày lập',      key: 'date',    width: 13 },
      { header: 'Người bán',     key: 'seller',  width: 28 },
      { header: 'MST người bán', key: 'seller_tc', width: 14 },
      { header: 'Người mua',     key: 'buyer',   width: 28 },
      { header: 'MST người mua', key: 'buyer_tc', width: 14 },
      { header: 'Tiền hàng',     key: 'sub',     width: 16 },
      { header: 'Thuế VAT',      key: 'vat',     width: 14 },
      { header: 'Tổng tiền',     key: 'total',   width: 16 },
      { header: 'TS%',           key: 'rate',    width: 6  },
      { header: 'TT thanh toán', key: 'pay',      width: 14 },
      { header: 'Mã KH/NCC',    key: 'cust',     width: 14 },
      { header: 'Tên KH/NCC',   key: 'party_name', width: 28 },
      { header: 'Mã hàng',      key: 'item',     width: 14 },
      { header: 'Tên mặt hàng', key: 'item_name', width: 28 },
      { header: 'Ghi chú',      key: 'notes',    width: 24 },
    ];

    const hdr = sh.getRow(1);
    hdr.font = { bold: true };
    hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };

    rows.forEach((inv, i) => {
      const r = sh.addRow({
        stt:       i + 1,
        dir:       inv.direction === 'output' ? 'Bán ra' : 'Mua vào',
        inv_no:    inv.invoice_number,
        serial:    inv.serial_number,
        date:      inv.invoice_date ? new Date(inv.invoice_date) : '',
        seller:    inv.seller_name,
        seller_tc: inv.seller_tax_code,
        buyer:     inv.buyer_name,
        buyer_tc:  inv.buyer_tax_code,
        sub:       inv.subtotal    ? Number(inv.subtotal)    : '',
        vat:       Number(inv.vat_amount),
        total:     Number(inv.total_amount),
        rate:      inv.vat_rate,
        pay:       inv.payment_method ?? '',
        cust:      inv.customer_code  ?? '',
        party_name: inv.party_name    ?? '',
        item:      inv.item_code      ?? '',
        item_name: inv.item_name      ?? '',
        notes:     inv.notes         ?? '',
      });
      for (const c of ['sub', 'vat', 'total']) r.getCell(c).numFmt = '#,##0';
      r.getCell('date').numFmt = 'DD/MM/YYYY';
    });

    const raw = await wb.xlsx.writeBuffer();
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="HoaDon_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/download-xml — tải ZIP chứa XML của các hóa đơn được chọn
router.get('/download-xml', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const idsParam = req.query.ids as string;
    if (!idsParam) return res.status(400).json({ success: false, error: { code: 'MISSING_IDS', message: 'ids query parameter is required' } });

    const ids = idsParam.split(',').slice(0, 100);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validIds = ids.filter(id => uuidRegex.test(id));
    if (validIds.length === 0) return res.status(400).json({ success: false, error: { code: 'INVALID_IDS', message: 'No valid UUIDs provided' } });

    const placeholders = validIds.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await pool.query(
      `SELECT invoice_number, seller_tax_code, buyer_tax_code, direction, raw_xml FROM invoices WHERE company_id = $1 AND id IN (${placeholders}) AND raw_xml IS NOT NULL AND deleted_at IS NULL`,
      [companyId, ...validIds]
    );

    if (rows.length === 0) {
      // Check if invoices actually exist but just have no raw_xml stored
      const { rows: existRows } = await pool.query<{ source: string }>(
        `SELECT source FROM invoices WHERE company_id = $1 AND id IN (${placeholders}) AND deleted_at IS NULL LIMIT 5`,
        [companyId, ...validIds],
      );
      if (existRows.length > 0) {
        // Chưa có bản gốc → tự đưa vào hàng đợi để bot tải về, UI thử lại sau
        const enq = await enqueueOriginalXml(companyId, validIds, req.user!.userId);
        const message = enq.queued > 0
          ? `Đang tải ${enq.queued} hoá đơn gốc từ hệ thống thuế — vui lòng thử lại sau ít phút.`
          : 'Các hoá đơn này không có bản gốc trên hệ thống GDT (hoá đơn không mã CQT / uỷ nhiệm) — cần xin file từ người bán.';
        return res.status(enq.queued > 0 ? 202 : 409).json({
          success: false,
          error: { code: enq.queued > 0 ? 'XML_QUEUED' : 'XML_UNAVAILABLE', message },
          data: enq,
        });
      }
      return res.status(404).json({ success: false, error: { code: 'NO_XML', message: 'No invoices with XML found' } });
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const createArchive = require('archiver') as (format: string, options: Record<string, unknown>) => { pipe: (dest: NodeJS.WritableStream) => void; append: (source: string, data: { name: string }) => void; finalize: () => Promise<void> };
    const archive = createArchive('zip', { zlib: { level: 5 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="HoaDon_XML_${new Date().toISOString().slice(0, 10)}.zip"`);
    archive.pipe(res);

    for (const row of rows) {
      const prefix = row.direction === 'output' ? 'BR' : 'MV';
      const taxCode = row.direction === 'output' ? row.seller_tax_code : row.buyer_tax_code;
      const filename = `${prefix}_${taxCode}_${row.invoice_number || 'unknown'}.xml`.replace(/[/\\?%*:|"<>]/g, '_');
      archive.append(row.raw_xml, { name: filename });
    }

    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

// ─── Hoá đơn gốc (XML ký số từ hệ thống GDT) ─────────────────────────────────

/**
 * Đưa hoá đơn vào hàng đợi tải bản gốc.
 * Trả về trạng thái để UI hiển thị đúng: có sẵn / đang tải / không có bản gốc.
 */
async function enqueueOriginalXml(
  companyId: string,
  invoiceIds: string[],
  userId: string,
  priority = 1,
  wantPdf = true,
  wantProviderPdf = false,
): Promise<{ queued: number; ready: number; unavailable: number; details: Array<{ id: string; status: string }> }> {
  if (invoiceIds.length === 0) return { queued: 0, ready: 0, unavailable: 0, details: [] };

  const { rows } = await pool.query<{
    id: string; invoice_number: string; serial_number: string | null;
    seller_tax_code: string | null; gdt_ttxly: number | null;
    xml_status: string; has_xml: boolean; has_pdf: boolean; gdt_khmshdon: number | null;
  }>(
    `SELECT id, invoice_number, serial_number, seller_tax_code, gdt_ttxly,
            COALESCE(xml_status, 'unknown') AS xml_status,
            (raw_xml IS NOT NULL) AS has_xml,
            (pdf_path IS NOT NULL) AS has_pdf,
            gdt_khmshdon
       FROM invoices
      WHERE company_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [companyId, invoiceIds],
  );

  const details: Array<{ id: string; status: string }> = [];
  let queued = 0, ready = 0, unavailable = 0;

  for (const inv of rows) {
    // Đã có XML nhưng chưa có PDF thì vẫn phải tải lại gói ZIP để render bản thể hiện
    if (inv.has_xml && (!wantPdf || inv.has_pdf)) {
      ready++; details.push({ id: inv.id, status: 'available' }); continue;
    }

    // ttxly 6 (không mã CQT) và 8 (uỷ nhiệm/MTT): hệ thống GDT không lưu XML gốc
    if (inv.gdt_ttxly === 6 || inv.gdt_ttxly === 8) {
      unavailable++;
      details.push({ id: inv.id, status: 'unavailable' });
      await pool.query(
        `UPDATE invoices
            SET xml_status = CASE WHEN xml_status = 'available' THEN xml_status ELSE 'unavailable' END,
                pdf_status = 'unavailable',
                xml_error  = 'Hệ thống GDT không lưu bản gốc cho hoá đơn không mã CQT / uỷ nhiệm',
                pdf_error  = 'Hệ thống GDT không lưu bản gốc cho hoá đơn không mã CQT / uỷ nhiệm'
          WHERE id = $1`, [inv.id]);
      continue;
    }

    if (!inv.serial_number || !inv.seller_tax_code || !inv.invoice_number) {
      unavailable++;
      details.push({ id: inv.id, status: 'missing_params' });
      continue;
    }

    await pool.query(
      `INSERT INTO invoice_xml_queue
         (invoice_id, company_id, nbmst, khhdon, shdon, khmshdon, priority, requested_by, want_pdf, want_provider_pdf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (invoice_id) DO UPDATE
          SET status = CASE WHEN invoice_xml_queue.status = 'processing'
                            THEN invoice_xml_queue.status ELSE 'pending' END,
              priority = LEAST(invoice_xml_queue.priority, EXCLUDED.priority),
              attempts = 0,
              want_pdf = invoice_xml_queue.want_pdf OR EXCLUDED.want_pdf,
              want_provider_pdf = invoice_xml_queue.want_provider_pdf OR EXCLUDED.want_provider_pdf,
              enqueued_at = NOW()`,
      [inv.id, companyId, inv.seller_tax_code, inv.serial_number, inv.invoice_number,
       inv.gdt_khmshdon ?? 1, priority, userId, wantPdf, wantProviderPdf],
    );
    await pool.query(
      `UPDATE invoices
          SET xml_status = CASE WHEN xml_status = 'available' THEN xml_status ELSE 'queued' END,
              pdf_status = CASE WHEN pdf_status = 'available' THEN pdf_status ELSE 'queued' END
        WHERE id = $1`,
      [inv.id],
    );
    queued++;
    details.push({ id: inv.id, status: 'queued' });
  }

  return { queued, ready, unavailable, details };
}

/**
 * POST /api/invoices/original-xml/request
 * Body: { invoiceIds: string[] }
 * Yêu cầu bot tải bản gốc (XML ký số) về. Bot xử lý qua proxy + tài khoản GDT
 * của chính công ty, nên đây là thao tác bất đồng bộ.
 */
router.post('/original-xml/request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const body = z.object({
      invoiceIds:      z.array(z.string().uuid()).min(1).max(200),
      wantPdf:         z.boolean().optional(),
      wantProviderPdf: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError('Danh sách hoá đơn không hợp lệ');

    const result = await enqueueOriginalXml(
      companyId, body.data.invoiceIds, req.user!.userId, 1,
      body.data.wantPdf ?? true, body.data.wantProviderPdf ?? false,
    );

    const parts: string[] = [];
    if (result.queued > 0)      parts.push(`${result.queued} HĐ đang được tải từ hệ thống thuế`);
    if (result.ready > 0)       parts.push(`${result.ready} HĐ đã có sẵn bản gốc`);
    if (result.unavailable > 0) parts.push(`${result.unavailable} HĐ không có bản gốc trên hệ thống GDT`);

    return sendSuccess(res, {
      ...result,
      message: parts.join(' · ') || 'Không có hoá đơn phù hợp',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invoices/original-xml/request-by-filter
 *
 * Lấy bản gốc cho TOÀN BỘ hoá đơn khớp bộ lọc đang xem (không phải chọn từng dòng).
 * Bỏ qua hoá đơn đã có bản gốc và hoá đơn cổng thuế không lưu (nhóm 6/8).
 * Giới hạn 200 hoá đơn mỗi lần để không dồn tải lên cổng thuế.
 */
router.post('/original-xml/request-by-filter', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const parsed = listSchema.partial().safeParse(req.body?.filter ?? req.body ?? {});
    if (!parsed.success) throw new ValidationError('Bộ lọc không hợp lệ');

    const { where, params } = buildInvoiceFilter(
      { ...parsed.data, hasOriginal: 'no' },   // chỉ lấy HĐ còn thiếu bản gốc
      companyId,
    );

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM invoices WHERE ${where} ORDER BY invoice_date DESC LIMIT 200`,
      params,
    );
    if (rows.length === 0) {
      return sendSuccess(res, { queued: 0, message: 'Tất cả hoá đơn đang lọc đã có bản gốc (hoặc cổng thuế không lưu)' });
    }

    const result = await enqueueOriginalXml(
      companyId, rows.map(r => r.id), req.user!.userId, 5,
      true, req.body?.wantProviderPdf === true,
    );
    return sendSuccess(res, {
      ...result,
      message: `Đang lấy bản gốc cho ${result.queued} hoá đơn — hệ thống tải dần từ cổng thuế, bạn có thể làm việc khác`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invoices/line-items/fetch-by-filter
 *
 * Xếp hàng lấy CHI TIẾT HÀNG HOÁ (dòng hàng) cho các hoá đơn đang lọc mà còn thiếu.
 * Thiếu dòng hàng thì không lên được bảng kê / sổ sách, nên đây là việc phải xử lý sớm.
 * Bot lấy chi tiết qua API cổng thuế, ưu tiên cao vì người dùng đang chờ.
 */
router.post('/line-items/fetch-by-filter', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const parsed = listSchema.partial().safeParse(req.body?.filter ?? req.body ?? {});
    if (!parsed.success) throw new ValidationError('Bộ lọc không hợp lệ');

    const { where, params } = buildInvoiceFilter(
      { ...parsed.data, hasLineItems: 'no' },
      companyId,
    );

    // Chỉ hoá đơn có đủ tham số gọi cổng thuế mới xếp hàng được
    const { rows } = await pool.query<{ inserted: string }>(
      `WITH candidates AS (
         SELECT id, company_id, seller_tax_code, serial_number, invoice_number,
                COALESCE(is_sco, false) AS is_sco
           FROM invoices
          WHERE ${where}
            AND seller_tax_code IS NOT NULL
            AND serial_number   IS NOT NULL
            AND invoice_number  IS NOT NULL
          ORDER BY invoice_date DESC
          LIMIT 500
       ), ins AS (
         INSERT INTO invoice_detail_queue
           (invoice_id, company_id, nbmst, khhdon, shdon, is_sco, priority, status)
         SELECT id, company_id, seller_tax_code, serial_number, invoice_number, is_sco, 1, 'pending'
           FROM candidates
         ON CONFLICT (invoice_id) DO UPDATE
            SET status   = CASE WHEN invoice_detail_queue.status = 'done'
                                THEN invoice_detail_queue.status ELSE 'pending' END,
                priority = 1,
                attempts = 0,
                next_retry_at = NULL,
                enqueued_at = NOW()
         RETURNING id
       )
       SELECT COUNT(*) AS inserted FROM ins`,
      params,
    );

    const queued = parseInt(rows[0]?.inserted ?? '0', 10);
    return sendSuccess(res, {
      queued,
      message: queued > 0
        ? `Đang lấy chi tiết hàng hoá cho ${queued} hoá đơn — dữ liệu hiện dần trong vài phút`
        : 'Tất cả hoá đơn đang lọc đã có chi tiết hàng hoá',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/original-xml/status?ids=uuid,uuid
 * UI poll trạng thái tải bản gốc.
 */
router.get('/original-xml/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const ids = String(req.query.ids ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
    if (ids.length === 0) return sendSuccess(res, { statuses: [] });

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validIds = ids.filter(id => uuidRe.test(id));
    if (validIds.length === 0) throw new ValidationError('Danh sách ID không hợp lệ');

    const { rows } = await pool.query(
      `SELECT i.id,
              COALESCE(i.xml_status,'unknown') AS xml_status,
              COALESCE(i.pdf_status,'unknown') AS pdf_status,
              COALESCE(i.provider_pdf_status,'unknown') AS provider_pdf_status,
              (i.raw_xml IS NOT NULL)          AS has_xml,
              (i.pdf_path IS NOT NULL)         AS has_pdf,
              (i.provider_pdf_path IS NOT NULL) AS has_provider_pdf,
              i.raw_xml_size, i.raw_xml_at, i.xml_error,
              i.pdf_size, i.pdf_generated_at, i.pdf_error,
              q.status                          AS queue_status,
              q.attempts, q.last_error
         FROM invoices i
         LEFT JOIN invoice_xml_queue q ON q.invoice_id = i.id
        WHERE i.company_id = $1 AND i.id = ANY($2::uuid[]) AND i.deleted_at IS NULL`,
      [companyId, validIds],
    );
    return sendSuccess(res, { statuses: rows });
  } catch (err) {
    next(err);
  }
});

/** Thư mục lưu file hoá đơn gốc — phải khớp INVOICE_STORAGE_DIR của bot */
const INVOICE_STORAGE_DIR = process.env.INVOICE_STORAGE_DIR ?? '/opt/INVONESOURCE/storage/invoices';

/** Chống path traversal: chỉ cho phép đường dẫn tương đối nằm trong thư mục lưu trữ */
function resolveStoredFile(relPath: string): string | null {
  const abs = path.resolve(INVOICE_STORAGE_DIR, relPath);
  const root = path.resolve(INVOICE_STORAGE_DIR);
  if (!abs.startsWith(root + path.sep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

/** Tên file tải về, dạng BR/MV_<MST>_<kýhiệu>_<số HĐ>.<ext> */
function invoiceFileName(
  inv: { direction: string; seller_tax_code: string | null; buyer_tax_code: string | null; serial_number: string | null; invoice_number: string },
  ext: string,
): string {
  const prefix = inv.direction === 'output' ? 'BR' : 'MV';
  const taxCode = inv.direction === 'output' ? inv.seller_tax_code : inv.buyer_tax_code;
  return `${prefix}_${taxCode ?? 'NA'}_${inv.serial_number ?? ''}_${inv.invoice_number}.${ext}`
    .replace(/[/\\?%*:|"<>]/g, '_');
}

/**
 * GET /api/invoices/:id/original-sources
 *
 * Trả về mọi đường lấy bản gốc của hoá đơn:
 *   - Bản của NHÀ CUNG CẤP (Viettel/MISA/VNPT/…): tên NCC, mã tra cứu, cổng tra cứu
 *   - Bản thể hiện của CỔNG THUẾ: PDF do INVONE render từ gói ZIP của GDT
 *   - XML ký số: bản gốc hợp pháp
 */
router.get('/:id/original-sources', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const sources = await einvoiceProviderService.getOriginalSources(companyId, req.params.id!);
    if (!sources) throw new NotFoundError('Không tìm thấy hoá đơn');
    return sendSuccess(res, sources);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/:id/original-pdf?disposition=inline|attachment
 *
 * Bản thể hiện PDF của hoá đơn gốc — render từ invoice.html trong gói ZIP mà
 * hệ thống GDT phát hành (giữ nguyên mẫu, dấu và chữ ký của nhà cung cấp).
 * Chưa có → tự đưa vào hàng đợi và trả 202 để UI poll tiếp.
 */
router.get('/:id/original-pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { id } = req.params;

    const { rows } = await pool.query<{
      pdf_path: string | null; pdf_status: string; pdf_error: string | null;
      invoice_number: string; serial_number: string | null;
      seller_tax_code: string | null; buyer_tax_code: string | null;
      direction: string; gdt_ttxly: number | null;
    }>(
      `SELECT pdf_path, COALESCE(pdf_status,'unknown') AS pdf_status, pdf_error,
              invoice_number, serial_number, seller_tax_code, buyer_tax_code,
              direction, gdt_ttxly
         FROM invoices
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, companyId],
    );
    const inv = rows[0];
    if (!inv) throw new NotFoundError('Không tìm thấy hoá đơn');

    if (inv.pdf_path) {
      const abs = resolveStoredFile(inv.pdf_path);
      if (abs) {
        const inline = String(req.query.disposition ?? 'inline') !== 'attachment';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${invoiceFileName(inv, 'pdf')}"`,
        );
        return fs.createReadStream(abs).pipe(res);
      }
      // File đã bị xoá khỏi ổ đĩa → xếp hàng tải lại
      await pool.query(`UPDATE invoices SET pdf_path=NULL, pdf_status='queued' WHERE id=$1`, [id]);
    }

    if (inv.gdt_ttxly === 6 || inv.gdt_ttxly === 8 || inv.pdf_status === 'unavailable') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'PDF_UNAVAILABLE',
          message: inv.pdf_error ??
            'Hệ thống GDT không lưu bản gốc của hoá đơn này (hoá đơn không mã CQT / uỷ nhiệm). ' +
            'Cần xin bản thể hiện từ người bán.',
        },
      });
    }

    const result = await enqueueOriginalXml(companyId, [id!], req.user!.userId);
    return res.status(202).json({
      success: true,
      data: { ...result, status: 'queued' },
      message: 'Đang lấy bản gốc từ hệ thống thuế và tạo bản thể hiện PDF — vui lòng chờ ít phút',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/:id/provider-pdf?disposition=inline|attachment
 *
 * PDF theo MẪU RIÊNG CỦA NHÀ CUNG CẤP (Viettel S-Invoice, MISA…).
 * Khác với /original-pdf (bản thể hiện do cổng thuế phát hành).
 * Chỉ có khi công ty đã cấu hình tài khoản nhà cung cấp trong Cài đặt → Kết nối.
 */
router.get('/:id/provider-pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { id } = req.params;

    const { rows } = await pool.query<{
      provider_pdf_path: string | null; provider_pdf_status: string; provider_pdf_error: string | null;
      invoice_number: string; serial_number: string | null;
      seller_tax_code: string | null; buyer_tax_code: string | null; direction: string;
      provider_lookup_code: string | null; gdt_tvandnkntt: string | null;
    }>(
      `SELECT provider_pdf_path, COALESCE(provider_pdf_status,'unknown') AS provider_pdf_status,
              provider_pdf_error, invoice_number, serial_number, seller_tax_code, buyer_tax_code,
              direction, provider_lookup_code, gdt_tvandnkntt
         FROM invoices
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, companyId],
    );
    const inv = rows[0];
    if (!inv) throw new NotFoundError('Không tìm thấy hoá đơn');

    if (inv.provider_pdf_path) {
      const abs = resolveStoredFile(inv.provider_pdf_path);
      if (abs) {
        const inline = String(req.query.disposition ?? 'inline') !== 'attachment';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${invoiceFileName(inv, 'pdf')}"`);
        return fs.createReadStream(abs).pipe(res);
      }
    }

    // Chưa có: hướng dẫn đúng cách lấy thay vì báo lỗi cụt
    const provider = await einvoiceProviderService.resolve(inv.gdt_tvandnkntt);
    return res.status(409).json({
      success: false,
      error: {
        code: inv.provider_pdf_status === 'no_connector' ? 'PROVIDER_NOT_CONNECTED' : 'PROVIDER_PDF_UNAVAILABLE',
        message: inv.provider_pdf_status === 'no_connector'
          ? `Chưa kết nối tài khoản ${provider?.short_name ?? 'nhà cung cấp'} nên không tải tự động được. ` +
            'Vào Cài đặt → Kết nối hoá đơn để thêm tài khoản, hoặc dùng mã tra cứu để tải trên cổng của họ.'
          : inv.provider_pdf_error ??
            'Bản PDF theo mẫu nhà cung cấp phải tải trên cổng tra cứu của họ bằng mã tra cứu.',
      },
      data: {
        provider,
        lookup_code: inv.provider_lookup_code,
        seller_tax_code: inv.seller_tax_code,
        provider_pdf_status: inv.provider_pdf_status,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/download-pdf?ids=uuid,uuid
 * Tải nhiều bản thể hiện PDF trong một file ZIP.
 */
router.get('/download-pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const idsParam = String(req.query.ids ?? '');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = idsParam.split(',').map(s => s.trim()).filter(s => uuidRe.test(s)).slice(0, 100);
    if (ids.length === 0) throw new ValidationError('Danh sách hoá đơn không hợp lệ');

    const { rows } = await pool.query<{
      id: string; pdf_path: string | null; invoice_number: string; serial_number: string | null;
      seller_tax_code: string | null; buyer_tax_code: string | null; direction: string;
    }>(
      `SELECT id, pdf_path, invoice_number, serial_number, seller_tax_code, buyer_tax_code, direction
         FROM invoices
        WHERE company_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [companyId, ids],
    );

    const ready = rows.filter(r => r.pdf_path && resolveStoredFile(r.pdf_path));
    if (ready.length === 0) {
      const enq = await enqueueOriginalXml(companyId, ids, req.user!.userId);
      const message = enq.queued > 0
        ? `Đang tạo bản thể hiện PDF cho ${enq.queued} hoá đơn — vui lòng thử lại sau ít phút.`
        : 'Các hoá đơn này không có bản gốc trên hệ thống GDT.';
      return res.status(enq.queued > 0 ? 202 : 409).json({
        success: false,
        error: { code: enq.queued > 0 ? 'PDF_QUEUED' : 'PDF_UNAVAILABLE', message },
        data: enq,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const createArchive = require('archiver') as (format: string, options: Record<string, unknown>) => {
      pipe: (dest: NodeJS.WritableStream) => void;
      file: (source: string, data: { name: string }) => void;
      finalize: () => Promise<void>;
    };
    const archive = createArchive('zip', { zlib: { level: 3 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="HoaDonGoc_PDF_${new Date().toISOString().slice(0, 10)}.zip"`);
    archive.pipe(res);
    for (const r of ready) {
      const abs = resolveStoredFile(r.pdf_path!)!;
      archive.file(abs, { name: invoiceFileName(r, 'pdf') });
    }
    await archive.finalize();

    // Hoá đơn chưa có PDF trong lô này → xếp hàng để lần sau tải đủ
    const missing = rows.filter(r => !r.pdf_path).map(r => r.id);
    if (missing.length > 0) {
      void enqueueOriginalXml(companyId, missing, req.user!.userId).catch(() => undefined);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/:id/original-xml
 * Tải 1 file XML gốc. Nếu chưa có → tự đưa vào hàng đợi và trả 202.
 */
router.get('/:id/original-xml', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { id } = req.params;

    const { rows } = await pool.query<{
      raw_xml: string | null; invoice_number: string; serial_number: string | null;
      seller_tax_code: string | null; buyer_tax_code: string | null; direction: string;
      xml_status: string; gdt_ttxly: number | null; xml_error: string | null;
    }>(
      `SELECT raw_xml, invoice_number, serial_number, seller_tax_code, buyer_tax_code,
              direction, COALESCE(xml_status,'unknown') AS xml_status, gdt_ttxly, xml_error
         FROM invoices
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [id, companyId],
    );
    const inv = rows[0];
    if (!inv) throw new NotFoundError('Không tìm thấy hoá đơn');

    if (inv.raw_xml) {
      const prefix = inv.direction === 'output' ? 'BR' : 'MV';
      const taxCode = inv.direction === 'output' ? inv.seller_tax_code : inv.buyer_tax_code;
      const filename = `${prefix}_${taxCode ?? 'NA'}_${inv.serial_number ?? ''}_${inv.invoice_number}.xml`
        .replace(/[/\\?%*:|"<>]/g, '_');
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(inv.raw_xml);
    }

    if (inv.gdt_ttxly === 6 || inv.gdt_ttxly === 8 || inv.xml_status === 'unavailable') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'XML_UNAVAILABLE',
          message: inv.xml_error ??
            'Hệ thống GDT không lưu XML gốc cho hoá đơn không mã CQT / uỷ nhiệm. ' +
            'Bản gốc phải xin trực tiếp từ người bán.',
        },
      });
    }

    const result = await enqueueOriginalXml(companyId, [id!], req.user!.userId);
    return res.status(202).json({
      success: true,
      data: { ...result, status: 'queued' },
      message: 'Đang tải bản gốc từ hệ thống thuế — vui lòng thử lại sau ít phút',
    });
  } catch (err) {
    next(err);
  }
});

// ─── Trạng thái MST đối tác ──────────────────────────────────────────────────

/**
 * GET /api/invoices/partner-status?taxCodes=0106870211,0101243150
 * Trả trạng thái MST đang có trong cache — UI poll endpoint này sau khi bot tra xong
 * để cập nhật cột trạng thái mà không phải tải lại toàn bộ danh sách.
 */
router.get('/partner-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = String(req.query.taxCodes ?? '').trim();
    if (!raw) return sendSuccess(res, { statuses: [], labels: MST_STATUS_LABEL });

    const taxCodes = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
    const map = await companyVerificationService.getStatusMap(taxCodes);

    const statuses = [...map.values()].map(info => ({
      tax_code:        info.taxCode,
      mst_status:      info.mst_status,
      mst_status_raw:  info.mst_status_raw ?? null,
      label:           MST_STATUS_LABEL[info.mst_status],
      risk:            MST_STATUS_RISK[info.mst_status],
      registered_name: info.company_name ?? null,
      address:         info.address ?? null,
      tax_authority:   info.tax_authority ?? null,
      checked_at:      info.verified_at,
      is_stale:        info.is_stale ?? false,
    }));

    // MST chưa có trong cache → đẩy job tra cứu để lần poll sau đã có dữ liệu
    const missing = taxCodes.filter(t => !map.has(t));
    if (missing.length > 0) {
      void companyVerificationService.enqueue(missing, req.user!.companyId!).catch(() => undefined);
    }

    return sendSuccess(res, {
      statuses,
      pending: missing.length,
      labels: MST_STATUS_LABEL,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invoices/partner-status/refresh
 * Body: { taxCodes?: string[], scope?: 'page' | 'all' }
 * Ép tra cứu lại ngay (bỏ qua cache). Mỗi MST tốn 1 captcha nên giới hạn 200/lần.
 */
router.post('/partner-status/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const body = z.object({
      taxCodes: z.array(z.string()).max(200).optional(),
      scope:    z.enum(['page', 'all']).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError('Tham số không hợp lệ');

    let taxCodes = body.data.taxCodes ?? [];

    if (taxCodes.length === 0 || body.data.scope === 'all') {
      // Toàn bộ MST đối tác có hoá đơn trong 18 tháng gần nhất
      const { rows } = await pool.query<{ tax_code: string }>(
        `SELECT DISTINCT ${PARTNER_TAX_CODE_SQL} AS tax_code
           FROM invoices i
          WHERE i.company_id = $1
            AND i.deleted_at IS NULL
            AND i.invoice_date > NOW() - INTERVAL '18 months'
          LIMIT 200`,
        [companyId],
      );
      taxCodes = rows.map(r => r.tax_code).filter(Boolean);
    }

    const queued = await companyVerificationService.enqueue(taxCodes, companyId, true);
    return sendSuccess(res, {
      queued,
      message: queued > 0
        ? `Đã gửi ${queued} mã số thuế đi tra cứu — kết quả cập nhật sau vài phút`
        : 'Không có mã số thuế hợp lệ để tra cứu',
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/invoices/partner-status/labels — nhãn + mức rủi ro cho UI */
router.get('/partner-status/labels', (_req: Request, res: Response) => {
  const labels = (Object.keys(MST_STATUS_LABEL) as MstStatus[]).map(k => ({
    value: k, label: MST_STATUS_LABEL[k], risk: MST_STATUS_RISK[k],
  }));
  return sendSuccess(res, { labels });
});

// GET /api/invoices/trash — danh sách hóa đơn đã ẩn (OWNER/ADMIN only)
router.get('/trash', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const page     = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 50)));
    const tab      = req.query.tab === 'ignored' ? 'ignored' : 'deleted';
    const offset   = (page - 1) * pageSize;

    const condition = tab === 'ignored'
      ? `company_id = $1 AND is_permanently_ignored = true`
      : `company_id = $1 AND deleted_at IS NOT NULL AND is_permanently_ignored = false`;

    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM invoices WHERE ${condition}`, [companyId]),
      pool.query(
        `SELECT i.id, i.invoice_number, i.serial_number, i.invoice_date, i.direction,
                i.status, i.seller_name, i.seller_tax_code, i.buyer_name, i.buyer_tax_code,
                i.total_amount, i.vat_amount, i.deleted_at, i.delete_reason,
                i.is_permanently_ignored,
                u.full_name AS deleted_by_name
         FROM invoices i
         LEFT JOIN users u ON u.id = i.deleted_by
         WHERE ${condition}
         ORDER BY i.deleted_at DESC NULLS LAST
         LIMIT $2 OFFSET $3`,
        [companyId, pageSize, offset]
      ),
    ]);

    sendPaginated(res, dataRes.rows, Number(countRes.rows[0].count), page, pageSize);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invoices/bulk-delete — ẩn nhiều hóa đơn cùng lúc (OWNER/ADMIN)
router.delete('/bulk-delete', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const schema = z.object({
      ids:    z.array(z.string().uuid()).min(1).max(500),
      reason: z.enum(['duplicate', 'invalid', 'test_data', 'other']),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');
    const { ids, reason } = body.data;

    await pool.query(
      `UPDATE invoices
       SET deleted_at = NOW(), deleted_by = $1, delete_reason = $2
       WHERE id = ANY($3::uuid[]) AND company_id = $4 AND deleted_at IS NULL`,
      [userId, reason, ids, companyId]
    );
    await writeAuditLog(companyId, userId, 'bulk_delete', null, { ids, reason });
    sendSuccess(res, { count: ids.length }, `Đã ẩn ${ids.length} hóa đơn`);
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/bulk-restore — khôi phục nhiều hóa đơn (OWNER/ADMIN)
router.post('/bulk-restore', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const schema    = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
    const body      = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');
    const { ids } = body.data;

    await pool.query(
      `UPDATE invoices
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_permanently_ignored = false`,
      [ids, companyId]
    );
    await writeAuditLog(companyId, userId, 'bulk_restore', null, { ids });
    sendSuccess(res, { count: ids.length }, `Đã khôi phục ${ids.length} hóa đơn`);
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/bulk-permanent-ignore — bỏ qua vĩnh viễn nhiều HĐ (OWNER/ADMIN)
router.post('/bulk-permanent-ignore', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const schema    = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
    const body      = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');
    const { ids } = body.data;

    await pool.query(
      `UPDATE invoices
       SET is_permanently_ignored = true, deleted_at = NOW(), deleted_by = $3
       WHERE id = ANY($1::uuid[]) AND company_id = $2`,
      [ids, companyId, userId]
    );
    await writeAuditLog(companyId, userId, 'bulk_permanent_ignore', null, { ids });
    sendSuccess(res, { count: ids.length }, `Đã bỏ qua vĩnh viễn ${ids.length} hóa đơn`);
  } catch (err) {
    next(err);
  }
});

// ── Amended Invoice Routing (P50.2) ───────────────────────────────────────────

// POST /api/invoices/analyze-amendments
router.post('/analyze-amendments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const result = await amendedInvoiceRouter.analyzeAmendments(companyId);
    sendSuccess(res, { processed: result.length, data: result });
  } catch (err) { next(err); }
});

// GET /api/invoices/amendments?month=&year=
router.get('/amendments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { month, year, page, pageSize } = req.query as Record<string, string>;
    const now  = new Date();
    const pg   = Number(page ?? 1);
    const pgSz = Number(pageSize ?? 50);
    const offset = (pg - 1) * pgSz;
    const m = Number(month ?? now.getMonth() + 1);
    const y = Number(year  ?? now.getFullYear());
    const res2 = await pool.query(
      `SELECT id, invoice_number, invoice_date, invoice_relation_type, related_invoice_number,
              cross_period_flag, routing_decision, supplemental_declaration_needed,
              seller_name, total_amount
       FROM active_invoices
       WHERE company_id = $1
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR  FROM invoice_date) = $3
         AND invoice_relation_type IN ('replacement','adjustment')
       ORDER BY invoice_date DESC
       LIMIT $4 OFFSET $5`,
      [companyId, m, y, pgSz, offset],
    );
    sendSuccess(res, { data: res2.rows, meta: { page: pg, pageSize: pgSz } });
  } catch (err) { next(err); }
});

// ── Missing Invoice Finder (P50.3) ────────────────────────────────────────────

// GET /api/invoices/missing
router.get('/missing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { month, year, page, pageSize } = req.query as Record<string, string>;
    const now  = new Date();
    const pg   = Number(page ?? 1);
    const pgSz = Number(pageSize ?? 50);
    const result = await missingInvoiceFinder.getAlerts(
      companyId, 'open', pg, pgSz,
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
});

// POST /api/invoices/missing/scan
router.post('/missing/scan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const { month, year } = req.body as { month?: number; year?: number };
    const now = new Date();
    const results1 = await missingInvoiceFinder.scanCrossCompany(userId, month ?? now.getMonth() + 1, year ?? now.getFullYear());
    const results2 = await missingInvoiceFinder.scanGdtMismatch(companyId, month ?? now.getMonth() + 1, year ?? now.getFullYear());
    sendSuccess(res, {
      crossCompany: results1,
      gdtMismatch:  results2.missingCount,
      total:        results1 + results2.missingCount,
    });
  } catch (err) { next(err); }
});

// PATCH /api/invoices/missing/:id
router.patch('/missing/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { status, note } = req.body as { status: string; note?: string };
    if (!status) throw new ValidationError('status is required');
    await missingInvoiceFinder.updateStatus(req.params.id!, companyId, status as 'found' | 'not_applicable' | 'acknowledged', note);
    sendSuccess(res, { ok: true });
  } catch (err) { next(err); }
});

// ── Bulk update (category + payment) ─────────────────────────────────────────

// PATCH /api/invoices/bulk-update — gán mã hàng / mã KH / phương thức TT hàng loạt (OWNER/ADMIN)
router.patch('/bulk-update', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const schema = z.object({
      ids:     z.array(z.string().uuid()).min(1).max(500),
      updates: z.object({
        item_code:      z.string().max(100).optional(),
        customer_code:  z.string().max(100).optional(),
        payment_method: z.enum(['transfer', 'cash', 'card', 'cheque']).optional(),
      }).refine(u => Object.keys(u).length > 0, { message: 'At least one field required' }),
      only_missing: z.boolean().optional().default(false),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');

    const { ids, updates, only_missing } = body.data;
    const setClauses: string[] = [];
    const whereMissing: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.item_code !== undefined) {
      setClauses.push(`item_code = $${idx++}`);
      params.push(updates.item_code);
      if (only_missing) whereMissing.push(`(item_code IS NULL OR item_code = '')`);
    }
    if (updates.customer_code !== undefined) {
      setClauses.push(`customer_code = $${idx++}`);
      params.push(updates.customer_code);
      if (only_missing) whereMissing.push(`(customer_code IS NULL OR customer_code = '')`);
    }
    if (updates.payment_method !== undefined) {
      setClauses.push(`payment_method = $${idx++}, payment_method_source = 'manual'`);
      params.push(updates.payment_method);
    }

    if (setClauses.length === 0) throw new ValidationError('No fields to update');

    params.push(ids);
    params.push(companyId);

    const missingCond = whereMissing.length > 0 ? ` AND (${whereMissing.join(' OR ')})` : '';
    await pool.query(
      `UPDATE invoices SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = ANY($${idx}::uuid[]) AND company_id = $${idx + 1} AND deleted_at IS NULL${missingCond}`,
      params
    );
    await writeAuditLog(companyId, userId, 'bulk_update_category', null, { ids, updates });
    sendSuccess(res, { count: ids.length }, `Đã cập nhật ${ids.length} hóa đơn`);
  } catch (err) {
    next(err);
  }
});

// ─── PARAMETERIZED ROUTES — sau cùng để không bắt nhầm static paths ─────────

// PATCH /api/invoices/:id — cập nhật phân loại, thanh toán, ghi chú (ACCOUNTANT+)
router.patch('/:id', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const schema = z.object({
      item_code:       z.string().max(100).nullable().optional(),
      customer_code:   z.string().max(100).nullable().optional(),
      payment_method:  z.enum(['transfer', 'cash', 'card', 'cheque']).nullable().optional(),
      payment_date:    z.string().nullable().optional(),
      payment_due_date: z.string().nullable().optional(),
      notes:           z.string().max(1000).nullable().optional(),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');

    const updates = body.data;
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if ('item_code'       in updates) { setClauses.push(`item_code = $${idx++}`);        params.push(updates.item_code); }
    if ('customer_code'   in updates) { setClauses.push(`customer_code = $${idx++}`);    params.push(updates.customer_code); }
    if ('payment_method'  in updates) {
      setClauses.push(`payment_method = $${idx++}, payment_method_source = 'manual'`);
      params.push(updates.payment_method);
    }
    if ('payment_date'    in updates) { setClauses.push(`payment_date = $${idx++}`);     params.push(updates.payment_date); }
    if ('payment_due_date' in updates){ setClauses.push(`payment_due_date = $${idx++}`); params.push(updates.payment_due_date); }
    if ('notes'           in updates) { setClauses.push(`notes = $${idx++}`);            params.push(updates.notes); }

    if (setClauses.length === 0) throw new ValidationError('No fields to update');

    params.push(req.params.id);
    params.push(companyId);

    const result = await pool.query(
      `UPDATE invoices SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND company_id = $${idx + 1} AND deleted_at IS NULL
       RETURNING id`,
      params
    );
    if (!result.rows[0]) throw new NotFoundError('Invoice not found');
    await writeAuditLog(companyId, userId, 'update_category', req.params.id, updates);
    sendSuccess(res, { id: req.params.id });
  } catch (err) {
    next(err);
  }
});


router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT * FROM invoices WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user!.companyId]
    );
    if (!result.rows[0]) throw new NotFoundError('Invoice not found');

    const lineItems = await pool.query(
      `SELECT id, line_number, item_code, item_name, unit, quantity, unit_price,
              subtotal, vat_rate, vat_amount, total
       FROM invoice_line_items
       WHERE invoice_id = $1 AND company_id = $2
       ORDER BY line_number ASC NULLS LAST`,
      [req.params.id, req.user!.companyId]
    );

    // raw_xml/raw_detail có thể vài trăm KB — không trả trong payload chi tiết.
    // Bản gốc tải riêng qua GET /invoices/:id/original-xml.
    const { raw_xml, raw_detail, ...invoice } = result.rows[0] as Record<string, unknown>;
    sendSuccess(res, {
      ...invoice,
      has_raw_xml:    raw_xml != null,
      has_raw_detail: raw_detail != null,
      line_items:     lineItems.rows,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/line-items — thêm thủ công 1 dòng hàng hóa cho HĐ header-only (Nhóm 6/8)
router.post('/:id/line-items', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const invoiceId = req.params.id;

    // Validate body
    const schema = z.object({
      item_name: z.string().min(1).max(500).transform(s => s.trim()),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');

    // Load invoice — must belong to this company
    const { rows } = await pool.query(
      `SELECT id, subtotal, vat_amount, total_amount FROM invoices
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [invoiceId, companyId]
    );
    if (!rows[0]) throw new NotFoundError('Invoice not found');
    const inv = rows[0] as { id: string; subtotal: string; vat_amount: string; total_amount: string };

    const subtotal    = parseFloat(inv.subtotal)    || 0;
    const vatAmount   = parseFloat(inv.vat_amount)  || 0;
    const totalAmount = parseFloat(inv.total_amount)|| 0;
    // Compute effective VAT rate from amounts (round to nearest %)
    const computedRate = subtotal > 0 ? Math.round(vatAmount * 100 / subtotal) : 0;

    // Remove any previous manually-added line item (is_manual = true), then insert fresh
    await pool.query(
      `DELETE FROM invoice_line_items WHERE invoice_id = $1 AND company_id = $2 AND is_manual = true`,
      [invoiceId, companyId]
    );

    await pool.query(
      `INSERT INTO invoice_line_items
         (invoice_id, company_id, line_number, item_name, quantity, unit_price, subtotal, vat_rate, vat_amount, total, is_manual)
       VALUES ($1, $2, 1, $3, 1, $4, $4, $5, $6, $7, true)`,
      [invoiceId, companyId, body.data.item_name, subtotal, computedRate, vatAmount, totalAmount]
    );

    // Mark invoice as having line items
    await pool.query(
      `UPDATE invoices SET has_line_items = true WHERE id = $1 AND company_id = $2`,
      [invoiceId, companyId]
    );

    // Return updated invoice with line items
    const updatedLineItems = await pool.query(
      `SELECT id, line_number, item_code, item_name, unit, quantity, unit_price,
              subtotal, vat_rate, vat_amount, total, is_manual
       FROM invoice_line_items
       WHERE invoice_id = $1 AND company_id = $2
       ORDER BY line_number ASC NULLS LAST`,
      [invoiceId, companyId]
    );

    sendSuccess(res, { line_items: updatedLineItems.rows }, 'Đã thêm chi tiết hàng hóa');
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invoices/:id/line-items/manual — xóa dòng hàng nhập thủ công
router.delete('/:id/line-items/manual', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const invoiceId = req.params.id;

    const { rowCount } = await pool.query(
      `DELETE FROM invoice_line_items WHERE invoice_id = $1 AND company_id = $2 AND is_manual = true`,
      [invoiceId, companyId]
    );

    // If no more line items remain, reset has_line_items
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM invoice_line_items WHERE invoice_id = $1 AND company_id = $2`,
      [invoiceId, companyId]
    );
    if (Number(rows[0].count) === 0) {
      await pool.query(
        `UPDATE invoices SET has_line_items = false WHERE id = $1 AND company_id = $2`,
        [invoiceId, companyId]
      );
    }

    sendSuccess(res, { deleted: rowCount ?? 0 }, 'Đã xóa chi tiết thủ công');
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/sync — trigger manual GDT Bot sync
// NOTE: must be defined AFTER static routes but this is a POST so no conflict with GET /:id
router.post('/sync', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) throw new Error('Company not associated with user');

    // Accept explicit date range from body (UI always sends this now).
    // Validate: max 31 days per GDT rule. If not provided, fall back to smart default.
    const bodyFrom = typeof req.body?.from_date === 'string' ? req.body.from_date : null;
    const bodyTo   = typeof req.body?.to_date   === 'string' ? req.body.to_date   : null;
    if (bodyFrom && bodyTo) {
      const diff = new Date(bodyTo).getTime() - new Date(bodyFrom).getTime();
      if (diff < 0 || diff > 31 * 24 * 60 * 60 * 1000) {
        res.status(400).json({
          success: false,
          error: { code: 'DATE_RANGE_TOO_LARGE', message: 'Khoảng thời gian tối đa 31 ngày theo quy định GDT.' },
        });
        return;
      }
    }

    // ── Check if GDT Bot has been configured for this company ──
    const cfgRes = await pool.query(
      `SELECT id, is_active FROM gdt_bot_configs WHERE company_id = $1`,
      [companyId]
    );
    if (cfgRes.rows.length === 0) {
      res.status(428).json({
        success: false,
        error: {
          code: 'BOT_NOT_CONFIGURED',
          message: 'Chưa cấu hình đồng bộ GDT. Vui lòng nhập mật khẩu cổng thuế.',
        },
      });
      return;
    }
    if (!cfgRes.rows[0].is_active) {
      res.status(403).json({
        success: false,
        error: { code: 'BOT_DISABLED', message: 'GDT Bot hiện đang tắt.' },
      });
      return;
    }

    // ── Check for already-running or waiting bot sync for this company ──
    const { Queue } = await import('bullmq');
    const { env } = await import('../config/env');
    const botQueue = new Queue('gdt-bot-sync', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);

    const [activeJobs, waitingJobs] = await Promise.all([
      botQueue.getJobs(['active']),
      botQueue.getJobs(['waiting']),
    ]);
    const inFlight = [...activeJobs, ...waitingJobs].find(
      (j) => j.data.companyId === companyId
    );
    if (inFlight) {
      res.status(409).json({
        success: false,
        error: {
          code: 'SYNC_ALREADY_RUNNING',
          message: 'Đang có đồng bộ đang chạy cho công ty này. Vui lòng đợi hoàn tất.',
        },
      });
      return;
    }

    // ── Determine fromDate / toDate ─────────────────────────────────────────
    // Priority: (1) explicit body params → (2) last successful run - 5min → (3) start of current month
    let fromDate: string;
    let toDate: string;
    if (bodyFrom && bodyTo) {
      fromDate = bodyFrom;
      toDate   = bodyTo;
    } else {
      const now = new Date();
      const lastRunRes = await pool.query<{ finished_at: Date }>(
        `SELECT finished_at FROM gdt_bot_runs
         WHERE company_id = $1 AND status = 'success'
         ORDER BY finished_at DESC LIMIT 1`,
        [companyId]
      );
      // Default: start of current month (NOT 24 months — GDT only allows 1 month)
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]!;
      fromDate = lastRunRes.rows.length
        ? new Date(lastRunRes.rows[0].finished_at.getTime() - 5 * 60 * 1000).toISOString().split('T')[0]!
        : startOfMonth;
      toDate = now.toISOString().split('T')[0]!;
      // Safety clamp: never exceed 31 days even in fallback path
      if (new Date(toDate).getTime() - new Date(fromDate).getTime() > 31 * 24 * 60 * 60 * 1000) {
        fromDate = new Date(new Date(toDate).getTime() - 31 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
      }
    };

    const jobId = `gdt-bot-manual-${companyId}-${Date.now()}`;
    const job = await botQueue.add('sync', {
      companyId,
      fromDate,
      toDate,
    }, {
      jobId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 30000 },
    });

    sendSuccess(res, { jobId: job.id, fromDate, toDate }, 'Sync job queued');
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invoices/:id — ẩn mềm một hóa đơn
router.delete('/:id', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const schema = z.object({
      reason: z.enum(['duplicate', 'invalid', 'test_data', 'other']),
      note:   z.string().max(200).optional(),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');
    const { reason, note } = body.data;

    const result = await pool.query(
      `UPDATE invoices
       SET deleted_at = NOW(), deleted_by = $1, delete_reason = $2
       WHERE id = $3 AND company_id = $4 AND deleted_at IS NULL
       RETURNING id`,
      [userId, reason, req.params.id, companyId]
    );
    if (!result.rowCount) throw new NotFoundError('Invoice not found or already deleted');

    await writeAuditLog(companyId, userId, 'delete', req.params.id, { reason, note });
    sendSuccess(res, null, 'Hóa đơn đã được ẩn');
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invoices/:id/permanent-ignore — bỏ qua vĩnh viễn (OWNER/ADMIN)
router.delete('/:id/permanent-ignore', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const schema = z.object({
      reason:  z.string().min(1).max(200),
      confirm: z.literal('IGNORE_PERMANENTLY'),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) throw new ValidationError('Phải gửi confirm: "IGNORE_PERMANENTLY" để xác nhận');

    const result = await pool.query(
      `UPDATE invoices
       SET is_permanently_ignored = true, deleted_at = COALESCE(deleted_at, NOW()),
           deleted_by = COALESCE(deleted_by, $1), delete_reason = $2
       WHERE id = $3 AND company_id = $4
       RETURNING id`,
      [userId, body.data.reason, req.params.id, companyId]
    );
    if (!result.rowCount) throw new NotFoundError('Invoice not found');

    await writeAuditLog(companyId, userId, 'permanent_ignore', req.params.id, { reason: body.data.reason });
    sendSuccess(res, null, 'Hóa đơn đã bị bỏ qua vĩnh viễn — bot sẽ không tải lại');
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/restore — khôi phục hóa đơn đã ẩn
router.post('/:id/restore', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;

    const result = await pool.query(
      `UPDATE invoices
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NOT NULL
         AND is_permanently_ignored = false
       RETURNING id`,
      [req.params.id, companyId]
    );
    if (!result.rowCount) {
      const ignored = await pool.query(
        `SELECT is_permanently_ignored FROM invoices WHERE id = $1 AND company_id = $2`,
        [req.params.id, companyId]
      );
      if (ignored.rows[0]?.is_permanently_ignored) {
        throw new ForbiddenError('Hóa đơn đã bị bỏ qua vĩnh viễn, không thể khôi phục');
      }
      throw new NotFoundError('Invoice not found or not in trash');
    }

    await writeAuditLog(companyId, userId, 'restore', req.params.id, {});
    sendSuccess(res, null, 'Hóa đơn đã được khôi phục');
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/:id/line-items — bổ sung chi tiết hàng hóa cho HĐ nhóm 6/8
const lineItemSchema = z.object({
  items: z.array(z.object({
    line_number: z.number().int().positive(),
    item_name: z.string().min(1).max(500),
    unit: z.string().max(50).optional(),
    quantity: z.number().positive().optional(),
    unit_price: z.number().min(0).optional(),
    subtotal: z.number().min(0),
    vat_rate: z.number().min(0).max(100),
    vat_amount: z.number().min(0),
    total: z.number().min(0),
  })).min(1).max(200),
});

router.post('/:id/line-items', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId = req.user!.userId;
    const invoiceId = req.params.id;

    // Verify invoice exists, belongs to company, and is Group 6 or 8
    const inv = await pool.query(
      `SELECT id, invoice_group FROM invoices WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [invoiceId, companyId],
    );
    if (!inv.rows[0]) throw new NotFoundError('Invoice not found');
    const group = inv.rows[0].invoice_group;
    if (group !== 6 && group !== 8) {
      throw new ValidationError('Chỉ cho phép bổ sung chi tiết cho hóa đơn nhóm 6 hoặc 8 (không có mã CQT).');
    }

    const body = lineItemSchema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid line items');
    const { items } = body.data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Remove existing manual line items for this invoice
      await client.query(
        `DELETE FROM invoice_line_items WHERE invoice_id = $1 AND company_id = $2`,
        [invoiceId, companyId],
      );
      // Insert new line items
      for (const item of items) {
        await client.query(
          `INSERT INTO invoice_line_items
           (invoice_id, company_id, line_number, item_name, unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [invoiceId, companyId, item.line_number, item.item_name, item.unit ?? null,
           item.quantity ?? null, item.unit_price ?? null, item.subtotal, item.vat_rate, item.vat_amount, item.total],
        );
      }
      // Update has_line_items flag
      await client.query(
        `UPDATE invoices SET has_line_items = true WHERE id = $1 AND company_id = $2`,
        [invoiceId, companyId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await writeAuditLog(companyId, userId, 'add_line_items', invoiceId, { count: items.length });
    sendSuccess(res, { count: items.length }, `Đã bổ sung ${items.length} dòng chi tiết.`);
  } catch (err) {
    next(err);
  }
});

// ── Cash Payment Risk (P50.1) ─────────────────────────────────────────────────

// GET /api/invoices/cash-risk-summary
router.get('/cash-risk-summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { month, year } = req.query as Record<string, string>;
    const now = new Date();
    const summary = await cashPaymentDetector.getSummary(
      companyId,
      month ? Number(month) : now.getMonth() + 1,
      year  ? Number(year)  : now.getFullYear(),
    );
    sendSuccess(res, summary);
  } catch (err) { next(err); }
});

// POST /api/invoices/cash-risk-scan
router.post('/cash-risk-scan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { month, year } = req.body as { month?: number; year?: number };
    const result = await cashPaymentDetector.scanCompany(companyId, month, year);
    sendSuccess(res, result);
  } catch (err) { next(err); }
});

// PATCH /api/invoices/:id/payment-method
router.patch('/:id/payment-method', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const { method, note } = req.body as { method: 'cash' | 'bank_transfer' | 'cheque' | 'card' | 'mixed'; note?: string };
    if (!method) throw new ValidationError('method is required');
    await cashPaymentDetector.setPaymentMethod(req.params.id!, method, userId, companyId);
    sendSuccess(res, { ok: true });
  } catch (err) { next(err); }
});

// POST /api/invoices/bulk-payment-method
router.post('/bulk-payment-method', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const { invoiceIds, method } = req.body as { invoiceIds: string[]; method: 'cash' | 'bank_transfer' | 'cheque' | 'card' | 'mixed' };
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) throw new ValidationError('invoiceIds required');
    if (!method) throw new ValidationError('method is required');
    const count = await cashPaymentDetector.bulkSetPaymentMethod(invoiceIds, method, userId, companyId);
    sendSuccess(res, { updated: count });
  } catch (err) { next(err); }
});

// PATCH /api/invoices/:id/cash-risk-acknowledge
router.patch('/:id/cash-risk-acknowledge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const userId    = req.user!.userId;
    const { note } = req.body as { note?: string };
    await cashPaymentDetector.acknowledge(req.params.id!, userId, companyId, note);
    sendSuccess(res, { ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/invoices/:id/non-deductible — đánh dấu hoá đơn không đủ điều kiện khấu trừ
router.patch('/:id/non-deductible', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const { non_deductible } = z.object({ non_deductible: z.boolean() }).parse(req.body);
    const { rows } = await pool.query(
      `UPDATE invoices SET non_deductible = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3 AND deleted_at IS NULL
       RETURNING id, non_deductible`,
      [non_deductible, req.params.id, companyId]
    );
    if (!rows[0]) throw new NotFoundError('Invoice not found');
    sendSuccess(res, rows[0]);
  } catch (err) { next(err); }
});

export default router;
