/**
 * Admin Panel Routes (GROUP 44 — LIC-03)
 *
 * All routes require: authenticate → requireAdmin (DB-validated, not JWT-only)
 *
 * Mounted at: /api/admin
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';
import { licenseService } from '../services/LicenseService';
import { quotaService } from '../services/QuotaService';
import { sendSuccess, sendPaginated } from '../utils/response';
import { ValidationError, NotFoundError } from '../utils/AppError';

const router = Router();

// Apply auth + admin check to every route in this file
router.use(authenticate, requireAdmin);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseInt10(v: unknown, fallback: number): number {
  const n = parseInt(String(v), 10);
  return isNaN(n) ? fallback : n;
}

async function logLicenseHistory(
  userId: string,
  action: string,
  performer: string,
  opts: {
    oldPlanId?: string | null;
    newPlanId?: string | null;
    oldStatus?: string | null;
    newStatus?: string | null;
    expiresAt?: Date | null;
    notes?: string | null;
  } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO license_history
       (id, user_id, action, old_plan_id, new_plan_id, old_status, new_status, expires_at, performed_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      uuidv4(), userId, action,
      opts.oldPlanId ?? null, opts.newPlanId ?? null,
      opts.oldStatus ?? null, opts.newStatus ?? null,
      opts.expiresAt ?? null, performer,
      opts.notes ?? null,
    ],
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// OVERVIEW & ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/overview
router.get('/overview', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [users, subs, quotaMonth, expiringSoon] = await Promise.all([
      pool.query<{ total: string; active: string; admins: string }>(
        `SELECT
           COUNT(*)::text                                          AS total,
           COUNT(*) FILTER (WHERE is_active = true)::text         AS active,
           COUNT(*) FILTER (WHERE is_platform_admin = true)::text AS admins
         FROM users`,
      ),
      pool.query<{ active: string; trial: string; suspended: string; expired_soon: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active')::text   AS active,
           COUNT(*) FILTER (WHERE status = 'trial')::text    AS trial,
           COUNT(*) FILTER (WHERE status = 'suspended')::text AS suspended,
           COUNT(*) FILTER (WHERE expires_at < NOW() + INTERVAL '7 days' AND status IN ('active','trial'))::text AS expired_soon
         FROM user_subscriptions`,
      ),
      pool.query<{ invoices: string }>(
        `SELECT COALESCE(SUM(invoices_added), 0)::text AS invoices
         FROM quota_usage_log
         WHERE DATE_TRUNC('month', logged_at) = DATE_TRUNC('month', NOW())`,
      ),
      pool.query<{ user_id: string; email: string; full_name: string; plan_name: string; expires_at: string }>(
        `SELECT u.id AS user_id, u.email, u.full_name,
                lp.name AS plan_name, us.expires_at::text
         FROM user_subscriptions us
         JOIN users u ON u.id = us.user_id
         JOIN license_plans lp ON lp.id = us.plan_id
         WHERE us.status IN ('active','trial')
           AND us.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
         ORDER BY us.expires_at ASC
         LIMIT 20`,
      ),
    ]);

    const recentHistory = await pool.query(
      `SELECT lh.*, u.full_name AS user_name, a.full_name AS admin_name,
              op.name AS old_plan_name, np.name AS new_plan_name
       FROM license_history lh
       JOIN users u  ON u.id  = lh.user_id
       JOIN users a  ON a.id  = lh.performed_by
       LEFT JOIN license_plans op ON op.id = lh.old_plan_id
       LEFT JOIN license_plans np ON np.id = lh.new_plan_id
       ORDER BY lh.created_at DESC
       LIMIT 10`,
    );

    sendSuccess(res, {
      users: users.rows[0],
      subscriptions: subs.rows[0],
      invoices_synced_this_month: parseInt(quotaMonth.rows[0]?.invoices ?? '0', 10),
      expiring_soon: expiringSoon.rows,
      recent_history: recentHistory.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/analytics/usage
// GET /api/admin/analytics/users  — per-user invoice sync stats (12 months)
router.get('/analytics/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         u.id, u.email, u.full_name,
         COALESCE(SUM(q.invoices_added), 0)::int AS total_invoices,
         MAX(q.logged_at)                        AS last_sync_at,
         COUNT(DISTINCT DATE_TRUNC('month', q.logged_at))::int AS active_months
       FROM users u
       LEFT JOIN quota_usage_log q
              ON q.user_id = u.id
             AND q.logged_at >= NOW() - INTERVAL '12 months'
       GROUP BY u.id, u.email, u.full_name
       HAVING COALESCE(SUM(q.invoices_added), 0) > 0
       ORDER BY total_invoices DESC
       LIMIT 100`,
    );
    sendSuccess(res, rows);
  } catch (err) { next(err); }
});

router.get('/analytics/usage', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [monthly, newUsers] = await Promise.all([
      pool.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', logged_at), 'YYYY-MM') AS month,
           SUM(invoices_added)::int                            AS invoices_synced,
           COUNT(DISTINCT user_id)::int                        AS active_users
         FROM quota_usage_log
         WHERE logged_at >= NOW() - INTERVAL '12 months'
         GROUP BY 1
         ORDER BY 1 ASC`,
      ),
      pool.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
           COUNT(*)::int AS new_users
         FROM users
         WHERE created_at >= NOW() - INTERVAL '12 months'
         GROUP BY 1
         ORDER BY 1 ASC`,
      ),
    ]);
    sendSuccess(res, { monthly_usage: monthly.rows, new_users: newUsers.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/plans
router.get('/plans', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM license_plans ORDER BY sort_order ASC, created_at ASC`,
    );
    sendSuccess(res, rows);
  } catch (err) { next(err); }
});

const planSchema = z.object({
  code:              z.string().min(1).max(30),
  name:              z.string().min(1).max(100),
  tier:              z.enum(['basic', 'enterprise', 'free']),
  invoice_quota:     z.number().int().min(0),
  price_per_month:   z.number().int().min(0),
  price_per_invoice: z.number().int().min(0).optional(),
  max_companies:     z.number().int().min(1).default(5),
  max_users:         z.number().int().min(1).default(3),
  features:          z.record(z.unknown()).optional(),
  sort_order:        z.number().int().min(0).optional(),
});

// POST /api/admin/plans
router.post('/plans', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
    const d = parsed.data;
    const { rows } = await pool.query(
      `INSERT INTO license_plans
         (id, code, name, tier, invoice_quota, price_per_month, price_per_invoice,
          max_companies, max_users, features, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [uuidv4(), d.code, d.name, d.tier, d.invoice_quota, d.price_per_month,
       d.price_per_invoice ?? null, d.max_companies, d.max_users,
       JSON.stringify(d.features ?? {}), d.sort_order ?? 0],
    );
    sendSuccess(res, rows[0], 'Tạo gói thành công', 201);
  } catch (err) { next(err); }
});

// PATCH /api/admin/plans/:id
router.patch('/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    const allowed = ['name','tier','invoice_quota','price_per_month','price_per_invoice',
                     'max_companies','max_users','features','sort_order','is_active'] as const;
    for (const key of allowed) {
      if (key in req.body) {
        fields.push(`${key} = $${idx++}`);
        params.push(key === 'features' ? JSON.stringify(req.body[key]) : req.body[key]);
      }
    }
    if (!fields.length) throw new ValidationError('No fields to update');
    params.push(req.params['id']);
    const { rows } = await pool.query(
      `UPDATE license_plans SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    if (!rows.length) throw new NotFoundError('Plan');
    sendSuccess(res, rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/plans/:id — soft deactivate
router.delete('/plans/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `UPDATE license_plans SET is_active = false WHERE id = $1 RETURNING id`,
      [req.params['id']],
    );
    if (!rows.length) throw new NotFoundError('Plan');
    sendSuccess(res, { id: rows[0].id });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users
router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page     = parseInt10(req.query['page'],     1);
    const pageSize = parseInt10(req.query['pageSize'], 20);
    const offset   = (page - 1) * pageSize;
    const status   = req.query['status'] as string | undefined;
    const plan     = req.query['plan']   as string | undefined;
    const search   = req.query['search'] as string | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (status)  { conditions.push(`us.status = $${idx++}`);      params.push(status); }
    if (plan)    { conditions.push(`lp.code = $${idx++}`);         params.push(plan); }
    if (search)  {
      conditions.push(`(u.full_name ILIKE $${idx} OR u.email ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [count, data] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT u.id)::int AS total
         FROM users u
         LEFT JOIN user_subscriptions us ON us.user_id = u.id
         LEFT JOIN license_plans lp ON lp.id = us.plan_id
         ${where}`,
        params,
      ),
      pool.query(
        `SELECT
           u.id, u.email, u.full_name, u.is_active, u.is_platform_admin, u.created_at,
           us.status AS sub_status, us.quota_used, us.quota_total, us.expires_at,
           lp.code AS plan_code, lp.name AS plan_name, lp.tier
         FROM users u
         LEFT JOIN user_subscriptions us ON us.user_id = u.id
         LEFT JOIN license_plans lp ON lp.id = us.plan_id
         ${where}
         ORDER BY u.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, pageSize, offset],
      ),
    ]);

    sendPaginated(res, data.rows, count.rows[0].total, page, pageSize);
  } catch (err) { next(err); }
});

// GET /api/admin/users/:id
router.get('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params['id']!;

    const [userRow, companies, history, quota] = await Promise.all([
      pool.query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.is_active, u.is_platform_admin,
                u.admin_notes, u.created_at,
                us.id AS sub_id, us.status AS sub_status, us.quota_used, us.quota_total,
                us.quota_reset_at, us.expires_at, us.started_at, us.trial_ends_at,
                us.granted_by, us.grant_notes, us.is_manually_set,
                us.last_paid_at, us.payment_reference,
                lp.code AS plan_code, lp.name AS plan_name, lp.tier, lp.invoice_quota,
                lp.price_per_month, lp.max_companies, lp.max_users, lp.features
         FROM users u
         LEFT JOIN user_subscriptions us ON us.user_id = u.id
         LEFT JOIN license_plans lp ON lp.id = us.plan_id
         WHERE u.id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT c.id, c.name, c.tax_code, uc.role,
                COUNT(i.id)::int AS invoice_count
         FROM user_companies uc
         JOIN companies c ON c.id = uc.company_id
         LEFT JOIN invoices i ON i.company_id = c.id AND i.deleted_at IS NULL
         WHERE uc.user_id = $1 AND c.deleted_at IS NULL
         GROUP BY c.id, c.name, c.tax_code, uc.role
         ORDER BY c.name`,
        [userId],
      ),
      pool.query(
        `SELECT lh.*, a.full_name AS admin_name,
                op.name AS old_plan_name, np.name AS new_plan_name
         FROM license_history lh
         JOIN users a ON a.id = lh.performed_by
         LEFT JOIN license_plans op ON op.id = lh.old_plan_id
         LEFT JOIN license_plans np ON np.id = lh.new_plan_id
         WHERE lh.user_id = $1
         ORDER BY lh.created_at DESC
         LIMIT 50`,
        [userId],
      ),
      quotaService.getMonthlyHistory(userId),
    ]);

    if (!userRow.rows.length) throw new NotFoundError('User');

    sendSuccess(res, {
      user: userRow.rows[0],
      companies: companies.rows,
      license_history: history.rows,
      quota_history: quota,
    });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/status
router.patch('/users/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, reason } = z.object({
      status: z.enum(['active', 'suspended']),
      reason: z.string().min(1),
    }).parse(req.body);

    const { rows } = await pool.query(
      `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, is_active`,
      [status === 'active', req.params['id']],
    );
    if (!rows.length) throw new NotFoundError('User');

    await logLicenseHistory(req.params['id']!, status === 'active' ? 'enable' : 'suspend',
      req.user!.userId, { oldStatus: status === 'active' ? 'suspended' : 'active', newStatus: status, notes: reason });

    sendSuccess(res, rows[0]);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LICENSE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/admin/users/:id/grant-license
router.post('/users/:id/grant-license', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { planCode, months, notes, paymentRef } = z.object({
      planCode:   z.string().min(1),
      months:     z.number().int().min(1).max(36),
      notes:      z.string().optional(),
      paymentRef: z.string().optional(),
    }).parse(req.body);

    const userId = req.params['id']!;

    // Lookup plan
    const planRes = await pool.query(
      `SELECT * FROM license_plans WHERE code = $1 AND is_active = true`,
      [planCode],
    );
    if (!planRes.rows.length) throw new NotFoundError(`Plan '${planCode}'`);
    const plan = planRes.rows[0];

    // Lookup existing subscription
    const existingSub = await pool.query(
      `SELECT id, status, plan_id FROM user_subscriptions WHERE user_id = $1`,
      [userId],
    );

    const expiresAt = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000);
    let sub;

    if (existingSub.rows.length) {
      // Update existing
      const { rows } = await pool.query(
        `UPDATE user_subscriptions
         SET plan_id=$1, status='active', expires_at=$2, quota_total=$3, quota_used=0,
             grant_notes=$4, granted_by=$5, is_manually_set=true,
             last_paid_at=NOW(), payment_reference=$6, updated_at=NOW()
         WHERE user_id=$7
         RETURNING *`,
        [plan.id, expiresAt, plan.invoice_quota, notes ?? null,
         req.user!.userId, paymentRef ?? null, userId],
      );
      sub = rows[0];
      await logLicenseHistory(userId, 'grant', req.user!.userId, {
        oldPlanId: existingSub.rows[0].plan_id, newPlanId: plan.id,
        oldStatus: existingSub.rows[0].status, newStatus: 'active',
        expiresAt, notes: notes ?? null,
      });
    } else {
      // Insert new
      const { rows } = await pool.query(
        `INSERT INTO user_subscriptions
           (id, user_id, plan_id, status, expires_at, quota_total, quota_used,
            grant_notes, granted_by, is_manually_set, last_paid_at, payment_reference)
         VALUES ($1,$2,$3,'active',$4,$5,0,$6,$7,true,NOW(),$8)
         RETURNING *`,
        [uuidv4(), userId, plan.id, expiresAt, plan.invoice_quota,
         notes ?? null, req.user!.userId, paymentRef ?? null],
      );
      sub = rows[0];
      await logLicenseHistory(userId, 'grant', req.user!.userId, {
        newPlanId: plan.id, newStatus: 'active', expiresAt, notes: notes ?? null,
      });
    }

    sendSuccess(res, { subscription: sub, plan }, 'License đã được cấp thành công', 201);
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/renew
router.patch('/users/:id/renew', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { months, notes, paymentRef } = z.object({
      months:     z.number().int().min(1).max(36),
      notes:      z.string().optional(),
      paymentRef: z.string().optional(),
    }).parse(req.body);

    const userId = req.params['id']!;

    const existingRes = await pool.query(
      `SELECT id, expires_at, plan_id, status FROM user_subscriptions WHERE user_id = $1`,
      [userId],
    );
    if (!existingRes.rows.length) throw new NotFoundError('Subscription');
    const existing = existingRes.rows[0];

    // Extend from current expiry or now (whichever is later)
    const base = new Date(existing.expires_at) > new Date() ? new Date(existing.expires_at) : new Date();
    const newExpiry = new Date(base.getTime() + months * 30 * 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(
      `UPDATE user_subscriptions
       SET status='active', expires_at=$1, is_manually_set=true,
           last_paid_at=NOW(), payment_reference=COALESCE($2, payment_reference),
           grant_notes=COALESCE($3, grant_notes), updated_at=NOW()
       WHERE user_id=$4
       RETURNING *`,
      [newExpiry, paymentRef ?? null, notes ?? null, userId],
    );

    await logLicenseHistory(userId, 'renew', req.user!.userId, {
      oldPlanId: existing.plan_id, newPlanId: existing.plan_id,
      oldStatus: existing.status, newStatus: 'active',
      expiresAt: newExpiry, notes: notes ?? null,
    });

    sendSuccess(res, rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/upgrade
router.patch('/users/:id/upgrade', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { newPlanCode, notes } = z.object({
      newPlanCode: z.string().min(1),
      notes:       z.string().optional(),
    }).parse(req.body);

    const userId = req.params['id']!;

    const [planRes, subRes] = await Promise.all([
      pool.query(`SELECT * FROM license_plans WHERE code = $1 AND is_active = true`, [newPlanCode]),
      pool.query(`SELECT id, plan_id, quota_total, status FROM user_subscriptions WHERE user_id = $1`, [userId]),
    ]);

    if (!planRes.rows.length) throw new NotFoundError(`Plan '${newPlanCode}'`);
    if (!subRes.rows.length)  throw new NotFoundError('Subscription');

    const plan    = planRes.rows[0];
    const sub     = subRes.rows[0];
    const oldQuota = sub.quota_total as number;
    const action  = plan.invoice_quota >= oldQuota ? 'upgrade' : 'downgrade';

    const { rows } = await pool.query(
      `UPDATE user_subscriptions
       SET plan_id=$1, quota_total=$2, is_manually_set=true, updated_at=NOW()
       WHERE user_id=$3
       RETURNING *`,
      [plan.id, plan.invoice_quota, userId],
    );

    await logLicenseHistory(userId, action, req.user!.userId, {
      oldPlanId: sub.plan_id, newPlanId: plan.id,
      oldStatus: sub.status, newStatus: sub.status,
      notes: notes ?? null,
    });

    sendSuccess(res, rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/suspend
router.patch('/users/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
    const userId = req.params['id']!;

    const subRes = await pool.query(
      `UPDATE user_subscriptions SET status='suspended', updated_at=NOW()
       WHERE user_id=$1 RETURNING id, plan_id, status`,
      [userId],
    );
    if (!subRes.rows.length) throw new NotFoundError('Subscription');

    await logLicenseHistory(userId, 'suspend', req.user!.userId, {
      oldPlanId: subRes.rows[0].plan_id, newPlanId: subRes.rows[0].plan_id,
      oldStatus: 'active', newStatus: 'suspended', notes: reason,
    });

    sendSuccess(res, { suspended: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/enable
router.patch('/users/:id/enable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notes = (req.body as { notes?: string }).notes;
    const userId = req.params['id']!;

    const subRes = await pool.query(
      `UPDATE user_subscriptions SET status='active', updated_at=NOW()
       WHERE user_id=$1 RETURNING id, plan_id`,
      [userId],
    );
    if (!subRes.rows.length) throw new NotFoundError('Subscription');

    await logLicenseHistory(userId, 'enable', req.user!.userId, {
      oldPlanId: subRes.rows[0].plan_id, newPlanId: subRes.rows[0].plan_id,
      oldStatus: 'suspended', newStatus: 'active', notes: notes ?? null,
    });

    sendSuccess(res, { enabled: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/users/:id/subscription
router.delete('/users/:id/subscription', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason, confirm } = z.object({
      reason:  z.string().min(1),
      confirm: z.literal('CANCEL_SUBSCRIPTION'),
    }).parse(req.body);

    const userId = req.params['id']!;
    const subRes = await pool.query(
      `UPDATE user_subscriptions SET status='cancelled', updated_at=NOW()
       WHERE user_id=$1 RETURNING id, plan_id`,
      [userId],
    );
    if (!subRes.rows.length) throw new NotFoundError('Subscription');

    await logLicenseHistory(userId, 'cancel', req.user!.userId, {
      oldPlanId: subRes.rows[0].plan_id, oldStatus: 'active', newStatus: 'cancelled', notes: reason,
    });

    void confirm; // already validated by zod
    sendSuccess(res, { cancelled: true });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTA MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users/:id/quota
router.get('/users/:id/quota', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params['id']!;
    const [sub, history] = await Promise.all([
      quotaService.getSubscription(userId),
      quotaService.getMonthlyHistory(userId, 6),
    ]);
    sendSuccess(res, { subscription: sub, history });
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/quota/adjust
router.patch('/users/:id/quota/adjust', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { adjustment, reason } = z.object({
      adjustment: z.number().int(),
      reason:     z.string().min(1),
    }).parse(req.body);

    await quotaService.adjustQuota(req.params['id']!, adjustment, req.user!.userId, reason);
    sendSuccess(res, { adjusted: true });
  } catch (err) { next(err); }
});

// POST /api/admin/users — create a new user account
router.post('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, full_name, password, phone } = z.object({
      email:     z.string().email('Email không hợp lệ'),
      full_name: z.string().min(1, 'Họ tên không được trống'),
      password:  z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự'),
      phone:     z.string().optional(),
    }).parse(req.body);

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) throw new ValidationError('Email đã tồn tại');

    const hash = await bcrypt.hash(password, 12);
    const id   = uuidv4();
    await pool.query(
      `INSERT INTO users (id, email, full_name, phone, password_hash, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,true,NOW(),NOW())`,
      [id, email.toLowerCase(), full_name, phone ?? null, hash],
    );

    sendSuccess(res, { id, email: email.toLowerCase(), full_name }, undefined, 201);
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/toggle-active — enable / disable user account
router.patch('/users/:id/toggle-active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.params['id']!;
    const result = await pool.query(
      `UPDATE users SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1 RETURNING is_active`,
      [userId],
    );
    if (!result.rows.length) throw new NotFoundError('User');
    const isActive = result.rows[0].is_active as boolean;
    // Revoke all sessions immediately so the disabled user is locked out without waiting for token expiry
    if (!isActive) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    }
    sendSuccess(res, { is_active: isActive });
  } catch (err) { next(err); }
});

// POST /api/admin/quota/reset-all
router.post('/quota/reset-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { confirm } = z.object({ confirm: z.literal('RESET_ALL_QUOTAS') }).parse(req.body);
    void confirm;
    const count = await quotaService.resetAllMonthlyQuotas();
    sendSuccess(res, { reset_count: count }, `Đã reset quota cho ${count} subscription`);
  } catch (err) { next(err); }
});

// ── BOT-LICENSE-01: License tier CRUD ────────────────────────────────────────

const tierBodySchema = z.object({
  sync_per_hour:   z.number().int().min(1).max(100),
  burst_max:       z.number().int().min(1).max(100),
  max_companies:   z.number().int().min(0),   // 0 = unlimited
  can_export_xml:  z.boolean(),
  can_use_ai_audit: z.boolean(),
});

const newTierSchema = tierBodySchema.extend({
  plan_id: z.string().min(1).max(50),
});

// GET /api/admin/license-tiers
router.get('/license-tiers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT plan_id, sync_per_hour, burst_max, max_companies, can_export_xml, can_use_ai_audit
       FROM license_tiers ORDER BY plan_id`
    );
    sendSuccess(res, rows);
  } catch (err) { next(err); }
});

// POST /api/admin/license-tiers
router.post('/license-tiers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = newTierSchema.safeParse(req.body);
    if (!body.success) throw new ValidationError('Invalid tier data');
    const { plan_id, sync_per_hour, burst_max, max_companies, can_export_xml, can_use_ai_audit } = body.data;
    const { rows } = await pool.query(
      `INSERT INTO license_tiers (plan_id, sync_per_hour, burst_max, max_companies, can_export_xml, can_use_ai_audit)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [plan_id, sync_per_hour, burst_max, max_companies, can_export_xml, can_use_ai_audit]
    );
    sendSuccess(res, rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/admin/license-tiers/:planId
router.put('/license-tiers/:planId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { planId } = req.params as { planId: string };
    const body = tierBodySchema.safeParse(req.body);
    if (!body.success) throw new ValidationError('Invalid tier data');
    const { sync_per_hour, burst_max, max_companies, can_export_xml, can_use_ai_audit } = body.data;

    const { rows } = await pool.query(
      `UPDATE license_tiers
       SET sync_per_hour=$2, burst_max=$3, max_companies=$4, can_export_xml=$5, can_use_ai_audit=$6
       WHERE plan_id=$1
       RETURNING *`,
      [planId, sync_per_hour, burst_max, max_companies, can_export_xml, can_use_ai_audit]
    );
    if (rows.length === 0) throw new NotFoundError(`Tier '${planId}' không tồn tại`);

    // Invalidate all users on this plan
    const affected = await pool.query(
      `SELECT user_id FROM user_subscriptions WHERE plan=$1 AND status IN ('trial','active')`,
      [planId]
    );
    for (const row of affected.rows as { user_id: string }[]) {
      void licenseService.invalidate(row.user_id);
    }

    sendSuccess(res, rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/users/:userId/rate-limit-override
const overrideSchema = z.object({
  plan: z.enum(['free', 'starter', 'pro', 'enterprise']),
  ttl_seconds: z.number().int().min(60).max(86400).optional().default(3600),
});

router.post('/users/:userId/rate-limit-override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params as { userId: string };
    const body = overrideSchema.safeParse(req.body);
    if (!body.success) throw new ValidationError('Invalid override data');
    const { plan, ttl_seconds } = body.data;

    const IORedis = (await import('ioredis')).default;
    const r = new IORedis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', { maxRetriesPerRequest: 3 });
    await r.set(`ratelimit:override:${userId}`, plan, 'EX', ttl_seconds);
    await r.quit();

    await licenseService.invalidate(userId);
    sendSuccess(res, { userId, plan, ttl_seconds });
  } catch (err) { next(err); }
});

// DELETE /api/admin/users/:userId/rate-limit-override
router.delete('/users/:userId/rate-limit-override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params as { userId: string };
    const IORedis = (await import('ioredis')).default;
    const r = new IORedis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', { maxRetriesPerRequest: 3 });
    await r.del(`ratelimit:override:${userId}`);
    await r.quit();
    await licenseService.invalidate(userId);
    sendSuccess(res, { userId, removed: true });
  } catch (err) { next(err); }
});

export default router;
