import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { PitDeclarationXmlGenerator } from '../services/PitDeclarationXmlGenerator';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const xmlGenerator = new PitDeclarationXmlGenerator();

const createSchema = z.object({
  period_quarter: z.number().int().min(1).max(4),
  period_year:    z.number().int().min(2021).max(2100),
});

const updateSchema = z.object({
  loai_tkhai:      z.string().max(5).optional(),
  so_lan:          z.number().int().min(0).optional(),
  ma_cqt_noi_nop:  z.string().max(20).optional().nullable(),
  ten_cqt_noi_nop: z.string().max(300).optional().nullable(),
  mst_cu:          z.string().max(20).optional().nullable(),
  nguoi_ky:        z.string().max(200).optional().nullable(),
  notes:           z.string().optional().nullable(),
  ct15:  z.number().int().min(0).optional(),
  ct16:  z.number().int().min(0).optional(),
  ct17:  z.number().int().min(0).optional(),
  ct18:  z.number().int().min(0).optional(),
  ct19:  z.number().min(0).optional(),
  ct20:  z.number().min(0).optional(),
  ct21:  z.number().min(0).optional(),
  ct22:  z.number().min(0).optional(),
  ct23:  z.number().min(0).optional(),
  ct24:  z.number().min(0).optional(),
  ct25:  z.number().min(0).optional(),
  ct25_1: z.number().min(0).optional(),
  ct26:  z.number().min(0).optional(),
  ct27:  z.number().min(0).optional(),
  ct28:  z.number().min(0).optional(),
  ct29:  z.number().min(0).optional(),
  ct30:  z.number().min(0).optional(),
  ct31:  z.number().min(0).optional(),
  ct32:  z.number().min(0).optional(),
});

// GET /api/pit-declarations
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const page     = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 12);
    const offset   = (page - 1) * pageSize;
    const year     = req.query.year ? Number(req.query.year) : undefined;

    const conditions = ['company_id = $1'];
    const params: unknown[] = [companyId];

    if (year) {
      conditions.push(`period_year = $${params.length + 1}`);
      params.push(year);
    }

    const where = conditions.join(' AND ');

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM pit_declarations WHERE ${where}`, params),
      pool.query(
        `SELECT id, period_quarter, period_year, loai_tkhai, so_lan,
                ct32, submission_status AS status, created_at, submission_at
         FROM pit_declarations WHERE ${where}
         ORDER BY period_year DESC, period_quarter DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, offset],
      ),
    ]);

    sendPaginated(res, dataResult.rows, Number(countResult.rows[0].count), page, pageSize);
  } catch (err) {
    next(err);
  }
});

// POST /api/pit-declarations
router.post(
  '/',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId!;
      const userId    = req.user!.userId;
      const body      = createSchema.parse(req.body);

      const { rows } = await pool.query(
        `INSERT INTO pit_declarations
           (company_id, period_quarter, period_year, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, period_quarter, period_year) DO NOTHING
         RETURNING *`,
        [companyId, body.period_quarter, body.period_year, userId],
      );

      if (!rows[0]) {
        const existing = await pool.query(
          `SELECT * FROM pit_declarations
           WHERE company_id=$1 AND period_quarter=$2 AND period_year=$3`,
          [companyId, body.period_quarter, body.period_year],
        );
        return sendSuccess(res, existing.rows[0]);
      }

      sendSuccess(res, rows[0], 'Tờ khai đã được tạo', 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/pit-declarations/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM pit_declarations WHERE id=$1 AND company_id=$2`,
      [req.params.id, req.user!.companyId!],
    );
    if (!rows[0]) throw new NotFoundError('Pit declaration');
    sendSuccess(res, rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/pit-declarations/:id
router.patch(
  '/:id',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId!;
      const { id }    = req.params;

      const existing = await pool.query(
        `SELECT submission_status FROM pit_declarations WHERE id=$1 AND company_id=$2`,
        [id, companyId],
      );
      if (!existing.rows[0]) throw new NotFoundError('Pit declaration');
      if (existing.rows[0].submission_status === 'submitted' ||
          existing.rows[0].submission_status === 'accepted') {
        throw new ValidationError('Không thể sửa tờ khai đã nộp');
      }

      const body = updateSchema.parse(req.body);
      if (Object.keys(body).length === 0) {
        throw new ValidationError('Không có trường nào để cập nhật');
      }

      const setClauses: string[] = ['updated_at = NOW()', 'xml_content = NULL', 'xml_generated_at = NULL'];
      const values: unknown[]    = [];

      for (const [key, val] of Object.entries(body)) {
        if (val !== undefined) {
          values.push(val);
          // ct25_1 maps to column ct25_1 — safe direct mapping
          setClauses.push(`${key} = $${values.length}`);
        }
      }

      values.push(id, companyId);
      const { rows } = await pool.query(
        `UPDATE pit_declarations SET ${setClauses.join(', ')}
         WHERE id=$${values.length - 1} AND company_id=$${values.length}
         RETURNING *`,
        values,
      );

      sendSuccess(res, rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/pit-declarations/:id/status
router.patch(
  '/:id/status',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId!;
      const { id }    = req.params;
      const { status } = z.object({
        status: z.enum(['ready', 'submitted', 'accepted', 'rejected']),
      }).parse(req.body);

      const existing = await pool.query(
        `SELECT submission_status FROM pit_declarations WHERE id=$1 AND company_id=$2`,
        [id, companyId],
      );
      if (!existing.rows[0]) throw new NotFoundError('Pit declaration');
      if (existing.rows[0].submission_status === 'accepted') {
        throw new ValidationError('Tờ khai đã được GDT tiếp nhận, không thể thay đổi trạng thái');
      }

      const submissionAt = ['submitted', 'accepted'].includes(status) ? 'NOW()' : 'NULL';
      const { rows } = await pool.query(
        `UPDATE pit_declarations
         SET submission_status=$1, submission_at=${submissionAt}, updated_at=NOW()
         WHERE id=$2 AND company_id=$3
         RETURNING *`,
        [status, id, companyId],
      );

      sendSuccess(res, rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/pit-declarations/:id/xml
router.get('/:id/xml', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId    = req.user!.companyId!;
    const regenerate   = req.query.regenerate === 'true';

    const { rows } = await pool.query(
      `SELECT * FROM pit_declarations WHERE id=$1 AND company_id=$2`,
      [req.params.id, companyId],
    );
    if (!rows[0]) throw new NotFoundError('Pit declaration');

    const declaration = rows[0];
    let xml: string;

    if (!regenerate && declaration.xml_content) {
      xml = declaration.xml_content;
    } else {
      xml = await xmlGenerator.generate(declaration);
      await pool.query(
        `UPDATE pit_declarations SET xml_content=$1, xml_generated_at=NOW() WHERE id=$2`,
        [xml, declaration.id],
      );
    }

    const filename = `05KK-TNCN_Q${declaration.period_quarter}_${declaration.period_year}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/pit-declarations/:id
router.delete(
  '/:id',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId!;

      const existing = await pool.query(
        `SELECT submission_status FROM pit_declarations WHERE id=$1 AND company_id=$2`,
        [req.params.id, companyId],
      );
      if (!existing.rows[0]) throw new NotFoundError('Pit declaration');
      if (!['draft', 'ready'].includes(existing.rows[0].submission_status)) {
        throw new ValidationError('Chỉ có thể xóa tờ khai ở trạng thái nháp hoặc hoàn thiện');
      }

      await pool.query(`DELETE FROM pit_declarations WHERE id=$1 AND company_id=$2`, [req.params.id, companyId]);
      sendSuccess(res, null, 'Đã xóa tờ khai');
    } catch (err) {
      next(err);
    }
  },
);

export default router;
