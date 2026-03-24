import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { TaxDeclarationEngine } from '../services/TaxDeclarationEngine';
import { HtkkXmlGenerator } from '../services/HtkkXmlGenerator';
import { TVanSubmissionService } from '../services/TVanSubmissionService';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';
import type { TaxDeclaration } from 'shared';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const calcSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
});

// GET /api/declarations
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 12);
    const offset = (page - 1) * pageSize;

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM tax_declarations WHERE company_id = $1`, [req.user!.companyId]),
      pool.query(
        `SELECT id, period_month, period_year,
                submission_status AS status,
                ct40a_total_output_vat AS ct40a,
                ct41_payable_vat        AS ct41,
                ct43_carry_forward_vat  AS ct43,
                created_at, submission_at AS submitted_at
         FROM tax_declarations WHERE company_id = $1
         ORDER BY period_year DESC, period_month DESC
         LIMIT $2 OFFSET $3`,
        [req.user!.companyId, pageSize, offset]
      ),
    ]);

    sendPaginated(res, dataResult.rows, Number(countResult.rows[0].count), page, pageSize);
  } catch (err) {
    next(err);
  }
});

// GET /api/declarations/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT * FROM tax_declarations WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user!.companyId]
    );
    if (!result.rows[0]) throw new NotFoundError('Declaration not found');
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/declarations/calculate
router.post(
  '/calculate',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = calcSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

      const engine = new TaxDeclarationEngine();
      const declaration = await engine.calculateDeclaration(
        req.user!.companyId!,
        parsed.data.month,
        parsed.data.year
      );
      sendSuccess(res, declaration);
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/declarations/:id/status
router.patch(
  '/:id/status',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = z
        .object({ status: z.enum(['ready', 'submitted']) })
        .parse(req.body);

      const result = await pool.query(
        `UPDATE tax_declarations
         SET submission_status = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING id, submission_status`,
        [status, req.params.id, req.user!.companyId]
      );
      if (!result.rows[0]) throw new NotFoundError('Declaration not found');
      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/declarations/:id/xml — download HTKK XML
router.get('/:id/xml', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT * FROM tax_declarations WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user!.companyId]
    );
    const decl = result.rows[0];
    if (!decl) throw new NotFoundError('Declaration not found');

    // Generate XML if not yet created
    let xml: string = decl.xml_content as string;
    if (!xml) {
      const generator = new HtkkXmlGenerator();
      xml = await generator.generate(decl as TaxDeclaration);
    }

    const { period_month, period_year } = decl;
    const filename = `01GTGT_${period_year}_${String(period_month).padStart(2, '0')}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

// POST /api/declarations/:id/submit-tvan — nộp tờ khai qua T-VAN
router.post(
  '/:id/submit-tvan',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `SELECT * FROM tax_declarations WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      const decl = result.rows[0];
      if (!decl) throw new NotFoundError('Declaration not found');

      if (!['ready', 'draft'].includes(decl.submission_status as string)) {
        throw new ValidationError(`Không thể nộp tờ khai ở trạng thái "${decl.submission_status as string}"`);
      }

      // Generate XML
      let xml: string = decl.xml_content as string;
      if (!xml) {
        const generator = new HtkkXmlGenerator();
        xml = await generator.generate(decl as TaxDeclaration);
      }

      const tvan = new TVanSubmissionService();
      const submitResult = await tvan.submit(req.params.id, xml);

      sendSuccess(res, submitResult, 'Đã gửi tờ khai tới T-VAN thành công');
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/declarations/:id/tvan-status — kiểm tra trạng thái nộp T-VAN
router.get(
  '/:id/tvan-status',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `SELECT submission_status, submission_ref, submission_at
         FROM tax_declarations WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      const decl = result.rows[0];
      if (!decl) throw new NotFoundError('Declaration not found');

      if (!decl.submission_ref) {
        sendSuccess(res, { status: decl.submission_status, submissionId: null });
        return;
      }

      const tvan = new TVanSubmissionService();
      const status = await tvan.pollStatus(decl.submission_ref as string);
      sendSuccess(res, status);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
