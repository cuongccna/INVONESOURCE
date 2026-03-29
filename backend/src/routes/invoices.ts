import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';

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
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  direction: z.enum(['output', 'input']).optional(),
  status: z.enum(['valid', 'cancelled', 'replaced', 'adjusted', 'invalid']).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  search: z.string().optional(),
  importSessionId: z.string().uuid().optional(),
});

// GET /api/invoices
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = listSchema.safeParse(req.query);
    if (!query.success) throw new ValidationError(query.error.issues[0]?.message ?? 'Invalid query');

    const { page, pageSize, direction, status, fromDate, toDate, search, importSessionId } = query.data;
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
    if (search) {
      conditions.push(`(invoice_number ILIKE $${idx} OR seller_name ILIKE $${idx} OR buyer_name ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.join(' AND ');

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM invoices WHERE ${where}`, params),
      pool.query(
        `SELECT id, invoice_number, serial_number, invoice_date, direction, status,
                seller_name, seller_tax_code, buyer_name, buyer_tax_code,
                total_amount, vat_amount, vat_rate, gdt_validated, provider
         FROM invoices WHERE ${where}
         ORDER BY invoice_date DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, pageSize, offset]
      ),
    ]);

    sendPaginated(res, dataResult.rows, Number(countResult.rows[0].count), page, pageSize);
  } catch (err) {
    next(err);
  }
});

// ─── STATIC ROUTES — phải đặt trước /:id để Express không nhầm ─────────────

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

// ─── PARAMETERIZED ROUTES — sau cùng để không bắt nhầm static paths ─────────

// GET /api/invoices/:id
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

export default router;
