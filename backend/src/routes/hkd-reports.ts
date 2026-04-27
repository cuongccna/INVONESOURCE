/**
 * hkd-reports.ts — HKD Sổ Sách Routes (TT152/2025)
 * Provides JSON data + Excel export for 7 HKD accounting books:
 *   S1a  SỔ CHI TIẾT DOANH THU BÁN HÀNG HÓA, DỊCH VỤ
 *   S2a  SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ (GTGT + TNCN)
 *   S2b  SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ (GTGT only)
 *   S2c  SỔ CHI TIẾT DOANH THU, CHI PHÍ
 *   S2d  SỔ CHI TIẾT VẬT LIỆU, DỤNG CỤ, SẢN PHẨM, HÀNG HÓA
 *   S2e  SỔ CHI TIẾT TIỀN
 *   S3a  SỔ THEO DÕI NGHĨA VỤ THUẾ KHÁC
 *
 * Every route is isolated — a crash in one cannot affect the others.
 * Auth: authenticate + requireCompany + household guard.
 */
import { Router, Request, Response } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { pool } from '../db/pool';
import { AppError } from '../utils/AppError';
import ExcelJS from 'exceljs';
import { INDUSTRY_GROUP_RATES } from '../services/HkdDeclarationEngine';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// ── Shared helpers ──────────────────────────────────────────────────────────

function quarterRange(q: number, year: number) {
  const sm = (q - 1) * 3 + 1;
  const em = sm + 2;
  const start = `${year}-${String(sm).padStart(2, '0')}-01`;
  const end   = new Date(year, em, 0).toISOString().split('T')[0]!;
  return { start, end, sm, em, months: [sm, sm + 1, sm + 2] as [number,number,number] };
}

function parseQY(query: Record<string, unknown>) {
  const q    = Math.max(1, Math.min(4, Number(query.quarter) || 1));
  const year = Number(query.year) || new Date().getFullYear();
  return { q, year };
}

interface CompanyRow {
  company_type: string;
  business_type: string;
  name: string;
  tax_code: string;
  address: string | null;
  hkd_industry_group: string;
}

async function guardHousehold(companyId: string): Promise<CompanyRow> {
  const r = await pool.query<CompanyRow>(
    `SELECT company_type,
            COALESCE(business_type, 'DN') AS business_type,
            name, tax_code, address,
            COALESCE(hkd_industry_group, 28) AS hkd_industry_group
     FROM companies WHERE id = $1`,
    [companyId],
  );
  const c = r.rows[0];
  if (!c) throw new AppError('Company not found', 404, 'NOT_FOUND');
  const isHousehold = c.company_type === 'household' || ['HKD', 'HND', 'CA_NHAN'].includes(c.business_type);
  if (!isHousehold) throw new AppError('Endpoint chỉ dành cho hộ kinh doanh', 400, 'VALIDATION');
  return c;
}

const THIN = { style: 'thin' } as const;
const ALL_BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const HDR_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFDCE3F5' } };
const NUM_FMT = '#,##0';

function applyBorders(row: ExcelJS.Row) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = ALL_BORDERS;
  });
}

function writeCompanyHeader(ws: ExcelJS.Worksheet, comp: CompanyRow, mauSo: string, mauDesc: string) {
  ws.getCell('A1').value = `HỌ, CÁ NHÂN KINH DOANH: ${comp.name}`;
  ws.getCell('A1').font  = { bold: true };
  ws.getCell('A2').value = `Mã số thuế: ${comp.tax_code ?? ''}`;
  ws.getCell('A3').value = `Địa chỉ: ${comp.address ?? ''}`;
  ws.getCell('F1').value = mauSo;
  ws.getCell('F1').font  = { bold: true, italic: true };
  ws.getCell('F1').alignment = { horizontal: 'right' };
  ws.getCell('F2').value = mauDesc;
  ws.getCell('F2').font  = { italic: true, size: 8 };
  ws.getCell('F2').alignment = { horizontal: 'right', wrapText: true };
  ws.getCell('F3').value = '(Kèm theo Thông tư số 152/2025/TT-BTC)';
  ws.getCell('F3').font  = { italic: true, size: 8 };
  ws.getCell('F3').alignment = { horizontal: 'right' };
}

function writeSigBlock(ws: ExcelJS.Worksheet, row: number, lastCol: number) {
  const sigCol = lastCol;
  ws.getRow(row).getCell(sigCol).value = 'Ngày ... tháng ... năm ...';
  ws.getRow(row + 1).getCell(sigCol).value = 'NGƯỜI ĐẠI DIỆN HỘ KINH DOANH/';
  ws.getRow(row + 1).getCell(sigCol).font = { bold: true };
  ws.getRow(row + 2).getCell(sigCol).value = 'CÁ NHÂN KINH DOANH';
  ws.getRow(row + 2).getCell(sigCol).font = { bold: true };
  ws.getRow(row + 3).getCell(sigCol).value = '(Ký, họ tên, đóng dấu)';
  ws.getRow(row + 3).getCell(sigCol).font = { italic: true };
  for (let r = row; r <= row + 3; r++) {
    ws.getRow(r).getCell(sigCol).alignment = { horizontal: 'center' };
  }
}

// ── S1a ──────────────────────────────────────────────────────────────────────
// SỔ CHI TIẾT DOANH THU BÁN HÀNG HÓA, DỊCH VỤ

router.get('/s1a', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const rows = await pool.query<{
    invoice_date: string; invoice_number: string;
    buyer_name: string | null; subtotal: string;
  }>(
    `SELECT invoice_date::text, invoice_number, buyer_name, COALESCE(subtotal,0) AS subtotal
     FROM invoices
     WHERE company_id=$1 AND direction='output' AND status='valid' AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     ORDER BY invoice_date, created_at`,
    [companyId, start, end],
  );

  const total = rows.rows.reduce((s, r) => s + Number(r.subtotal), 0);

  res.json({
    success: true,
    data: {
      company: { name: comp.name, tax_code: comp.tax_code, address: comp.address },
      period: { quarter: q, year, start_month: sm, end_month: em },
      rows: rows.rows.map((r) => ({
        invoice_date: r.invoice_date,
        description: `${r.invoice_number}${r.buyer_name ? ' – ' + r.buyer_name : ''}`,
        amount: Number(r.subtotal),
      })),
      total_amount: total,
    },
  });
});

router.get('/s1a/excel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const rows = await pool.query<{
    invoice_date: string; invoice_number: string;
    buyer_name: string | null; subtotal: string;
  }>(
    `SELECT invoice_date::text, invoice_number, buyer_name, COALESCE(subtotal,0) AS subtotal
     FROM invoices
     WHERE company_id=$1 AND direction='output' AND status='valid' AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     ORDER BY invoice_date`,
    [companyId, start, end],
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S1a-HKD');
  ws.properties.defaultColWidth = 20;

  writeCompanyHeader(ws, comp, 'Mẫu số S1a-HKD', '(Kèm theo TT 152/2025/TT-BTC)');
  ws.getRow(5).getCell(1).value = 'SỔ CHI TIẾT DOANH THU BÁN HÀNG HÓA, DỊCH VỤ';
  ws.getRow(5).getCell(1).font  = { bold: true, size: 12 };
  ws.getRow(5).getCell(1).alignment = { horizontal: 'center' };
  ws.mergeCells('A5:C5');
  ws.getRow(6).getCell(1).value = `Địa điểm kinh doanh: ${comp.address ?? ''}`;
  ws.getRow(6).getCell(1).alignment = { horizontal: 'center' };
  ws.mergeCells('A6:C6');
  ws.getRow(7).getCell(1).value = `Kỳ kê khai: Quý ${q}/${year} (T${sm}/${year} – T${em}/${year})`;
  ws.getRow(7).getCell(1).alignment = { horizontal: 'center' };
  ws.mergeCells('A7:C7');

  const hdr = ws.getRow(9);
  hdr.values = ['Ngày tháng', 'Giao dịch', 'Số tiền'];
  hdr.font = { bold: true }; hdr.fill = HDR_FILL; applyBorders(hdr);
  hdr.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle' }; });

  const sub = ws.getRow(10);
  sub.values = ['A', 'B', '1'];
  sub.font = { bold: true, italic: true }; applyBorders(sub);
  sub.eachCell(c => { c.alignment = { horizontal: 'center' }; });

  let dr = 11; let total = 0;
  for (const r of rows.rows) {
    const amt = Number(r.subtotal); total += amt;
    const row = ws.getRow(dr++);
    row.values = [r.invoice_date, `${r.invoice_number}${r.buyer_name ? ' – ' + r.buyer_name : ''}`, amt];
    row.getCell(3).numFmt = NUM_FMT; applyBorders(row);
  }
  const tr = ws.getRow(dr);
  tr.values = ['', 'Tổng cộng', total]; tr.font = { bold: true };
  tr.getCell(3).numFmt = NUM_FMT; applyBorders(tr);

  ws.getColumn(1).width = 14; ws.getColumn(2).width = 52; ws.getColumn(3).width = 18;
  writeSigBlock(ws, dr + 2, 3);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=S1a-HKD_Q${q}_${year}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// ── S2a ──────────────────────────────────────────────────────────────────────
// SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ (grouped by industry, GTGT + TNCN)

async function fetchS2Data(companyId: string, q: number, year: number) {
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);
  const ig = Number(comp.hkd_industry_group);
  const rates = INDUSTRY_GROUP_RATES[ig] ?? INDUSTRY_GROUP_RATES[28]!;

  const rows = await pool.query<{
    invoice_number: string; invoice_date: string;
    buyer_name: string | null; subtotal: string;
  }>(
    `SELECT invoice_number, invoice_date::text, buyer_name, COALESCE(subtotal,0) AS subtotal
     FROM invoices
     WHERE company_id=$1 AND direction='output' AND status='valid' AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     ORDER BY invoice_date`,
    [companyId, start, end],
  );

  const revenue = rows.rows.reduce((s, r) => s + Number(r.subtotal), 0);
  const vat = Math.round(revenue * rates.vat / 100);
  const pit = Math.round(revenue * rates.pit / 100);

  return { comp, start, end, sm, em, ig, rates, rows: rows.rows, revenue, vat, pit };
}

router.get('/s2a', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const { comp, sm, em, ig, rates, rows, revenue, vat, pit } = await fetchS2Data(req.user!.companyId!, q, year);

  res.json({
    success: true,
    data: {
      company: { name: comp.name, tax_code: comp.tax_code, address: comp.address },
      period: { quarter: q, year, start_month: sm, end_month: em },
      industry_group: ig, vat_rate: rates.vat, pit_rate: rates.pit,
      industry_label: rates.label,
      rows: rows.map(r => ({
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date,
        description: r.buyer_name ?? '',
        amount: Number(r.subtotal),
      })),
      revenue_total: revenue,
      vat_total: vat,
      pit_total: pit,
      tax_total: vat + pit,
    },
  });
});

function writeS2Sheet(
  ws: ExcelJS.Worksheet,
  comp: CompanyRow,
  mauSo: string, title: string,
  q: number, year: number, sm: number, em: number,
  ig: number, industryLabel: string,
  rows: Array<{ invoice_number: string; invoice_date: string; buyer_name: string | null; subtotal: string }>,
  vatRate: number, pitRate: number | null,
) {
  ws.properties.defaultColWidth = 16;
  writeCompanyHeader(ws, comp, mauSo, '(Kèm theo TT 152/2025/TT-BTC)');
  ws.getRow(5).getCell(1).value = title;
  ws.getRow(5).getCell(1).font  = { bold: true, size: 12 };
  ws.getRow(5).getCell(1).alignment = { horizontal: 'center' };
  ws.mergeCells('A5:D5');
  ws.getRow(6).getCell(1).value = `Địa điểm kinh doanh: ${comp.address ?? ''}`;
  ws.getRow(6).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A6:D6');
  ws.getRow(7).getCell(1).value = `Kỳ kê khai: Quý ${q}/${year} (T${sm}/${year} – T${em}/${year})`;
  ws.getRow(7).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A7:D7');

  // Table header
  const h1 = ws.getRow(9);
  h1.values = ['Số hiệu', 'Ngày, tháng', 'Diễn giải', 'Số tiền'];
  h1.font = { bold: true }; h1.fill = HDR_FILL; applyBorders(h1);
  h1.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });

  const h2 = ws.getRow(10);
  h2.values = ['A', 'B', 'C', '1'];
  h2.font = { bold: true, italic: true }; applyBorders(h2);
  h2.eachCell(c => { c.alignment = { horizontal: 'center' }; });

  // Industry section header
  let dr = 11;
  const secRow = ws.getRow(dr++);
  secRow.values = ['', '', `1. Ngành nghề: ${industryLabel} (Nhóm ${ig})`, ''];
  secRow.font = { bold: true }; applyBorders(secRow);
  ws.mergeCells(`C${dr - 1}:D${dr - 1}`);

  let revenue = 0;
  for (const r of rows) {
    const amt = Number(r.subtotal); revenue += amt;
    const row = ws.getRow(dr++);
    row.values = [r.invoice_number, r.invoice_date, r.buyer_name ?? '', amt];
    row.getCell(4).numFmt = NUM_FMT; applyBorders(row);
  }

  // Subtotals
  const vatAmt = Math.round(revenue * vatRate / 100);
  const subTotal = ws.getRow(dr++);
  subTotal.values = ['', '', 'Tổng cộng (1)', revenue];
  subTotal.font = { bold: true }; subTotal.getCell(4).numFmt = NUM_FMT; applyBorders(subTotal);

  const vatRow = ws.getRow(dr++);
  vatRow.values = ['', '', `Thuế GTGT (${vatRate}%)`, vatAmt];
  vatRow.getCell(4).numFmt = NUM_FMT; applyBorders(vatRow);

  if (pitRate !== null) {
    const pitAmt = Math.round(revenue * pitRate / 100);
    const pitRow = ws.getRow(dr++);
    pitRow.values = ['', '', `Thuế TNCN (${pitRate}%)`, pitAmt];
    pitRow.getCell(4).numFmt = NUM_FMT; applyBorders(pitRow);

    dr++;
    const totVat = ws.getRow(dr++);
    totVat.values = ['', '', 'Tổng số thuế GTGT phải nộp', vatAmt];
    totVat.font = { bold: true }; totVat.getCell(4).numFmt = NUM_FMT; applyBorders(totVat);
    const totPit = ws.getRow(dr++);
    totPit.values = ['', '', 'Tổng số thuế TNCN phải nộp', pitAmt];
    totPit.font = { bold: true }; totPit.getCell(4).numFmt = NUM_FMT; applyBorders(totPit);
  } else {
    dr++;
    const totVat = ws.getRow(dr++);
    totVat.values = ['', '', 'Tổng số thuế GTGT phải nộp', vatAmt];
    totVat.font = { bold: true }; totVat.getCell(4).numFmt = NUM_FMT; applyBorders(totVat);
  }

  ws.getColumn(1).width = 16; ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 46; ws.getColumn(4).width = 18;
  writeSigBlock(ws, dr + 2, 4);
}

router.get('/s2a/excel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const { comp, sm, em, ig, rates, rows } = await fetchS2Data(req.user!.companyId!, q, year);
  const wb = new ExcelJS.Workbook();
  writeS2Sheet(wb.addWorksheet('S2a-HKD'), comp, 'Mẫu số S2a-HKD',
    'SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ', q, year, sm, em, ig, rates.label, rows, rates.vat, rates.pit);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=S2a-HKD_Q${q}_${year}.xlsx`);
  await wb.xlsx.write(res); res.end();
});

// ── S2b ──────────────────────────────────────────────────────────────────────
// SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ (GTGT only)

router.get('/s2b', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const { comp, sm, em, ig, rates, rows, revenue, vat } = await fetchS2Data(req.user!.companyId!, q, year);
  res.json({
    success: true,
    data: {
      company: { name: comp.name, tax_code: comp.tax_code, address: comp.address },
      period: { quarter: q, year, start_month: sm, end_month: em },
      industry_group: ig, vat_rate: rates.vat, industry_label: rates.label,
      rows: rows.map(r => ({ invoice_number: r.invoice_number, invoice_date: r.invoice_date, description: r.buyer_name ?? '', amount: Number(r.subtotal) })),
      revenue_total: revenue, vat_total: vat,
    },
  });
});

router.get('/s2b/excel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const { comp, sm, em, ig, rates, rows } = await fetchS2Data(req.user!.companyId!, q, year);
  const wb = new ExcelJS.Workbook();
  writeS2Sheet(wb.addWorksheet('S2b-HKD'), comp, 'Mẫu số S2b-HKD',
    'SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ', q, year, sm, em, ig, rates.label, rows, rates.vat, null);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=S2b-HKD_Q${q}_${year}.xlsx`);
  await wb.xlsx.write(res); res.end();
});

// ── S2c ──────────────────────────────────────────────────────────────────────
// SỔ CHI TIẾT DOANH THU, CHI PHÍ

router.get('/s2c', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const [outRes, inRes] = await Promise.all([
    pool.query<{ invoice_number: string; invoice_date: string; buyer_name: string | null; subtotal: string }>(
      `SELECT invoice_number, invoice_date::text, buyer_name, COALESCE(subtotal,0) AS subtotal
       FROM invoices WHERE company_id=$1 AND direction='output' AND status='valid' AND deleted_at IS NULL
         AND invoice_date BETWEEN $2 AND $3 ORDER BY invoice_date`,
      [companyId, start, end],
    ),
    pool.query<{ invoice_number: string; invoice_date: string; seller_name: string | null; total_amount: string }>(
      `SELECT invoice_number, invoice_date::text, seller_name, COALESCE(total_amount,0) AS total_amount
       FROM invoices WHERE company_id=$1 AND direction='input' AND status='valid' AND deleted_at IS NULL
         AND invoice_date BETWEEN $2 AND $3 ORDER BY invoice_date`,
      [companyId, start, end],
    ),
  ]);

  const revenueTotal = outRes.rows.reduce((s, r) => s + Number(r.subtotal), 0);
  const expenseTotal = inRes.rows.reduce((s, r) => s + Number(r.total_amount), 0);

  res.json({
    success: true,
    data: {
      company: { name: comp.name, tax_code: comp.tax_code, address: comp.address },
      period: { quarter: q, year, start_month: sm, end_month: em },
      revenue_rows: outRes.rows.map(r => ({ invoice_number: r.invoice_number, invoice_date: r.invoice_date, description: r.buyer_name ?? '', amount: Number(r.subtotal) })),
      expense_rows: inRes.rows.map(r => ({ invoice_number: r.invoice_number, invoice_date: r.invoice_date, description: r.seller_name ?? '', amount: Number(r.total_amount) })),
      revenue_total: revenueTotal,
      expense_total: expenseTotal,
      profit: revenueTotal - expenseTotal,
    },
  });
});

router.get('/s2c/excel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const [outRes, inRes] = await Promise.all([
    pool.query<{ invoice_number: string; invoice_date: string; buyer_name: string | null; subtotal: string }>(
      `SELECT invoice_number, invoice_date::text, buyer_name, COALESCE(subtotal,0) AS subtotal
       FROM invoices WHERE company_id=$1 AND direction='output' AND status='valid' AND deleted_at IS NULL
         AND invoice_date BETWEEN $2 AND $3 ORDER BY invoice_date`,
      [companyId, start, end],
    ),
    pool.query<{ invoice_number: string; invoice_date: string; seller_name: string | null; total_amount: string }>(
      `SELECT invoice_number, invoice_date::text, seller_name, COALESCE(total_amount,0) AS total_amount
       FROM invoices WHERE company_id=$1 AND direction='input' AND status='valid' AND deleted_at IS NULL
         AND invoice_date BETWEEN $2 AND $3 ORDER BY invoice_date`,
      [companyId, start, end],
    ),
  ]);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S2c-HKD');
  writeCompanyHeader(ws, comp, 'Mẫu số S2c-HKD', '(Kèm theo TT 152/2025/TT-BTC)');

  ws.getRow(5).getCell(1).value = 'SỔ CHI TIẾT DOANH THU, CHI PHÍ';
  ws.getRow(5).getCell(1).font  = { bold: true, size: 12 };
  ws.getRow(5).getCell(1).alignment = { horizontal: 'center' };
  ws.mergeCells('A5:D5');
  ws.getRow(6).getCell(1).value = `Địa điểm kinh doanh: ${comp.address ?? ''}`;
  ws.getRow(6).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A6:D6');
  ws.getRow(7).getCell(1).value = `Kỳ kê khai: Quý ${q}/${year} (T${sm}/${year} – T${em}/${year})`;
  ws.getRow(7).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A7:D7');
  ws.getRow(8).getCell(4).value = 'Đơn vị tính: VNĐ';
  ws.getRow(8).getCell(4).alignment = { horizontal: 'right' };

  const hdr = ws.getRow(9);
  hdr.values = ['Số hiệu', 'Ngày, tháng', 'Diễn giải', 'Số tiền'];
  hdr.font = { bold: true }; hdr.fill = HDR_FILL; applyBorders(hdr);
  hdr.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle' }; });

  const sub = ws.getRow(10);
  sub.values = ['A', 'B', 'C', '1'];
  sub.font = { bold: true, italic: true }; applyBorders(sub);
  sub.eachCell(c => { c.alignment = { horizontal: 'center' }; });

  let dr = 11;
  // Revenue section
  const revSec = ws.getRow(dr++);
  revSec.values = ['', '', 'DOANH THU', '']; revSec.font = { bold: true }; applyBorders(revSec);

  let revenueTotal = 0;
  for (const r of outRes.rows) {
    const amt = Number(r.subtotal); revenueTotal += amt;
    const row = ws.getRow(dr++);
    row.values = [r.invoice_number, r.invoice_date, r.buyer_name ?? '', amt];
    row.getCell(4).numFmt = NUM_FMT; applyBorders(row);
  }
  const rTot = ws.getRow(dr++);
  rTot.values = ['', '', 'Tổng doanh thu', revenueTotal];
  rTot.font = { bold: true }; rTot.getCell(4).numFmt = NUM_FMT; applyBorders(rTot);

  dr++;
  // Expense section
  const expSec = ws.getRow(dr++);
  expSec.values = ['', '', 'CHI PHÍ', '']; expSec.font = { bold: true }; applyBorders(expSec);

  let expenseTotal = 0;
  for (const r of inRes.rows) {
    const amt = Number(r.total_amount); expenseTotal += amt;
    const row = ws.getRow(dr++);
    row.values = [r.invoice_number, r.invoice_date, r.seller_name ?? '', amt];
    row.getCell(4).numFmt = NUM_FMT; applyBorders(row);
  }
  const eTot = ws.getRow(dr++);
  eTot.values = ['', '', 'Tổng chi phí', expenseTotal];
  eTot.font = { bold: true }; eTot.getCell(4).numFmt = NUM_FMT; applyBorders(eTot);

  dr++;
  const profit = ws.getRow(dr++);
  profit.values = ['', '', 'Lợi nhuận tạm thời', revenueTotal - expenseTotal];
  profit.font = { bold: true }; profit.getCell(4).numFmt = NUM_FMT; applyBorders(profit);

  ws.getColumn(1).width = 16; ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 46; ws.getColumn(4).width = 18;
  writeSigBlock(ws, dr + 2, 4);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=S2c-HKD_Q${q}_${year}.xlsx`);
  await wb.xlsx.write(res); res.end();
});

// ── S2d ──────────────────────────────────────────────────────────────────────
// SỔ CHI TIẾT VẬT LIỆU, DỤNG CỤ, SẢN PHẨM, HÀNG HÓA

router.get('/s2d', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const rows = await pool.query<{
    invoice_number: string; invoice_date: string; item_name: string | null;
    unit: string | null; unit_price: string | null;
    quantity: string | null; subtotal: string | null;
    direction: string;
  }>(
    `SELECT i.invoice_number, i.invoice_date::text,
            ili.item_name, ili.unit, ili.unit_price,
            ili.quantity, ili.subtotal,
            i.direction
     FROM invoice_line_items ili
     JOIN invoices i ON ili.invoice_id = i.id
     WHERE i.company_id=$1 AND i.status='valid' AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN $2 AND $3
     ORDER BY i.invoice_date, i.invoice_number, ili.line_number`,
    [companyId, start, end],
  );

  res.json({
    success: true,
    data: {
      company: { name: comp.name, tax_code: comp.tax_code, address: comp.address },
      period: { quarter: q, year, start_month: sm, end_month: em },
      rows: rows.rows.map(r => ({
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date,
        description: r.item_name ?? '',
        unit: r.unit ?? '',
        unit_price: Number(r.unit_price ?? 0),
        quantity: Number(r.quantity ?? 0),
        amount: Number(r.subtotal ?? 0),
        direction: r.direction,
      })),
    },
  });
});

router.get('/s2d/excel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const rows = await pool.query<{
    invoice_number: string; invoice_date: string; item_name: string | null;
    unit: string | null; unit_price: string | null;
    quantity: string | null; subtotal: string | null;
    direction: string;
  }>(
    `SELECT i.invoice_number, i.invoice_date::text, ili.item_name, ili.unit,
            ili.unit_price, ili.quantity, ili.subtotal, i.direction
     FROM invoice_line_items ili
     JOIN invoices i ON ili.invoice_id = i.id
     WHERE i.company_id=$1 AND i.status='valid' AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN $2 AND $3
     ORDER BY i.invoice_date, i.invoice_number, ili.line_number`,
    [companyId, start, end],
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S2d-HKD');
  writeCompanyHeader(ws, comp, 'Mẫu số S2d-HKD', '(Kèm theo TT 152/2025/TT-BTC)');

  ws.getRow(5).getCell(1).value = 'SỔ CHI TIẾT VẬT LIỆU, DỤNG CỤ, SẢN PHẨM, HÀNG HÓA';
  ws.getRow(5).getCell(1).font  = { bold: true, size: 12 };
  ws.getRow(5).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A5:H5');
  ws.getRow(6).getCell(1).value = `Kỳ kê khai: Quý ${q}/${year} (T${sm}/${year} – T${em}/${year})`;
  ws.getRow(6).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A6:H6');

  // Double header rows
  const h1 = ws.getRow(8);
  h1.values = ['Số hiệu', 'Ngày, tháng', 'Diễn giải', 'ĐVT', 'Đơn giá', 'SL Nhập', 'TT Nhập', 'SL Xuất', 'TT Xuất', 'Ghi chú'];
  h1.font = { bold: true }; h1.fill = HDR_FILL; applyBorders(h1);
  h1.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });

  const h2 = ws.getRow(9);
  h2.values = ['A', 'B', 'C', 'D', '1', '2', '3', '4', '5', '8'];
  h2.font = { bold: true, italic: true }; applyBorders(h2);
  h2.eachCell(c => { c.alignment = { horizontal: 'center' }; });

  let dr = 10;
  for (const r of rows.rows) {
    const row = ws.getRow(dr++);
    const qty = Number(r.quantity ?? 0);
    const price = Number(r.unit_price ?? 0);
    const amt = Number(r.subtotal ?? 0);
    const isInput = r.direction === 'input';
    row.values = [
      r.invoice_number, r.invoice_date, r.item_name ?? '', r.unit ?? '', price,
      isInput ? qty : 0, isInput ? amt : 0,
      isInput ? 0 : qty, isInput ? 0 : amt,
      '',
    ];
    [5,6,7,8,9].forEach(ci => { row.getCell(ci).numFmt = NUM_FMT; });
    applyBorders(row);
  }

  if (rows.rows.length === 0) {
    const emRow = ws.getRow(dr++);
    emRow.values = ['', '', '(Chưa có dữ liệu chi tiết hàng hóa trong kỳ)', '', '', '', '', '', '', ''];
    emRow.getCell(3).font = { italic: true, color: { argb: 'FF9CA3AF' } };
    applyBorders(emRow);
  }

  [1,2,3,4,5,6,7,8,9,10].forEach((ci, i) => {
    ws.getColumn(ci).width = [14,12,36,8,12,8,14,8,14,12][i]!;
  });
  writeSigBlock(ws, dr + 2, 10);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=S2d-HKD_Q${q}_${year}.xlsx`);
  await wb.xlsx.write(res); res.end();
});

// ── S2e ──────────────────────────────────────────────────────────────────────
// SỔ CHI TIẾT TIỀN

router.get('/s2e', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const rows = await pool.query<{
    invoice_number: string; invoice_date: string;
    buyer_name: string | null; seller_name: string | null;
    total_amount: string; direction: string;
    payment_method: string | null;
  }>(
    `SELECT invoice_number, invoice_date::text,
            buyer_name, seller_name,
            COALESCE(total_amount,0) AS total_amount,
            direction,
            payment_method
     FROM invoices
     WHERE company_id=$1 AND status='valid' AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     ORDER BY invoice_date, direction`,
    [companyId, start, end],
  );

  const cashRows   = rows.rows.filter(r => !r.payment_method || r.payment_method === 'cash');
  const bankRows   = rows.rows.filter(r => r.payment_method && r.payment_method !== 'cash');
  const cashIn     = cashRows.filter(r => r.direction === 'output').reduce((s, r) => s + Number(r.total_amount), 0);
  const cashOut    = cashRows.filter(r => r.direction === 'input').reduce((s, r) => s + Number(r.total_amount), 0);
  const bankIn     = bankRows.filter(r => r.direction === 'output').reduce((s, r) => s + Number(r.total_amount), 0);
  const bankOut    = bankRows.filter(r => r.direction === 'input').reduce((s, r) => s + Number(r.total_amount), 0);

  res.json({
    success: true,
    data: {
      company: { name: comp.name, tax_code: comp.tax_code, address: comp.address },
      period: { quarter: q, year, start_month: sm, end_month: em },
      cash: {
        rows: cashRows.map(r => ({
          invoice_number: r.invoice_number, invoice_date: r.invoice_date,
          description: (r.direction === 'output' ? r.buyer_name : r.seller_name) ?? '',
          cash_in:  r.direction === 'output' ? Number(r.total_amount) : 0,
          cash_out: r.direction === 'input'  ? Number(r.total_amount) : 0,
        })),
        total_in: cashIn, total_out: cashOut,
      },
      bank: {
        rows: bankRows.map(r => ({
          invoice_number: r.invoice_number, invoice_date: r.invoice_date,
          description: (r.direction === 'output' ? r.buyer_name : r.seller_name) ?? '',
          cash_in:  r.direction === 'output' ? Number(r.total_amount) : 0,
          cash_out: r.direction === 'input'  ? Number(r.total_amount) : 0,
        })),
        total_in: bankIn, total_out: bankOut,
      },
    },
  });
});

router.get('/s2e/excel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { start, end, sm, em } = quarterRange(q, year);

  const rows = await pool.query<{
    invoice_number: string; invoice_date: string;
    buyer_name: string | null; seller_name: string | null;
    total_amount: string; direction: string; payment_method: string | null;
  }>(
    `SELECT invoice_number, invoice_date::text, buyer_name, seller_name,
            COALESCE(total_amount,0) AS total_amount, direction, payment_method
     FROM invoices
     WHERE company_id=$1 AND status='valid' AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     ORDER BY invoice_date, direction`,
    [companyId, start, end],
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S2e-HKD');
  writeCompanyHeader(ws, comp, 'Mẫu số S2e-HKD', '(Kèm theo TT 152/2025/TT-BTC)');

  ws.getRow(5).getCell(1).value = 'SỔ CHI TIẾT TIỀN';
  ws.getRow(5).getCell(1).font  = { bold: true, size: 12 };
  ws.getRow(5).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A5:E5');
  ws.getRow(6).getCell(1).value = `Kỳ kê khai: Quý ${q}/${year} (T${sm}/${year} – T${em}/${year})`;
  ws.getRow(6).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A6:E6');
  ws.getRow(7).getCell(5).value = 'Đơn vị tính: VNĐ';
  ws.getRow(7).getCell(5).alignment = { horizontal: 'right' };

  const hdr = ws.getRow(9);
  hdr.values = ['Số hiệu', 'Ngày tháng', 'Diễn giải', 'Thu/Gửi vào', 'Chi/Rút ra'];
  hdr.font = { bold: true }; hdr.fill = HDR_FILL; applyBorders(hdr);
  hdr.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  const sub = ws.getRow(10);
  sub.values = ['A', 'B', 'C', '1', '2'];
  sub.font = { bold: true, italic: true }; applyBorders(sub);
  sub.eachCell(c => { c.alignment = { horizontal: 'center' }; });

  let dr = 11;
  const addSection = (label: string, sectionRows: typeof rows.rows) => {
    const sec = ws.getRow(dr++);
    sec.values = ['', '', label, '', '']; sec.font = { bold: true, italic: true }; applyBorders(sec);
    let tin = 0; let tout = 0;
    for (const r of sectionRows) {
      const amt = Number(r.total_amount);
      const isOut = r.direction === 'output';
      tin  += isOut ? amt : 0;
      tout += isOut ? 0   : amt;
      const row = ws.getRow(dr++);
      const desc = (isOut ? r.buyer_name : r.seller_name) ?? '';
      row.values = [r.invoice_number, r.invoice_date, desc, isOut ? amt : 0, isOut ? 0 : amt];
      row.getCell(4).numFmt = NUM_FMT; row.getCell(5).numFmt = NUM_FMT; applyBorders(row);
    }
    const totRow = ws.getRow(dr++);
    totRow.values = ['', '', 'Tổng cộng', tin, tout]; totRow.font = { bold: true };
    totRow.getCell(4).numFmt = NUM_FMT; totRow.getCell(5).numFmt = NUM_FMT; applyBorders(totRow);
    dr++;
  };

  const cashRows = rows.rows.filter(r => !r.payment_method || r.payment_method === 'cash');
  const bankRows = rows.rows.filter(r => r.payment_method && r.payment_method !== 'cash');
  addSection('Tiền mặt', cashRows);
  addSection('Tiền gửi không kỳ hạn', bankRows);

  ws.getColumn(1).width = 16; ws.getColumn(2).width = 13;
  ws.getColumn(3).width = 42; ws.getColumn(4).width = 18; ws.getColumn(5).width = 18;
  writeSigBlock(ws, dr + 1, 5);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=S2e-HKD_Q${q}_${year}.xlsx`);
  await wb.xlsx.write(res); res.end();
});

// ── S3a ──────────────────────────────────────────────────────────────────────
// SỔ THEO DÕI NGHĨA VỤ THUẾ KHÁC

router.get('/s3a', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { sm, em } = quarterRange(q, year);
  res.json({
    success: true,
    data: {
      company: { name: comp.name, tax_code: comp.tax_code, address: comp.address },
      period: { quarter: q, year, start_month: sm, end_month: em },
      rows: [],
      note: 'Sổ S3a dùng cho các loại thuế khác (xuất nhập khẩu, tiêu thụ đặc biệt, bảo vệ môi trường, tài nguyên, đất). Nhập liệu thủ công.',
    },
  });
});

router.get('/s3a/excel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'), async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { q, year } = parseQY(req.query as Record<string, unknown>);
  const comp = await guardHousehold(companyId);
  const { sm, em } = quarterRange(q, year);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S3a-HKD');
  writeCompanyHeader(ws, comp, 'Mẫu số S3a-HKD', '(Kèm theo TT 152/2025/TT-BTC)');

  ws.getRow(5).getCell(1).value = 'SỔ THEO DÕI NGHĨA VỤ THUẾ KHÁC';
  ws.getRow(5).getCell(1).font  = { bold: true, size: 12 };
  ws.getRow(5).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A5:J5');
  ws.getRow(6).getCell(1).value = `Địa điểm kinh doanh: ${comp.address ?? ''}`;
  ws.getRow(6).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A6:J6');
  ws.getRow(7).getCell(1).value = `Kỳ kê khai: Quý ${q}/${year} (T${sm}/${year} – T${em}/${year})`;
  ws.getRow(7).getCell(1).alignment = { horizontal: 'center' }; ws.mergeCells('A7:J7');
  ws.getRow(8).getCell(10).value = 'Đơn vị tính: VNĐ';
  ws.getRow(8).getCell(10).alignment = { horizontal: 'right' };

  const hdr = ws.getRow(9);
  hdr.values = [
    'Ngày tháng ghi sổ', 'Diễn giải',
    'Lượng HH,DV chịu thuế', 'Mức thuế tuyệt đối',
    'Giá tính thuế/01 đv HH,DV', 'Thuế suất',
    'Áp dụng PP tính thuế tỷ lệ %', 'Áp dụng PP tính thuế tuyệt đối (nếu có)',
    'Số thuế phải nộp', 'Thuế BVMT', 'Thuế tài nguyên', 'Thuế sử dụng đất',
  ];
  hdr.font = { bold: true }; hdr.fill = HDR_FILL; applyBorders(hdr);
  hdr.eachCell(c => { c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  hdr.height = 40;

  const sub = ws.getRow(10);
  sub.values = ['A', 'B', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  sub.font = { bold: true, italic: true }; applyBorders(sub);
  sub.eachCell(c => { c.alignment = { horizontal: 'center' }; });

  // Blank rows for manual entry
  for (let i = 11; i <= 20; i++) {
    const row = ws.getRow(i);
    row.values = Array(12).fill('');
    applyBorders(row);
  }

  const totRow = ws.getRow(21);
  totRow.values = ['Tổng cộng', '', '', '', '', '', '', '', '', '', '', ''];
  totRow.font = { bold: true }; applyBorders(totRow);

  [12,28,14,14,18,10,18,18,16,14,14,14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  writeSigBlock(ws, 23, 12);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=S3a-HKD_Q${q}_${year}.xlsx`);
  await wb.xlsx.write(res); res.end();
});

export default router;
