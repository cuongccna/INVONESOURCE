/**
 * Group 41 — HKD routes
 * Ho kinh doanh / ca nhan declaration and tax settings.
 * Includes quarterly tờ khai TT40/2021 (maTKhai=473) with XML/Excel/PDF exports.
 */
import { Router, Request, Response } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { pool } from '../db/pool';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import ExcelJS from 'exceljs';
import puppeteer from 'puppeteer';
import { HkdDeclarationEngine } from '../services/HkdDeclarationEngine';
import { HkdHtkkXmlGenerator } from '../services/HkdHtkkXmlGenerator';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const HKD_MONTHLY_THRESHOLD = 8_330_000; // VND — mandatory declaration if exceeded

// GET /api/hkd/tax-statement?month=&year=
router.get('/tax-statement', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  if (month < 1 || month > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  // Fetch company tax settings
  const compAny = await pool.query<{
    business_type: string; tax_regime: string; vat_rate_hkd: string;
  }>(
    `SELECT COALESCE(business_type,'DN') AS business_type,
            COALESCE(tax_regime,'khau_tru') AS tax_regime,
            COALESCE(vat_rate_hkd,1.0) AS vat_rate_hkd
     FROM companies WHERE id=$1`,
    [companyId],
  );
  const comp = compAny.rows[0];
if (!comp) throw new AppError('Company not found', 404, 'NOT_FOUND');

  // Fetch existing statement if any
  const existing = await pool.query(
    `SELECT * FROM hkd_tax_statements WHERE company_id=$1 AND period_month=$2 AND period_year=$3`,
    [companyId, month, year],
  );

  // Calculate revenue for the period
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).toISOString().split('T')[0];

  const revRes = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(subtotal),0) AS total FROM invoices
     WHERE company_id=$1 AND direction='output' AND status='valid'
       AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3`,
    [companyId, startDate, endDate],
  );
  const revenue = Number(revRes.rows[0]?.total ?? 0);
  const vatRate = Number(comp.vat_rate_hkd);
  const vatPayable = comp.tax_regime === 'khoan' ? Math.round(revenue * vatRate / 100) : 0;
  const pitPayable = ['HKD','HND','CA_NHAN'].includes(comp.business_type)
    ? Math.round(revenue * 0.005)
    : 0;
  const totalPayable = vatPayable + pitPayable;
  const mustDeclare = revenue > HKD_MONTHLY_THRESHOLD;

  sendSuccess(res, {
    period: { month, year },
    company_type: comp.business_type,
    tax_regime: comp.tax_regime,
    vat_rate_hkd: vatRate,
    revenue,
    vat_payable: vatPayable,
    pit_payable: pitPayable,
    total_payable: totalPayable,
    must_declare: mustDeclare,
    threshold: HKD_MONTHLY_THRESHOLD,
    saved_statement: existing.rows[0] ?? null,
  });
});

// POST /api/hkd/generate  — generate & save HKD tax statement
router.post('/generate', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year } = req.body as { month?: number; year?: number };
  const m = parseInt(String(month)) || new Date().getMonth() + 1;
  const y = parseInt(String(year)) || new Date().getFullYear();
  if (m < 1 || m > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const endDate = new Date(y, m, 0).toISOString().split('T')[0];

  const [compAny, revRes] = await Promise.all([
    pool.query<{ vat_rate_hkd: string; tax_regime: string; business_type: string }>(
      `SELECT COALESCE(vat_rate_hkd,1.0) AS vat_rate_hkd,
              COALESCE(tax_regime,'khoan') AS tax_regime,
              COALESCE(business_type,'HKD') AS business_type
       FROM companies WHERE id=$1`,
      [companyId],
    ),
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(subtotal),0) AS total FROM invoices
       WHERE company_id=$1 AND direction='output' AND status='valid'
         AND deleted_at IS NULL
         AND invoice_date BETWEEN $2 AND $3`,
      [companyId, startDate, endDate],
    ),
  ]);

  const comp = compAny.rows[0];
  if (!comp) throw new AppError('Company not found', 404, 'NOT_FOUND');
  const revenue = Number(revRes.rows[0]?.total ?? 0);
  const vatRate = Number(comp.vat_rate_hkd);
  const vatPayable = comp.tax_regime === 'khoan' ? Math.round(revenue * vatRate / 100) : 0;
  const pitPayable = Math.round(revenue * 0.005);
  const totalPayable = vatPayable + pitPayable;

  const { rows } = await pool.query(
    `INSERT INTO hkd_tax_statements
       (company_id, period_month, period_year, revenue, vat_rate, vat_payable, pit_payable, total_payable)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id, period_month, period_year) DO UPDATE SET
       revenue=$4, vat_rate=$5, vat_payable=$6, pit_payable=$7, total_payable=$8, generated_at=NOW()
     RETURNING *`,
    [companyId, m, y, revenue, vatRate, vatPayable, pitPayable, totalPayable],
  );

  sendSuccess(res, rows[0], 'HKD tax statement generated');
});

// PATCH /api/hkd/settings  — update company tax type settings
router.patch('/settings', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { business_type, tax_regime, vat_rate_hkd } = req.body as Record<string, unknown>;

  const validBusinessTypes = ['DN','HKD','HND','CA_NHAN'];
  const validTaxRegimes = ['khoan','thuc_te','khau_tru'];

  if (business_type && !validBusinessTypes.includes(String(business_type))) {
    throw new AppError(`business_type must be one of: ${validBusinessTypes.join(', ')}`, 400, 'VALIDATION');
  }
  if (tax_regime && !validTaxRegimes.includes(String(tax_regime))) {
    throw new AppError(`tax_regime must be one of: ${validTaxRegimes.join(', ')}`, 400, 'VALIDATION');
  }
  if (vat_rate_hkd !== undefined && (Number(vat_rate_hkd) < 0 || Number(vat_rate_hkd) > 100)) {
    throw new AppError('vat_rate_hkd must be 0-100', 400, 'VALIDATION');
  }

  const { rows } = await pool.query(
    `UPDATE companies SET
       business_type=COALESCE($2::business_type_enum, business_type),
       tax_regime=COALESCE($3::tax_regime_enum, tax_regime),
       vat_rate_hkd=COALESCE($4, vat_rate_hkd),
       updated_at=NOW()
     WHERE id=$1
     RETURNING id, name, business_type, tax_regime, vat_rate_hkd`,
    [companyId,
     business_type ? String(business_type) : null,
     tax_regime ? String(tax_regime) : null,
     vat_rate_hkd !== undefined ? Number(vat_rate_hkd) : null],
  );
  if (!rows.length) throw new AppError('Company not found', 404, 'NOT_FOUND');
  sendSuccess(res, rows[0]);
});

// ==================== QUARTERLY HKD DECLARATIONS (TT40/2021) ====================

// GET /api/hkd/declarations?year=
router.get('/declarations', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT * FROM hkd_declarations
     WHERE company_id = $1 AND period_year = $2
     ORDER BY period_quarter DESC`,
    [companyId, year],
  );
  sendSuccess(res, rows);
});

// GET /api/hkd/declarations/:id
router.get('/declarations/:id', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM hkd_declarations WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  if (!rows.length) throw new AppError('Declaration not found', 404, 'NOT_FOUND');
  sendSuccess(res, rows[0]);
});

// POST /api/hkd/declarations — calculate & upsert quarterly declaration
router.post('/declarations', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { quarter, year } = req.body as { quarter?: unknown; year?: unknown };
  const q = parseInt(String(quarter));
  const y = parseInt(String(year));
  if (isNaN(q) || q < 1 || q > 4) throw new AppError('quarter must be 1-4', 400, 'VALIDATION');
  if (isNaN(y) || y < 2020) throw new AppError('year must be >= 2020', 400, 'VALIDATION');

  const engine = new HkdDeclarationEngine();
  const decl = await engine.calculateQuarterlyDeclaration(companyId, q, y, req.user!.userId);
  sendSuccess(res, decl, 'HKD declaration calculated');
});

// PATCH /api/hkd/declarations/:id/status
router.patch('/declarations/:id/status', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { status } = req.body as { status?: unknown };
  const allowed = ['ready', 'submitted'];
  if (!status || !allowed.includes(String(status))) {
    throw new AppError(`status must be one of: ${allowed.join(', ')}`, 400, 'VALIDATION');
  }
  const { rows } = await pool.query(
    `UPDATE hkd_declarations SET submission_status = $1, updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [String(status), id, companyId],
  );
  if (!rows.length) throw new AppError('Declaration not found', 404, 'NOT_FOUND');
  sendSuccess(res, rows[0]);
});

// DELETE /api/hkd/declarations/:id
router.delete('/declarations/:id', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { rows } = await pool.query(
    `DELETE FROM hkd_declarations
     WHERE id = $1 AND company_id = $2 AND submission_status IN ('draft','ready')
     RETURNING id`,
    [id, companyId],
  );
  if (!rows.length) throw new AppError('Declaration not found or cannot be deleted', 404, 'NOT_FOUND');
  sendSuccess(res, { id: rows[0].id }, 'Deleted');
});

// GET /api/hkd/declarations/:id/xml
router.get('/declarations/:id/xml', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT * FROM hkd_declarations WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  if (!rows.length) throw new AppError('Declaration not found', 404, 'NOT_FOUND');

  const decl = rows[0];
  const generator = new HkdHtkkXmlGenerator();
  const xml = await generator.generate(decl);

  const filename = `TT40_Q${decl.period_quarter}_${decl.period_year}.xml`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(xml);
});

// GET /api/hkd/declarations/:id/export?format=excel|pdf
router.get('/declarations/:id/export', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const format = req.query.format === 'pdf' ? 'pdf' : 'excel';

  const { rows: declRows } = await pool.query(
    `SELECT hd.*, c.name AS company_name, c.tax_code, c.address
     FROM hkd_declarations hd
     JOIN companies c ON c.id = hd.company_id
     WHERE hd.id = $1 AND hd.company_id = $2`,
    [id, companyId],
  );
  if (!declRows.length) throw new AppError('Declaration not found', 404, 'NOT_FOUND');
  const d = declRows[0];

  const m1 = (d.period_quarter - 1) * 3 + 1;
  const m2 = m1 + 1;
  const m3 = m1 + 2;
  const fmtVND = (v: number) => Number(v).toLocaleString('vi-VN');

  if (format === 'excel') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('TT40 Tổng hợp');

    ws.mergeCells('A1:D1');
    ws.getCell('A1').value = `TỜ KHAI THUẾ HỘ KINH DOANH / CNKD (TT40/2021)`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A1').alignment = { horizontal: 'center' };

    ws.mergeCells('A2:D2');
    ws.getCell('A2').value = `${d.company_name} — MST: ${d.tax_code}`;
    ws.getCell('A2').alignment = { horizontal: 'center' };

    ws.mergeCells('A3:D3');
    ws.getCell('A3').value = `Kỳ: Quý ${d.period_quarter}/${d.period_year} (Tháng ${m1}—${m3}/${d.period_year})`;
    ws.getCell('A3').alignment = { horizontal: 'center' };

    ws.addRow([]);
    ws.addRow(['Chỉ tiêu', `Tháng ${m1}`, `Tháng ${m2}`, `Tháng ${m3}`, 'Tổng quý']);
    ws.getRow(5).font = { bold: true };
    ws.getRow(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };

    const rows: [string, number, number, number, number][] = [
      ['Doanh thu chịu thuế GTGT', d.revenue_m1, d.revenue_m2, d.revenue_m3, d.revenue_total],
      [`Thuế GTGT khoán (${d.vat_rate}%)`, d.vat_m1, d.vat_m2, d.vat_m3, d.vat_total],
      ['Doanh thu chịu thuế TNCN', d.revenue_m1, d.revenue_m2, d.revenue_m3, d.revenue_total],
      ['Thuế TNCN (0.5%)', d.pit_m1, d.pit_m2, d.pit_m3, d.pit_total],
    ];

    for (const [label, v1, v2, v3, total] of rows) {
      const r = ws.addRow([label, v1, v2, v3, total]);
      for (let col = 2; col <= 5; col++) {
        r.getCell(col).numFmt = '#,##0';
        r.getCell(col).alignment = { horizontal: 'right' };
      }
    }

    ws.addRow([]);
    const totalRow = ws.addRow(['TỔNG PHẢI NỘP', '', '', '', d.total_payable]);
    totalRow.font = { bold: true, color: { argb: 'FFCC0000' } };
    totalRow.getCell(5).numFmt = '#,##0';
    totalRow.getCell(5).alignment = { horizontal: 'right' };

    ws.columns = [
      { width: 38 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 },
    ];

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="TT40_Q${d.period_quarter}_${d.period_year}.xlsx"`);
    res.send(buf);
    return;
  }

  // PDF via Puppeteer
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; padding: 24px; }
  h2 { text-align: center; margin-bottom: 4px; }
  .sub { text-align: center; color: #555; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border: 1px solid #aaa; padding: 6px 10px; }
  th { background: #d9ead3; text-align: center; }
  td.num { text-align: right; }
  .total-row td { font-weight: bold; color: #cc0000; }
</style>
</head>
<body>
<h2>TỜ KHAI THUẾ HỘ KINH DOANH / CNKD (TT40/2021)</h2>
<p class="sub">${d.company_name} — MST: ${d.tax_code}</p>
<p class="sub">Kỳ: Quý ${d.period_quarter}/${d.period_year} (Tháng ${m1}–${m3}/${d.period_year})</p>
<table>
  <thead>
    <tr><th>Chỉ tiêu</th><th>Tháng ${m1}</th><th>Tháng ${m2}</th><th>Tháng ${m3}</th><th>Tổng quý</th></tr>
  </thead>
  <tbody>
    <tr><td>Doanh thu chịu thuế GTGT</td><td class="num">${fmtVND(d.revenue_m1)}</td><td class="num">${fmtVND(d.revenue_m2)}</td><td class="num">${fmtVND(d.revenue_m3)}</td><td class="num">${fmtVND(d.revenue_total)}</td></tr>
    <tr><td>Thuế GTGT khoán (${d.vat_rate}%)</td><td class="num">${fmtVND(d.vat_m1)}</td><td class="num">${fmtVND(d.vat_m2)}</td><td class="num">${fmtVND(d.vat_m3)}</td><td class="num">${fmtVND(d.vat_total)}</td></tr>
    <tr><td>Doanh thu chịu thuế TNCN</td><td class="num">${fmtVND(d.revenue_m1)}</td><td class="num">${fmtVND(d.revenue_m2)}</td><td class="num">${fmtVND(d.revenue_m3)}</td><td class="num">${fmtVND(d.revenue_total)}</td></tr>
    <tr><td>Thuế TNCN (0.5%)</td><td class="num">${fmtVND(d.pit_m1)}</td><td class="num">${fmtVND(d.pit_m2)}</td><td class="num">${fmtVND(d.pit_m3)}</td><td class="num">${fmtVND(d.pit_total)}</td></tr>
    <tr class="total-row"><td colspan="4">TỔNG PHẢI NỘP</td><td class="num">${fmtVND(d.total_payable)}</td></tr>
  </tbody>
</table>
</body>
</html>`;

  const chromiumPath = process.env.CHROMIUM_PATH;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromiumPath || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({ format: 'A4', margin: { top: '16mm', bottom: '16mm', left: '16mm', right: '16mm' } });
  await browser.close();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="TT40_Q${d.period_quarter}_${d.period_year}.pdf"`);
  res.send(Buffer.from(pdfBuffer));
});

export default router;
