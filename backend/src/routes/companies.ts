import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/AppError';

const router = Router();
router.use(authenticate);

const companySchema = z.object({
  name: z.string().min(1).max(255),
  tax_code: z.string().regex(/^\d{10}(-\d{3})?$/, 'MST phải là 10 chữ số (hoặc 13 ký tự cho chi nhánh)'),
  address: z.string().optional().default(''),
  phone: z.string().optional().default(''),
  email: z.string().email().optional().or(z.literal('')).default(''),
  company_type: z.enum(['private', 'jsc', 'partnership', 'household', 'other']).default('private'),
  fiscal_year_start: z.coerce.number().int().min(1).max(12).default(1),
});

// GET /api/companies — list companies for the current user
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.tax_code, c.address, c.phone, c.email,
              c.company_type, c.fiscal_year_start, c.onboarded, c.created_at,
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

// POST /api/companies — create new company (user becomes OWNER)
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = companySchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    const { name, tax_code, address, phone, email, company_type, fiscal_year_start } = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = uuidv4();
      const { rows } = await client.query(
        `INSERT INTO companies (id, name, tax_code, address, phone, email, company_type, fiscal_year_start, onboarded)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
         RETURNING id, name, tax_code, address, phone, email, company_type, fiscal_year_start, onboarded, created_at`,
        [id, name, tax_code, address, phone, email || null, company_type, fiscal_year_start]
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

    const { name, tax_code, address, phone, email, company_type, fiscal_year_start } = parsed.data;
    const { rows } = await pool.query(
      `UPDATE companies
       SET name=$1, tax_code=$2, address=$3, phone=$4, email=$5,
           company_type=$6, fiscal_year_start=$7, updated_at=NOW()
       WHERE id=$8 AND deleted_at IS NULL
       RETURNING id, name, tax_code, address, phone, email, company_type, fiscal_year_start, onboarded`,
      [name, tax_code, address, phone, email || null, company_type, fiscal_year_start, req.params.id]
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

// DELETE /api/companies/:id — soft delete (OWNER only)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const access = await pool.query(
      'SELECT role FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [req.user!.userId, req.params.id]
    );
    if (!access.rows[0]) throw new NotFoundError('Company not found');
    if (access.rows[0].role !== 'OWNER') throw new ForbiddenError('Chỉ OWNER mới được xóa công ty');

    await pool.query(
      `UPDATE companies SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    sendSuccess(res, null);
  } catch (err) {
    next(err);
  }
});

export default router;
