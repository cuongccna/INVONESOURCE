import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { TaxDeclarationEngine } from '../services/TaxDeclarationEngine';
import { HtkkXmlGenerator } from '../services/HtkkXmlGenerator';
import { TVanSubmissionService } from '../services/TVanSubmissionService';
import { TaxDeclarationExporter } from '../services/TaxDeclarationExporter';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';
import type { TaxDeclaration } from 'shared';
import validationRouter from '../tax/validation/validation.controller';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// Mount invoice validation pipeline routes under /declarations
router.use('/', validationRouter);

const calcSchema = z.object({
  month:   z.number().int().min(1).max(12).optional(),
  quarter: z.number().int().min(1).max(4).optional(),
  year:    z.number().int().min(2020).max(2100),
}).refine(d => d.month !== undefined || d.quarter !== undefined, {
  message: 'Phải cung cấp month hoặc quarter',
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
        `SELECT id, period_month, period_year, period_type,
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

// Block HKD/household companies — use /api/hkd endpoints instead
      const compRes = await pool.query<{ company_type: string; business_type: string }>(
        `SELECT COALESCE(company_type, 'enterprise') AS company_type,
                COALESCE(business_type, 'DN')         AS business_type
         FROM companies WHERE id = $1`,
        [req.user!.companyId]
      );
      const companyType  = compRes.rows[0]?.company_type  ?? 'enterprise';
      const businessType = compRes.rows[0]?.business_type ?? 'DN';
      const isHousehold  = companyType === 'household' || ['HKD', 'HND', 'CA_NHAN'].includes(String(businessType));
      if (isHousehold) {
          throw new ValidationError('Công ty thuộc loại Hộ kinh doanh/Cá nhân kinh doanh — sử dụng form HKD (TT40) để tính tờ khai');
        }

        console.log('[CALC-DEBUG] companyId from JWT/header:', req.user!.companyId, '| body:', JSON.stringify(req.body), '| x-company-id header:', req.headers['x-company-id']);

      const engine = new TaxDeclarationEngine();
      let declaration;
      const month = parsed.data.quarter !== undefined ? parsed.data.quarter * 3 : parsed.data.month!;
      if (parsed.data.quarter !== undefined) {
        declaration = await engine.calculateQuarterlyDeclaration(
          req.user!.companyId!, parsed.data.quarter, parsed.data.year
        );
      } else {
        declaration = await engine.calculateDeclaration(
          req.user!.companyId!, parsed.data.month!, parsed.data.year
        );
      }
      // Attach audit gate warnings (non-blocking — UI shows them as informational alerts)
      const warnings = await engine.getCT23Warnings(
        req.user!.companyId!, month, parsed.data.year
      ).catch(() => null);
      console.log('[CALC-DEBUG] result:', { id: declaration.id, companyId: declaration.company_id, ct40a: declaration.ct40a_total_output_vat, ct23: declaration.ct23_deductible_input_vat, ct41: declaration.ct41_payable_vat, ct43: declaration.ct43_carry_forward_vat });
      sendSuccess(res, { ...declaration, _warnings: warnings });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/declarations/:id/opening-balance — nhập số đầu kỳ [22] cho doanh nghiệp mới
router.patch(
  '/:id/opening-balance',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { opening_balance } = z
        .object({ opening_balance: z.number().int().min(0) })
        .parse(req.body);

      // Fetch current declaration to recalculate ct25, ct41, ct43
      const { rows } = await pool.query(
        `SELECT ct23_deductible_input_vat, ct40a_total_output_vat, ct36_nq_vat_reduction
         FROM tax_declarations WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      if (!rows[0]) throw new NotFoundError('Declaration not found');

      const ct24 = opening_balance;
      const ct23 = Number(rows[0].ct23_deductible_input_vat ?? 0);
      const ct40a_raw = Number(rows[0].ct40a_total_output_vat ?? 0);
      const ct36_nq  = Number(rows[0].ct36_nq_vat_reduction ?? 0);
      const ct25 = ct23 + ct24;
      const ct40a_adj = ct40a_raw - ct36_nq;
      const ct41 = Math.max(0, ct40a_adj - ct25);
      const ct43 = Math.max(0, ct25 - ct40a_adj);

      const result = await pool.query(
        `UPDATE tax_declarations
         SET ct24_carried_over_vat = $1,
             ct25_total_deductible  = $2,
             ct41_payable_vat       = $3,
             ct43_carry_forward_vat = $4,
             xml_content            = NULL,
             xml_generated_at       = NULL,
             updated_at             = NOW()
         WHERE id = $5 AND company_id = $6
           AND submission_status NOT IN ('submitted','accepted')
         RETURNING *`,
        [ct24, ct25, ct41, ct43, req.params.id, req.user!.companyId]
      );
      if (!result.rows[0]) throw new NotFoundError('Declaration not found or already submitted');
      sendSuccess(res, result.rows[0], 'Đã cập nhật số đầu kỳ');
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/declarations/:id/manual-fields — nhập tay các chỉ tiêu [37],[38],[40b],[21]
router.patch(
  '/:id/manual-fields',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = z.object({
        ct37: z.number().int().min(0).nullable().optional(),
        ct38: z.number().int().min(0).nullable().optional(),
        ct40b: z.number().int().min(0).nullable().optional(),
        ct21: z.boolean().nullable().optional(),
      }).parse(req.body);

      // Fetch current row to recalculate payable/carry-forward
      const { rows } = await pool.query<{
        ct23_deductible_input_vat: string;
        ct24_carried_over_vat: string;
        ct40a_total_output_vat: string;
        ct36_nq_vat_reduction: string;
      }>(
        `SELECT ct23_deductible_input_vat, ct24_carried_over_vat, ct40a_total_output_vat, ct36_nq_vat_reduction
         FROM tax_declarations WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      if (!rows[0]) throw new NotFoundError('Declaration not found');

      const ct23  = Number(rows[0].ct23_deductible_input_vat ?? 0);
      const ct24  = Number(rows[0].ct24_carried_over_vat ?? 0);
      const ct25  = ct23 + ct24;
      const ct40a = Number(rows[0].ct40a_total_output_vat ?? 0);
      const nqRed = Number(rows[0].ct36_nq_vat_reduction ?? 0);

      const ct37_manual  = body.ct37  ?? 0;
      const ct38_manual  = body.ct38  ?? 0;
      const ct40b_manual = body.ct40b ?? 0;

      const net      = ct40a - nqRed - ct25 + ct37_manual - ct38_manual;
      const ct40_pay = Math.max(0, Math.max(0, net) - ct40b_manual);
      const ct41     = Math.max(0, -net) + Math.max(0, ct40b_manual - Math.max(0, net));
      const ct43     = ct41;

      const result = await pool.query(
        `UPDATE tax_declarations
         SET ct37_adjustment_decrease = $1,
             ct38_adjustment_increase = $2,
             ct40b_investment_vat     = $3,
             ct21_no_activity         = $4,
             ct41_payable_vat         = $5,
             ct43_carry_forward_vat   = $6,
             xml_content              = NULL,
             xml_generated_at         = NULL,
             updated_at               = NOW()
         WHERE id = $7 AND company_id = $8
           AND submission_status NOT IN ('submitted','accepted')
         RETURNING *`,
        [
          body.ct37  ?? null,
          body.ct38  ?? null,
          body.ct40b ?? null,
          body.ct21  ?? null,
          ct40_pay, ct43,
          req.params.id, req.user!.companyId,
        ]
      );
      if (!result.rows[0]) throw new NotFoundError('Declaration not found or already submitted');
      sendSuccess(res, result.rows[0], 'Đã cập nhật chỉ tiêu nhập tay');
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

// GET /api/declarations/:id/export?format=excel|pdf — tải Excel / PDF
router.get(
  '/:id/export',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const format  = String(req.query.format ?? '');
      if (format !== 'excel' && format !== 'pdf') {
        throw new ValidationError('format phải là excel hoặc pdf');
      }

      const check = await pool.query(
        `SELECT period_month, period_year, period_type
         FROM tax_declarations WHERE id = $1 AND company_id = $2`,
        [id, req.user!.companyId],
      );
      if (!check.rows[0]) throw new NotFoundError('Tờ khai không tìm thấy');

      const exporter = new TaxDeclarationExporter();
      const { period_month, period_year, period_type } = check.rows[0] as { period_month: number; period_year: number; period_type: string };
      const periodTag = period_type === 'quarterly' ? `Q${period_month}` : `T${period_month < 10 ? '0' : ''}${period_month}`;

      if (format === 'excel') {
        const buf = await exporter.exportToExcel(id, req.user!.companyId!);
        const filename = `TK01GTGT_${periodTag}_${period_year}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
      } else {
        const buf = await exporter.exportToPdf(id, req.user!.companyId!);
        const filename = `TK01GTGT_${periodTag}_${period_year}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buf);
      }
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

    const { period_month, period_year, period_type } = decl;
    const isQuarterly = period_type === 'quarterly';
    const filename = isQuarterly
      ? `01GTGT_${period_year}_Q${period_month}.xml`
      : `01GTGT_${period_year}_${String(period_month).padStart(2, '0')}.xml`;
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

// DELETE /api/declarations/:id — xóa vĩnh viễn tờ khai (chỉ khi còn draft/ready)
router.delete(
  '/:id',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `DELETE FROM tax_declarations
         WHERE id = $1 AND company_id = $2
           AND submission_status IN ('draft', 'ready')
         RETURNING id`,
        [req.params.id, req.user!.companyId]
      );
      if (!result.rows[0]) {
        throw new NotFoundError(
          'Không tìm thấy tờ khai hoặc tờ khai đã nộp (không thể xóa)'
        );
      }
      sendSuccess(res, null, 'Đã xóa tờ khai');
    } catch (err) {
      next(err);
    }
  }
);

export default router;
