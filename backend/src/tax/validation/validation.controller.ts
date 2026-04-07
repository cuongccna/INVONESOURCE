import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { authenticate, requireRole } from '../../middleware/auth';
import { requireCompany } from '../../middleware/company';
import { ValidationError, ForbiddenError } from '../../utils/AppError';
import { sendSuccess, sendPaginated } from '../../utils/response';
import { InvoiceValidationPipeline } from './invoice-validation.pipeline';
import type { InvoiceRow } from './types';

const router = Router();
router.use(authenticate);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const validateInvoicesSchema = z.object({
  mst: z.string().min(1),
  period: z.string().regex(
    /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/,
    'period phải là YYYY-MM hoặc YYYY-QN (ví dụ: 2026-Q1 hoặc 2026-03)'
  ),
  direction: z.enum(['input', 'output', 'both']),
  invoice_ids: z.array(z.string().uuid()).optional(),
  user_payment_flags: z.record(z.string(), z.boolean()).optional(),
  user_non_business_flags: z.record(z.string(), z.boolean()).optional(),
});

const updatePluginConfigSchema = z.array(z.object({
  mst: z.string().min(1),
  plugin_name: z.string().min(1),
  enabled: z.boolean(),
  priority_override: z.number().int().positive().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}));

// ─── POST /validate-invoices ──────────────────────────────────────────────────
/**
 * Validate invoices before running a tax declaration.
 * Applies to the active company (from requireCompany middleware) unless admin specifies mst.
 *
 * Body: { mst, period, direction, invoice_ids?, user_payment_flags?, user_non_business_flags? }
 * Response: PipelineValidationOutput
 */
router.post(
  '/validate-invoices',
  requireCompany,
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = validateInvoicesSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ');
      }

      const { mst, period, direction, invoice_ids, user_payment_flags, user_non_business_flags } =
        parsed.data;

      // Verify this mst belongs to a company the user can access
      const companyCheck = await pool.query(
        `SELECT id FROM companies WHERE tax_code = $1 AND id = $2`,
        [mst, req.user!.companyId]
      );
      if (!companyCheck.rows[0]) {
        throw new ForbiddenError('MST không thuộc công ty đang hoạt động');
      }

      // Parse period into month/year or quarter/year for DB query
      const { startDate, endDate } = periodToDateRange(period);

      // Determine declaration_type
      const declaration_type = period.includes('Q') ? 'quarterly' : 'monthly';

      // Fetch invoices
      let invoiceQuery = `
        SELECT id, company_id, direction, status, invoice_number, serial_number,
               invoice_date, seller_tax_code, seller_name, buyer_tax_code, buyer_name,
               total_amount, vat_amount, payment_method, gdt_validated,
               invoice_group, serial_has_cqt, has_line_items,
               mccqt, tc_hdon, lhd_cl_quan, khhd_cl_quan, so_hd_cl_quan
        FROM invoices
        WHERE company_id = $1
          AND deleted_at IS NULL
          AND invoice_date >= $2
          AND invoice_date < $3`;

      const params: unknown[] = [req.user!.companyId, startDate, endDate];

      if (direction !== 'both') {
        params.push(direction);
        invoiceQuery += ` AND direction = $${params.length}`;
      }

      if (invoice_ids && invoice_ids.length > 0) {
        params.push(invoice_ids);
        invoiceQuery += ` AND id = ANY($${params.length}::uuid[])`;
      }

      const { rows: invoices } = await pool.query<InvoiceRow>(invoiceQuery, params);

      const pipeline = new InvoiceValidationPipeline();
      const output = await pipeline.validate(invoices, {
        mst,
        declaration_period: period,
        declaration_type,
        direction,
        user_payment_flags,
        user_non_business_flags,
      });

      sendSuccess(res, output);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /validation-log ──────────────────────────────────────────────────────
/**
 * Retrieve validation audit log entries.
 * Query: { mst, period, status?, run_id?, page?, pageSize? }
 */
router.get(
  '/validation-log',
  requireCompany,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const mst = String(req.query.mst ?? '');
      const period = String(req.query.period ?? '');
      if (!mst || !period) {
        throw new ValidationError('Thiếu tham số mst hoặc period');
      }

      // Verify access
      const companyCheck = await pool.query(
        `SELECT id FROM companies WHERE tax_code = $1 AND id = $2`,
        [mst, req.user!.companyId]
      );
      if (!companyCheck.rows[0]) {
        throw new ForbiddenError('MST không thuộc công ty đang hoạt động');
      }

      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)));
      const offset = (page - 1) * pageSize;

      const conditions: string[] = [`mst = $1`, `declaration_period = $2`];
      const params: unknown[] = [mst, period];

      if (req.query.status) {
        params.push(req.query.status);
        conditions.push(`status = $${params.length}`);
      }
      if (req.query.run_id) {
        params.push(req.query.run_id);
        conditions.push(`pipeline_run_id = $${params.length}`);
      }

      const where = conditions.join(' AND ');

      const [countResult, dataResult] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM invoice_validation_log WHERE ${where}`, params),
        pool.query(
          `SELECT id, invoice_id, mst, declaration_period, direction, status,
                  reason_codes, reason_detail, plugin_name, validated_at, pipeline_run_id
           FROM invoice_validation_log
           WHERE ${where}
           ORDER BY validated_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset]
        ),
      ]);

      sendPaginated(
        res,
        dataResult.rows,
        Number(countResult.rows[0].count),
        page,
        pageSize
      );
    } catch (err) {
      next(err);
    }
  }
);

// ─── PATCH /admin/validation-plugins ─────────────────────────────────────────
/**
 * Enable/disable/configure plugins. Admin only.
 * Body: Array of { mst, plugin_name, enabled, priority_override?, config? }
 */
router.patch(
  '/admin/validation-plugins',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = updatePluginConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ');
      }

      const updates = parsed.data;
      const updatedBy = req.user!.email ?? req.user!.userId;

      // Upsert each plugin config
      for (const cfg of updates) {
        await pool.query(
          `INSERT INTO validation_plugin_configs
             (mst, plugin_name, enabled, priority_override, config, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (mst, plugin_name) DO UPDATE SET
             enabled          = EXCLUDED.enabled,
             priority_override = EXCLUDED.priority_override,
             config           = EXCLUDED.config,
             updated_by       = EXCLUDED.updated_by,
             updated_at       = NOW()`,
          [
            cfg.mst,
            cfg.plugin_name,
            cfg.enabled,
            cfg.priority_override ?? null,
            JSON.stringify(cfg.config ?? {}),
            updatedBy,
          ]
        );
      }

      sendSuccess(res, { updated: updates.length }, 'Cập nhật cấu hình plugin thành công');
    } catch (err) {
      next(err);
    }
  }
);

// ─── Helper: period string → date range ──────────────────────────────────────
function periodToDateRange(period: string): { startDate: Date; endDate: Date } {
  // Format: 'YYYY-MM' → monthly  |  'YYYY-QN' → quarterly
  const quarterMatch = period.match(/^(\d{4})-Q([1-4])$/);
  if (quarterMatch) {
    const year = parseInt(quarterMatch[1], 10);
    const quarter = parseInt(quarterMatch[2], 10);
    const startMonth = (quarter - 1) * 3 + 1; // Q1→1, Q2→4, Q3→7, Q4→10
    const endMonth = startMonth + 3;
    const startDate = new Date(year, startMonth - 1, 1);
    const endDate = new Date(year, endMonth - 1, 1);
    return { startDate, endDate };
  }

  const monthMatch = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);
    return { startDate, endDate };
  }

  throw new ValidationError(`Định dạng period không hợp lệ: ${period}`);
}

export default router;
