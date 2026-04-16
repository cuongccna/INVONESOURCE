import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/AppError';

const router = Router();
router.use(authenticate);

const companySchema = z.object({
  name: z.string().min(1).max(255),
  tax_code: z.string().min(1).max(20),
  address: z.string().optional().default(''),
  phone: z.string().optional().default(''),
  email: z.string().email().optional().or(z.literal('')).default(''),
  company_type: z.enum(['household', 'enterprise', 'branch']).default('enterprise'),
  fiscal_year_start: z.coerce.number().int().min(1).max(12).default(1),
  organization_id: z.string().uuid().optional().nullable(),
  parent_id: z.string().uuid().optional().nullable(),
  level: z.coerce.number().int().min(1).max(20).optional(),
  entity_type: z.enum(['company', 'branch', 'representative_office', 'project']).optional(),
  is_consolidated: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.company_type === 'household') {
    // HKD: CMND (9 số), MST thường (10 số), GTTT khác (11 số), CCCD (12 số)
    if (!/^\d{9}$|^\d{10}$|^\d{11}$|^\d{12}$/.test(data.tax_code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hộ kinh doanh: MST/Giấy tờ tùy thân phải là 9, 10, 11 hoặc 12 chữ số',
        path: ['tax_code'],
      });
    }
  } else {
    // Doanh nghiệp: 10 chữ số (hoặc 13 ký tự cho mã chi nhánh)
    if (!/^\d{10}(-\d{3})?$/.test(data.tax_code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MST phải là 10 chữ số (hoặc 13 ký tự cho chi nhánh: 0123456789-001)',
        path: ['tax_code'],
      });
    }
  }
});

type CompanyTreeNode = {
  id: string;
  name: string;
  tax_code: string;
  level: number;
  entity_type: string;
  organization_id: string | null;
  parent_id: string | null;
  is_consolidated: boolean;
  children: CompanyTreeNode[];
};

// GET /api/companies — list companies for the current user
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.tax_code, c.address, c.phone, c.email,
              c.company_type, c.fiscal_year_start, c.onboarded, c.created_at,
              c.organization_id, c.parent_id, c.level, c.entity_type, c.is_consolidated,
              uc.role
       FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
       WHERE c.deleted_at IS NULL
       ORDER BY c.name ASC`,
      [req.user!.userId]
    );
    sendSuccess(res, rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/companies/tree?organizationId=... — nested hierarchy for current user
router.get('/tree', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.query.organizationId as string | undefined;
    if (organizationId && !z.string().uuid().safeParse(organizationId).success) {
      throw new ValidationError('organizationId không hợp lệ');
    }

    const params: unknown[] = [req.user!.userId];
    const organizationFilter = organizationId ? ` AND c.organization_id = $${params.push(organizationId)}` : '';

    const { rows } = await pool.query<{
      id: string;
      name: string;
      tax_code: string;
      level: number;
      entity_type: string;
      organization_id: string | null;
      parent_id: string | null;
      is_consolidated: boolean;
    }>(
      `SELECT c.id, c.name, c.tax_code,
              COALESCE(c.level, 1) AS level,
              COALESCE(c.entity_type::text, 'company') AS entity_type,
              c.organization_id, c.parent_id, COALESCE(c.is_consolidated, false) AS is_consolidated
       FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
       WHERE c.deleted_at IS NULL${organizationFilter}
       ORDER BY c.level ASC, c.name ASC`,
      params
    );

    const nodeMap = new Map<string, CompanyTreeNode>();
    for (const r of rows) {
      nodeMap.set(r.id, {
        id: r.id,
        name: r.name,
        tax_code: r.tax_code,
        level: Number(r.level ?? 1),
        entity_type: r.entity_type,
        organization_id: r.organization_id,
        parent_id: r.parent_id,
        is_consolidated: Boolean(r.is_consolidated),
        children: [],
      });
    }

    const roots: CompanyTreeNode[] = [];
    for (const node of nodeMap.values()) {
      const parent = node.parent_id ? nodeMap.get(node.parent_id) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const sortTree = (nodes: CompanyTreeNode[]) => {
      nodes.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, 'vi'));
      nodes.forEach((n) => sortTree(n.children));
    };
    sortTree(roots);

    sendSuccess(res, roots);
  } catch (err) {
    next(err);
  }
});

// POST /api/companies — create new company (user becomes OWNER)
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = companySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    const {
      name,
      tax_code,
      address,
      phone,
      email,
      company_type,
      fiscal_year_start,
      organization_id,
      parent_id,
      level,
      entity_type,
      is_consolidated,
    } = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = uuidv4();
      const { rows } = await client.query(
        `INSERT INTO companies (
           id, name, tax_code, address, phone, email,
           company_type, fiscal_year_start, onboarded,
           organization_id, parent_id, level, entity_type, is_consolidated
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11, $12, $13)
         RETURNING id, name, tax_code, address, phone, email,
                   company_type, fiscal_year_start, onboarded, created_at,
                   organization_id, parent_id, level, entity_type, is_consolidated`,
        [
          id,
          name,
          tax_code,
          address,
          phone,
          email || null,
          company_type,
          fiscal_year_start,
          organization_id ?? null,
          parent_id ?? null,
          level ?? 1,
          entity_type ?? 'company',
          is_consolidated ?? false,
        ]
      );
      await client.query(
        `INSERT INTO user_companies (user_id, company_id, role) VALUES ($1, $2, 'OWNER')`,
        [req.user!.userId, id]
      );
      await client.query('COMMIT');
      sendSuccess(res, { ...rows[0], role: 'OWNER' }, undefined, 201);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/companies/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.tax_code, c.address, c.phone, c.email,
              c.company_type, c.fiscal_year_start, c.onboarded, c.created_at, c.updated_at,
              c.organization_id, c.parent_id, c.level, c.entity_type, c.is_consolidated,
              uc.role
       FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $2
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [req.params.id, req.user!.userId]
    );
    if (!rows[0]) throw new NotFoundError('Company not found');
    sendSuccess(res, rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/companies/:id — update (OWNER or ADMIN only)
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const access = await pool.query(
      'SELECT role FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [req.user!.userId, req.params.id]
    );
    if (!access.rows[0]) throw new NotFoundError('Company not found');
    if (!['OWNER', 'ADMIN'].includes(access.rows[0].role as string)) {
      throw new ForbiddenError('Chỉ OWNER hoặc ADMIN mới được cập nhật thông tin công ty');
    }

    const parsed = companySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    const {
      name,
      tax_code,
      address,
      phone,
      email,
      company_type,
      fiscal_year_start,
      organization_id,
      parent_id,
      level,
      entity_type,
      is_consolidated,
    } = parsed.data;
    const { rows } = await pool.query(
      `UPDATE companies
       SET name=$1, tax_code=$2, address=$3, phone=$4, email=$5,
           company_type=$6, fiscal_year_start=$7,
           organization_id=$8, parent_id=$9, level=$10,
           entity_type=$11, is_consolidated=$12,
           updated_at=NOW()
       WHERE id=$13 AND deleted_at IS NULL
       RETURNING id, name, tax_code, address, phone, email,
                 company_type, fiscal_year_start, onboarded,
                 organization_id, parent_id, level, entity_type, is_consolidated`,
      [
        name,
        tax_code,
        address,
        phone,
        email || null,
        company_type,
        fiscal_year_start,
        organization_id ?? null,
        parent_id ?? null,
        level ?? 1,
        entity_type ?? 'company',
        is_consolidated ?? false,
        req.params.id,
      ]
    );
    if (!rows[0]) throw new NotFoundError('Company not found');
    sendSuccess(res, rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/companies/:id/onboarded — mark onboarding complete
router.patch('/:id/onboarded', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await pool.query(
      `UPDATE companies SET onboarded = true, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/companies/:id — xóa vĩnh viễn toàn bộ dữ liệu công ty (OWNER only, yêu cầu mật khẩu)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Validate request body — password required
    const parsed = z.object({
      password: z.string().min(1, 'Vui lòng nhập mật khẩu để xác nhận xóa'),
    }).safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Thiếu mật khẩu xác nhận');

    // 2. Check OWNER role
    const access = await pool.query<{ role: string }>(
      'SELECT role FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [req.user!.userId, req.params.id]
    );
    if (!access.rows[0]) throw new NotFoundError('Không tìm thấy công ty');
    if (access.rows[0].role !== 'OWNER') throw new ForbiddenError('Chỉ OWNER mới được xóa công ty');

    // 3. Verify current user’s password (prevent unauthorized deletion)
    const userRow = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user!.userId]
    );
    if (!userRow.rows[0]) throw new NotFoundError('User not found');
    const passwordValid = await bcrypt.compare(parsed.data.password, userRow.rows[0].password_hash);
    if (!passwordValid) throw new ForbiddenError('Mật khẩu không chính xác');

    const companyId = req.params.id;

    // 4. Hard-delete inside a single transaction
    //    Order: delete tables WITHOUT ON DELETE CASCADE first, then delete
    //    the company row (which will cascade-delete all remaining children).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── Tables with NO FK or NO CASCADE on company_id ──────────────────────
      // gdt_bot_runs has company_id UUID NOT NULL (no REFERENCES declared)
      await client.query('DELETE FROM gdt_bot_runs      WHERE company_id = $1', [companyId]);
      // import_temp_files has company_id UUID NOT NULL (no REFERENCES declared)
      await client.query('DELETE FROM import_temp_files WHERE company_id = $1', [companyId]);
      // bot_failed_jobs has nullable FK without ON DELETE CASCADE
      await client.query('DELETE FROM bot_failed_jobs   WHERE company_id = $1', [companyId]);
      // audit_logs has company_id UUID REFERENCES companies(id) WITHOUT CASCADE (013_soft_delete.sql)
      await client.query('DELETE FROM audit_logs        WHERE company_id = $1', [companyId]);

      // ── Tables whose FK points at invoices.id without cascade ────────
      // (gdt_validation_queue has ON DELETE CASCADE from invoices per 002 migration,
      //  but we delete explicitly here to be safe before invoices is removed)
      await client.query(
        'DELETE FROM gdt_validation_queue WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)',
        [companyId]
      );

      // ── Delete the company — PG cascades everything else ─────────────────
      // Tables covered by ON DELETE CASCADE from companies:
      //   invoice_line_items, invoices, gdt_bot_configs, import_sessions,
      //   import_templates, tax_declarations (-> declaration_attachments),
      //   vat_reconciliations, cash_book_entries, inventory_movements,
      //   profit_loss_statements, hkd_tax_statements, sync_logs, notifications,
      //   company_connectors, user_companies, customer_rfm, dismissed_anomalies,
      //   price_alerts, product_catalog, telegram_chat_configs, company_settings,
      //   esg_estimates, insights_cache, repurchase_predictions, price_anomalies,
      //   audit_rule_configs, code_sequences, customer_catalog, supplier_catalog,
      //   missing_invoice_alerts, tax_rate_anomalies, company_risk_flags,
      //   raw_invoice_data
      await client.query('DELETE FROM companies WHERE id = $1', [companyId]);

      await client.query('COMMIT');
      sendSuccess(res, null, 'Đã xóa công ty và toàn bộ dữ liệu liên quan');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

export default router;
