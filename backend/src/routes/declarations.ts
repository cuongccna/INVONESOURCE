import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { TaxDeclarationEngine } from '../services/TaxDeclarationEngine';
import {
  HtkkXmlGenerator, validateVatDeclarationXml, validateDeclarationHeader,
} from '../services/HtkkXmlGenerator';
import { TVanSubmissionService } from '../services/TVanSubmissionService';
import { TaxDeclarationExporter } from '../services/TaxDeclarationExporter';
import { checkLineItemSync } from '../services/InvoiceSyncChecker';
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
      const isQuarterly = parsed.data.quarter !== undefined;
      const periodMonthOrQuarter = parsed.data.quarter ?? parsed.data.month!;
      const [ct23Warnings, syncWarning] = await Promise.all([
        engine.getCT23Warnings(req.user!.companyId!, month, parsed.data.year).catch(() => null),
        checkLineItemSync(req.user!.companyId!, periodMonthOrQuarter, parsed.data.year, isQuarterly).catch(() => null),
      ]);
      console.log('[CALC-DEBUG] result:', { id: declaration.id, companyId: declaration.company_id, ct40a: declaration.ct40a_total_output_vat, ct23: declaration.ct23_deductible_input_vat, ct41: declaration.ct41_payable_vat, ct43: declaration.ct43_carry_forward_vat });
      sendSuccess(res, { ...declaration, _warnings: ct23Warnings, _syncWarning: syncWarning });
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
        `SELECT ct23_deductible_input_vat, ct40a_total_output_vat
         FROM tax_declarations WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      if (!rows[0]) throw new NotFoundError('Declaration not found');

      const ct24 = opening_balance;
      const ct23 = Number(rows[0].ct23_deductible_input_vat ?? 0);
      const ct40a_raw = Number(rows[0].ct40a_total_output_vat ?? 0);
      const ct25 = ct23 + ct24;
      // FIX: Do NOT subtract ct36_nq_vat_reduction — NQ142 invoices are already issued at 8%,
      // their VAT is correctly reflected in ct40a. Subtracting again is a double-reduction.
      const ct41 = Math.max(0, ct40a_raw - ct25);
      const ct43 = Math.max(0, ct25 - ct40a_raw);

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
      }>(
        `SELECT ct23_deductible_input_vat, ct24_carried_over_vat, ct40a_total_output_vat
         FROM tax_declarations WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      if (!rows[0]) throw new NotFoundError('Declaration not found');

      const ct23  = Number(rows[0].ct23_deductible_input_vat ?? 0);
      const ct24  = Number(rows[0].ct24_carried_over_vat ?? 0);
      const ct25  = ct23 + ct24;
      const ct40a = Number(rows[0].ct40a_total_output_vat ?? 0);

      const ct37_manual  = body.ct37  ?? 0;
      const ct38_manual  = body.ct38  ?? 0;
      const ct40b_manual = body.ct40b ?? 0;

      // FIX: Do NOT subtract ct36_nq_vat_reduction — NQ142 invoices are already issued at 8%,
      // their VAT is correctly reflected in ct40a. Subtracting again is a double-reduction.
      const net      = ct40a - ct25 + ct37_manual - ct38_manual;
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
      const isQuarterlyExport = period_type === 'quarterly';
      const periodTag = isQuarterlyExport ? `Q${period_month}` : `T${period_month < 10 ? '0' : ''}${period_month}`;

      // Cảnh báo hóa đơn chưa đồng bộ line items — trả về header để UI hiển thị toast
      const syncWarning = await checkLineItemSync(
        req.user!.companyId!, period_month, period_year, isQuarterlyExport,
      ).catch(() => null);
      if (syncWarning) {
        res.setHeader('X-Sync-Warning', encodeURIComponent(JSON.stringify(syncWarning)));
        res.setHeader('Access-Control-Expose-Headers', 'X-Sync-Warning');
      }

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
/**
 * F8 — TỜ KHAI BỔ SUNG (khai bổ sung hồ sơ khai thuế)
 *
 * Khi phát hiện sai sót của kỳ đã nộp, người nộp thuế lập tờ khai bổ sung cho chính kỳ đó
 * kèm bản giải trình khai bổ sung. Tờ khai bổ sung có loaiTKhai = 'B' và số lần khai bổ sung.
 *
 * Căn cứ: Luật Quản lý thuế 38/2019/QH14 và Thông tư 80/2021/TT-BTC (mẫu 01/KHBS).
 *
 * POST /api/declarations/:id/amend  { reason }
 *   → tạo tờ khai bổ sung mới, giữ nguyên tờ khai gốc để đối chiếu,
 *     lưu ảnh chụp chỉ tiêu cũ vào khbs_snapshot.
 */
router.post('/:id/amend', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId!;
    const body = z.object({ reason: z.string().min(5).max(1000) }).safeParse(req.body ?? {});
    if (!body.success) throw new ValidationError('Phải ghi rõ lý do khai bổ sung (tối thiểu 5 ký tự)');

    const { rows } = await pool.query(
      `SELECT * FROM tax_declarations WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId],
    );
    const origin = rows[0];
    if (!origin) throw new NotFoundError('Không tìm thấy tờ khai');

    // Số lần khai bổ sung tiếp theo của cùng kỳ
    const { rows: cntRows } = await pool.query<{ max_no: string | null }>(
      `SELECT MAX(amendment_no) AS max_no
         FROM tax_declarations
        WHERE company_id = $1 AND period_year = $2 AND period_month = $3 AND period_type = $4`,
      [companyId, origin.period_year, origin.period_month, origin.period_type],
    );
    const nextNo = Number(cntRows[0]?.max_no ?? 0) + 1;

    // Ảnh chụp chỉ tiêu của tờ khai đang có — dùng lập bản giải trình chênh lệch
    const snapshot: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(origin)) {
      if (k.startsWith('ct') && v !== null) snapshot[k] = v;
    }

    // Tính lại số liệu kỳ đó theo dữ liệu hoá đơn hiện tại
    const engine = new TaxDeclarationEngine();
    const recalculated = origin.period_type === 'quarterly'
      ? await engine.calculateQuarterlyDeclaration(companyId, origin.period_month, origin.period_year)
      : await engine.calculateDeclaration(companyId, origin.period_month, origin.period_year);

    const { rows: amended } = await pool.query(
      `UPDATE tax_declarations
          SET declaration_type      = 'bo_sung',
              amendment_no          = $2,
              amends_declaration_id = $3,
              khbs_reason           = $4,
              khbs_snapshot         = $5::jsonb,
              submission_status     = 'draft',
              xml_content           = NULL,
              xml_generated_at      = NULL,
              updated_at            = NOW()
        WHERE id = $1
      RETURNING *`,
      [recalculated.id ?? req.params.id, nextNo, origin.id, body.data.reason, JSON.stringify(snapshot)],
    );

    return sendSuccess(res, {
      declaration: amended[0] ?? recalculated,
      amendment_no: nextNo,
      message: `Đã lập tờ khai bổ sung lần ${nextNo} cho kỳ ${origin.period_month}/${origin.period_year}. `
             + 'Kiểm tra bản giải trình chênh lệch trước khi xuất XML.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/declarations/:id/khbs — bản giải trình khai bổ sung.
 * So sánh từng chỉ tiêu giữa tờ khai đã nộp và tờ khai bổ sung, chỉ liệt kê chỉ tiêu thay đổi.
 */
router.get('/:id/khbs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tax_declarations WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user!.companyId],
    );
    const decl = rows[0];
    if (!decl) throw new NotFoundError('Không tìm thấy tờ khai');
    if (decl.declaration_type !== 'bo_sung') {
      throw new ValidationError('Tờ khai này không phải tờ khai bổ sung');
    }

    const snapshot = (decl.khbs_snapshot ?? {}) as Record<string, unknown>;
    const changes: Array<{ indicator: string; before: number; after: number; delta: number }> = [];

    for (const [key, before] of Object.entries(snapshot)) {
      const after = Number(decl[key] ?? 0);
      const prev  = Number(before ?? 0);
      if (Math.abs(after - prev) >= 1) {
        changes.push({ indicator: key, before: prev, after, delta: after - prev });
      }
    }
    changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    return sendSuccess(res, {
      period: { month: decl.period_month, year: decl.period_year, type: decl.period_type },
      amendment_no: decl.amendment_no,
      reason: decl.khbs_reason,
      changes,
      // Chênh lệch tiền thuế phải nộp là con số cơ quan thuế quan tâm nhất
      tax_delta: Number(decl.ct41_payable_vat ?? 0) - Number(snapshot['ct41_payable_vat'] ?? 0),
      legal_basis: 'Luật Quản lý thuế 38/2019/QH14; mẫu 01/KHBS ban hành kèm Thông tư 80/2021/TT-BTC',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/xml', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT * FROM tax_declarations WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user!.companyId]
    );
    const decl = result.rows[0];
    if (!decl) throw new NotFoundError('Declaration not found');

    // Tờ khai ĐÃ NỘP: giữ nguyên bản XML đã gửi cơ quan thuế để còn đối chiếu.
    // Tờ khai chưa nộp: LUÔN sinh lại. Bản lưu trong xml_content có thể là sản phẩm của
    // phiên bản sinh XML cũ (đã từng ghi sai tên khối phụ lục / thiếu khai báo <?xml?>),
    // tải về sẽ không ký số được — trước đây chỉ sinh lại khi client gửi ?regenerate=true
    // nên người dùng cứ tải trúng bản hỏng đã cache.
    const isSubmitted = ['submitted', 'accepted'].includes(decl.submission_status as string);
    let xml: string = decl.xml_content as string;
    if (!xml || !isSubmitted || req.query['regenerate'] === 'true') {
      const generator = new HtkkXmlGenerator();
      xml = await generator.generate(decl as TaxDeclaration);
    }

    // F11: cảnh báo nếu tờ khai vi phạm đẳng thức bắt buộc của mẫu 01/GTGT,
    // hoặc thiếu trường bắt buộc khiến eTax không nhận file khi nộp.
    const warnings = [...validateDeclarationHeader(xml), ...validateVatDeclarationXml(xml)];
    if (warnings.length > 0) {
      res.setHeader('X-Declaration-Warnings', encodeURIComponent(warnings.join(' | ')));
    }
    res.setHeader('Access-Control-Expose-Headers', 'X-Declaration-Warnings, X-Sync-Warning');

    const { period_month, period_year, period_type } = decl;
    const isQuarterly = period_type === 'quarterly';

    // Cảnh báo hóa đơn chưa đồng bộ line items — trả về header để UI hiển thị toast
    const syncWarning = await checkLineItemSync(
      req.user!.companyId!, period_month as number, period_year as number, isQuarterly,
    ).catch(() => null);
    if (syncWarning) {
      res.setHeader('X-Sync-Warning', encodeURIComponent(JSON.stringify(syncWarning)));
    }

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

      // Luôn sinh lại trước khi nộp: tờ khai ở trạng thái draft/ready có thể đang giữ bản
      // XML cache của phiên bản sinh XML cũ, nộp lên sẽ bị cơ quan thuế từ chối.
      const generator = new HtkkXmlGenerator();
      const xml = await generator.generate(decl as TaxDeclaration);

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
