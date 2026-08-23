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
    // HKD: CMND 9 số / MST 10 số / CCCD 12 số / một số HKD địa phương 13 số
    if (!/^\d{9,13}$/.test(data.tax_code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Hộ kinh doanh: MST/Giấy tờ tùy thân phải là từ 9 đến 13 chữ số',
        path: ['tax_code'],
      });
    }
  } else {
    // Doanh nghiệp / Chi nhánh: 10 chữ số, hoặc 10+"-"+3 cho chi nhánh (vd: 0123456789-001)
    if (!/^\d{10}(-\d{3})?$/.test(data.tax_code)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MST phải là 10 chữ số (hoặc 14 ký tự cho chi nhánh: 0123456789-001)',
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

    // ── Enforce max_companies from user's license plan ──────────────────────
    const userId = req.user!.userId;
    const companyCountRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM user_companies WHERE user_id = $1`,
      [userId],
    );
    const currentCount = parseInt(companyCountRes.rows[0]?.cnt ?? '0', 10);

    // Look up the user's plan limit (default to 1 if no subscription)
    const planLimitRes = await pool.query<{ max_companies: number }>(
      `SELECT lp.max_companies
       FROM user_subscriptions us
       JOIN license_plans lp ON lp.id = us.plan_id
       WHERE us.user_id = $1 AND us.status IN ('active', 'trial')
       LIMIT 1`,
      [userId],
    );
    const maxCompanies = planLimitRes.rows[0]?.max_companies ?? 1;

    if (currentCount >= maxCompanies) {
      throw new ForbiddenError(
        `Gói dịch vụ của bạn cho phép tối đa ${maxCompanies} công ty. ` +
        `Bạn đã có ${currentCount} công ty. Vui lòng nâng cấp gói để thêm công ty mới.`
      );
    }

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
/**
 * F9 — HỒ SƠ THUẾ CỦA CÔNG TY
 *
 * Những thông tin bắt buộc trên header tờ khai mà trước đây bỏ trống:
 * cơ quan thuế nơi nộp, người ký, chức danh, mã ngành nghề, chế độ kế toán áp dụng.
 * Tên cơ quan thuế được điền sẵn từ kết quả tra cứu mã số thuế; mã cơ quan thuế
 * phải do người dùng nhập vì bản tra cứu công khai không trả về mã.
 */
router.get('/:id/tax-profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const access = await pool.query(
      'SELECT role FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [req.user!.userId, req.params.id],
    );
    if (!access.rows[0]) throw new NotFoundError('Không tìm thấy công ty');

    const { rows } = await pool.query(
      `SELECT c.tax_authority_code, c.tax_authority_name, c.signer_name, c.signer_title,
              c.business_line_code, c.accounting_regime, c.company_type,
              v.tax_authority AS tax_authority_from_lookup, v.mst_status, v.verified_at
         FROM companies c
         LEFT JOIN company_verification_cache v ON v.tax_code = c.tax_code
        WHERE c.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Không tìm thấy công ty');

    return sendSuccess(res, {
      ...rows[0],
      business_line_options: [
        { code: '01', label: 'Hoạt động sản xuất kinh doanh thông thường' },
        { code: '02', label: 'Hoạt động xổ số kiến thiết, xổ số điện toán' },
        { code: '03', label: 'Hoạt động thăm dò khai thác dầu khí' },
        { code: '04', label: 'Hoạt động chuyển nhượng bất động sản' },
        { code: '05', label: 'Nhà máy sản xuất điện' },
      ],
      accounting_regime_options: [
        { code: 'tt200', label: 'Thông tư 200/2014/TT-BTC — doanh nghiệp' },
        { code: 'tt133', label: 'Thông tư 133/2016/TT-BTC — doanh nghiệp nhỏ và vừa' },
        { code: 'tt132', label: 'Thông tư 132/2018/TT-BTC — doanh nghiệp siêu nhỏ' },
        { code: 'hkd',   label: 'Thông tư 152/2025/TT-BTC — hộ, cá nhân kinh doanh' },
      ],
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/tax-profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const access = await pool.query(
      'SELECT role FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [req.user!.userId, req.params.id],
    );
    if (!access.rows[0]) throw new NotFoundError('Không tìm thấy công ty');
    if (!['OWNER', 'ADMIN', 'ACCOUNTANT'].includes(access.rows[0].role as string)) {
      throw new ForbiddenError('Không đủ quyền cập nhật hồ sơ thuế');
    }

    const parsed = z.object({
      tax_authority_code: z.string().max(20).optional().nullable(),
      tax_authority_name: z.string().max(255).optional().nullable(),
      signer_name:        z.string().max(255).optional().nullable(),
      signer_title:       z.string().max(120).optional().nullable(),
      business_line_code: z.string().max(10).optional().nullable(),
      accounting_regime:  z.enum(['tt133', 'tt200', 'tt132', 'hkd']).optional().nullable(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ');

    const d = parsed.data;
    const { rows } = await pool.query(
      `UPDATE companies
          SET tax_authority_code = COALESCE($2, tax_authority_code),
              tax_authority_name = COALESCE($3, tax_authority_name),
              signer_name        = COALESCE($4, signer_name),
              signer_title       = COALESCE($5, signer_title),
              business_line_code = COALESCE($6, business_line_code),
              accounting_regime  = COALESCE($7, accounting_regime),
              updated_at         = NOW()
        WHERE id = $1
      RETURNING tax_authority_code, tax_authority_name, signer_name, signer_title,
                business_line_code, accounting_regime`,
      [req.params.id, d.tax_authority_code ?? null, d.tax_authority_name ?? null,
       d.signer_name ?? null, d.signer_title ?? null,
       d.business_line_code ?? null, d.accounting_regime ?? null],
    );

    return sendSuccess(res, rows[0], 'Đã lưu hồ sơ thuế — tờ khai xuất sau sẽ dùng thông tin này');
  } catch (err) {
    next(err);
  }
});

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
      // Note: audit_logs is intentionally NOT deleted to preserve audit trail

      // ── Tables whose FK points at invoices.id without cascade ────────
      // (gdt_validation_queue has ON DELETE CASCADE from invoices per 002 migration,
      //  but we delete explicitly here to be safe before invoices is removed)
      await client.query(
        'DELETE FROM gdt_validation_queue WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)',
        [companyId]
      );

      // (invoice_detail_queue has ON DELETE CASCADE from invoices per 042 migration,
      //  delete explicitly for safety)
      await client.query(
        'DELETE FROM invoice_detail_queue WHERE invoice_id IN (SELECT id FROM invoices WHERE company_id = $1)',
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
      //   raw_invoice_data, vendor_blacklist, hkd_declarations, hkd_line_items,
      //   hkd_inventory_opening_balances, company_analytics, company_verification_docs,
      //   sequential_numbering, cash_book_entries, inventory_movements,
      //   profit_loss_statements, hkd_tax_statements, esg_estimates,
      //   repurchase_predictions, insights_cache, price_anomalies,
      //   audit_rule_configs, company_risk_flags, raw_invoice_data, vendor_blacklist,
      //   payment_plan_assignments, telegram_chat_configs, hkd_declarations,
      //   hkd_line_items, hkd_inventory_opening_balances
      // Note: audit_logs is NOT cascaded - kept for audit trail
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
