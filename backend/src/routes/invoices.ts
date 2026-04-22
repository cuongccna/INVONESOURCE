import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';
import { cashPaymentDetector } from '../services/CashPaymentDetector';
import { amendedInvoiceRouter } from '../services/AmendedInvoiceRouter';
import { missingInvoiceFinder } from '../services/MissingInvoiceFinder';

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
  status: z.enum(['valid', 'cancelled', 'replaced', 'replaced_original', 'adjusted', 'invalid']).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  search: z.string().optional(),
  importSessionId: z.string().uuid().optional(),
  invoiceGroup: z.coerce.number().int().optional(),
  isSco: z.enum(['true', 'false']).optional(),
});

// GET /api/invoices
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listSchema.safeParse(req.query);
    if (!query.success) throw new ValidationError(query.error.issues[0]?.message ?? 'Invalid query');

    const { page, pageSize, direction, status, fromDate, toDate, search, importSessionId, invoiceGroup, isSco } = query.data;
    const companyId = req.user!.companyId;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['company_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [companyId];
    let idx = 2;

    if (direction) { conditions.push(`direction = $${idx++}`); params.push(direction); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (fromDate) { conditions.push(`invoice_date >= $${idx++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`invoice_date <= $${idx++}`); params.push(toDate); }
    if (importSessionId) { conditions.push(`import_session_id = $${idx++}`); params.push(importSessionId); }
    if (invoiceGroup != null) { conditions.push(`invoice_group = $${idx++}`); params.push(invoiceGroup); }
    if (isSco != null) { conditions.push(`is_sco = $${idx++}`); params.push(isSco === 'true'); }
    if (search) {
      conditions.push(`(invoice_number ILIKE $${idx} OR seller_name ILIKE $${idx} OR buyer_name ILIKE $${idx} OR seller_tax_code ILIKE $${idx} OR buyer_tax_code ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.join(' AND ');

    const [countResult, dataResult, summaryResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM invoices WHERE ${where}`, params),
      pool.query(
        `SELECT id, invoice_number, serial_number, invoice_date, direction, status,
                seller_name, seller_tax_code, buyer_name, buyer_tax_code,
                subtotal, total_amount, vat_amount, vat_rate, gdt_validated, provider,
                invoice_group, serial_has_cqt, has_line_items,
                payment_method,
                COALESCE(customer_code, NULL)::TEXT AS customer_code,
                COALESCE(item_code, NULL)::TEXT     AS item_code,
                COALESCE(notes, NULL)::TEXT          AS notes,
                tc_hdon, khhd_cl_quan, so_hd_cl_quan,
                non_deductible
         FROM invoices WHERE ${where}
         ORDER BY invoice_date DESC
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

    const summary = {
      count:    totalCount,
      subtotal: totalSubtotal,
      vat:      totalVat,
      by_status: byStatus,
    };

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
              i.payment_method, i.customer_code, i.item_code, i.notes,
              CASE WHEN i.direction='output' THEN i.buyer_name ELSE i.seller_name END AS party_name,
              (SELECT STRING_AGG(li.item_name, '; ') FROM invoice_line_items li WHERE li.invoice_id = i.id LIMIT 3) AS item_name
       FROM invoices i WHERE ${where}
       ORDER BY i.invoice_date DESC
       LIMIT 5000`,
      params
    );

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'INVONE Platform';
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
        const hasBotSource = existRows.some((r) => r.source === 'gdt_bot');
        const code = hasBotSource ? 'NO_XML_BOT_SOURCE' : 'NO_XML';
        const message = hasBotSource
          ? 'Hóa đơn từ GDT Bot không có file XML gốc — bot chỉ lưu dữ liệu JSON. Chạy lại Backfill XML để lấy về.'
          : 'Các hóa đơn chưa có file XML đính kèm.';
        return res.status(404).json({ success: false, error: { code, message } });
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

    sendSuccess(res, { ...result.rows[0], line_items: lineItems.rows });
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
