import ExcelJS from 'exceljs';
import { pool } from '../db/pool';

interface DeclRow {
  id: string;
  company_id: string;
  period_month: number;
  period_year: number;
  period_type: string;
  form_type: string;
  submission_status: string;
  ct22_total_input_vat: number;
  ct23_deductible_input_vat: number;
  ct23_input_subtotal: number;
  ct24_carried_over_vat: number;
  ct25_total_deductible: number;
  ct29_total_revenue: number;
  ct30_exempt_revenue: number;
  ct32_revenue_5pct: number;
  ct33_vat_5pct: number;
  ct34_revenue_8pct: number;
  ct35_vat_8pct: number;
  ct36_revenue_10pct: number;
  ct37_vat_10pct: number;
  ct36_nq_vat_reduction: number;
  ct40_total_output_revenue: number;
  ct40a_total_output_vat: number;
  ct41_payable_vat: number;
  ct43_carry_forward_vat: number;
}

interface InvoiceRow {
  invoice_number: string;
  serial_number: string;
  invoice_date: string;
  direction: string;
  status: string;
  seller_name: string;
  buyer_name: string;
  seller_tax_code: string;
  buyer_tax_code: string;
  subtotal: string | null;
  total_amount: string;
  vat_amount: string;
  vat_rate: number;
  item_code: string | null;
  customer_code: string | null;
  payment_method: string | null;
}

interface CompanyRow {
  name: string;
  tax_code: string;
}

function vnd(n: number | null): string {
  if (n == null) return '0';
  return Number(n).toLocaleString('vi-VN');
}

const PERIOD_MONTH_LABELS: Record<number, string> = {
  1: 'Tháng 1', 2: 'Tháng 2', 3: 'Tháng 3', 4: 'Tháng 4',
  5: 'Tháng 5', 6: 'Tháng 6', 7: 'Tháng 7', 8: 'Tháng 8',
  9: 'Tháng 9', 10: 'Tháng 10', 11: 'Tháng 11', 12: 'Tháng 12',
};
const QUARTER_LABELS: Record<number, string> = {
  1: 'Quý I', 2: 'Quý II', 3: 'Quý III', 4: 'Quý IV',
};

function periodLabel(decl: DeclRow): string {
  if (decl.period_type === 'quarterly') return `${QUARTER_LABELS[decl.period_month] ?? `Q${decl.period_month}`}/${decl.period_year}`;
  return `${PERIOD_MONTH_LABELS[decl.period_month] ?? `Tháng ${decl.period_month}`}/${decl.period_year}`;
}

function quarterMonths(q: number): number[] {
  return [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3];
}

export class TaxDeclarationExporter {
  private async loadData(declId: string, companyId: string) {
    const [declRes, companyRes] = await Promise.all([
      pool.query<DeclRow>('SELECT * FROM tax_declarations WHERE id = $1 AND company_id = $2', [declId, companyId]),
      pool.query<CompanyRow>('SELECT name, tax_code FROM companies WHERE id = $1', [companyId]),
    ]);

    const decl = declRes.rows[0];
    if (!decl) throw new Error('Declaration not found');
    const company = companyRes.rows[0];

    // Determine which months to include
    const months: number[] = decl.period_type === 'quarterly'
      ? quarterMonths(decl.period_month)
      : [decl.period_month];

    const invoiceRes = await pool.query<InvoiceRow>(
      `SELECT invoice_number, serial_number, invoice_date, direction, status,
              seller_name, buyer_name, seller_tax_code, buyer_tax_code,
              subtotal, total_amount, vat_amount, vat_rate,
              item_code, customer_code, payment_method
       FROM invoices
       WHERE company_id = $1
         AND EXTRACT(YEAR FROM invoice_date)::INT = $2
         AND EXTRACT(MONTH FROM invoice_date)::INT = ANY($3)
         AND status != 'cancelled'
       ORDER BY invoice_date ASC, invoice_number ASC`,
      [companyId, decl.period_year, months],
    );

    return { decl, company, invoices: invoiceRes.rows };
  }

  async exportToExcel(declId: string, companyId: string): Promise<Buffer> {
    const { decl, company, invoices } = await this.loadData(declId, companyId);

    const wb = new ExcelJS.Workbook();
    wb.creator  = 'INVONE Platform';
    wb.created  = new Date();
    wb.modified = new Date();

    /* ── Sheet 1: Tổng hợp ── */
    const sh1 = wb.addWorksheet('01GTGT Tong hop', { views: [{ showGridLines: false }] });

    sh1.getColumn(1).width = 12;
    sh1.getColumn(2).width = 48;
    sh1.getColumn(3).width = 22;

    const title = sh1.addRow([`TỜ KHAI THUẾ GTGT (01/GTGT) — ${periodLabel(decl)}`]);
    title.font = { bold: true, size: 13 };
    sh1.mergeCells(sh1.lastRow!.number, 1, sh1.lastRow!.number, 3);
    sh1.addRow([`Công ty: ${company?.name ?? ''} — MST: ${company?.tax_code ?? ''}`]);
    sh1.addRow([]);

    const headerRow = sh1.addRow(['Chỉ tiêu', 'Nội dung', 'Giá trị (VNĐ)']);
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };

    const lines: [string, string, number][] = [
      ['[22]', 'Tổng thuế GTGT đầu vào phát sinh trong kỳ',         Number(decl.ct22_total_input_vat)],
      ['[23]', 'Thuế GTGT đầu vào đủ điều kiện khấu trừ',            Number(decl.ct23_deductible_input_vat)],
      ['[24]', 'Thuế GTGT còn được khấu trừ kỳ trước chuyển sang',  Number(decl.ct24_carried_over_vat)],
      ['[25]', 'Tổng thuế GTGT được khấu trừ ([23]+[24])',           Number(decl.ct25_total_deductible)],
      ['[29]', 'Tổng doanh thu hàng hoá, dịch vụ',                  Number(decl.ct29_total_revenue)],
      ['[30]', 'Doanh thu không chịu thuế',                          Number(decl.ct30_exempt_revenue)],
      ['[32]', 'Doanh thu chịu thuế suất 5%',                       Number(decl.ct32_revenue_5pct)],
      ['[33]', 'Thuế GTGT hàng hoá, dịch vụ 5%',                    Number(decl.ct33_vat_5pct)],
      ['[34]', 'Doanh thu chịu thuế suất 8%',                       Number(decl.ct34_revenue_8pct)],
      ['[35]', 'Thuế GTGT hàng hoá, dịch vụ 8%',                    Number(decl.ct35_vat_8pct)],
      ['[36]', 'Doanh thu chịu thuế suất 10%',                      Number(decl.ct36_revenue_10pct)],
      ['[37]', 'Thuế GTGT hàng hoá, dịch vụ 10%',                   Number(decl.ct37_vat_10pct)],
      ['[40]', 'Tổng doanh thu hàng hoá, dịch vụ bán ra',           Number(decl.ct40_total_output_revenue)],
      ['[40a]','Tổng thuế GTGT đầu ra',                              Number(decl.ct40a_total_output_vat)],
      ['[41]', 'Thuế GTGT còn phải nộp trong kỳ (= [40a] − [25])',  Number(decl.ct41_payable_vat)],
      ['[43]', 'Thuế GTGT khấu trừ kỳ sau (= [25] − [40a])',        Number(decl.ct43_carry_forward_vat)],
    ];

    for (const [ct, label, val] of lines) {
      const r = sh1.addRow([ct, label, val]);
      r.getCell(3).numFmt = '#,##0';
      r.getCell(3).alignment = { horizontal: 'right' };
      if (ct === '[41]') {
        r.getCell(3).font = { color: { argb: val > 0 ? 'FFCC0000' : 'FF000000' }, bold: true };
      }
      if (ct === '[43]') {
        r.getCell(3).font = { color: { argb: val > 0 ? 'FF006600' : 'FF000000' }, bold: true };
      }
    }

    sh1.addRow([]);
    const genRow = sh1.addRow([`Xuất ngày: ${new Date().toLocaleDateString('vi-VN')}`]);
    genRow.font = { italic: true, color: { argb: 'FF888888' } };

    /* ── Sheet helper ── */
    function addInvoiceSheet(
      name: string,
      rows: InvoiceRow[],
      direction: 'output' | 'input',
    ) {
      const sh = wb.addWorksheet(name);
      const partyName  = direction === 'output' ? 'Người mua'  : 'Người bán';
      const partyTax   = direction === 'output' ? 'MST người mua' : 'MST người bán';

      sh.columns = [
        { header: 'STT',            key: 'stt',    width: 6  },
        { header: 'Số HĐ',          key: 'inv_no', width: 16 },
        { header: 'Ký hiệu',        key: 'serial', width: 14 },
        { header: 'Ngày lập',       key: 'date',   width: 13 },
        { header: partyName,        key: 'party',  width: 30 },
        { header: partyTax,         key: 'tax',    width: 16 },
        { header: 'Tiền hàng',      key: 'sub',    width: 16 },
        { header: 'Thuế VAT',       key: 'vat',    width: 14 },
        { header: 'Tổng tiền',      key: 'total',  width: 16 },
        { header: 'TS%',            key: 'rate',   width: 6  },
        { header: 'TT thanh toán',  key: 'pay',    width: 14 },
        { header: 'Mã KH/NCC',      key: 'cust',   width: 14 },
        { header: 'Mã hàng',        key: 'item',   width: 14 },
        { header: 'Trạng thái',     key: 'status', width: 12 },
      ];

      const hdr = sh.getRow(1);
      hdr.font = { bold: true };
      hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };

      let idx = 0;
      for (const inv of rows) {
        if (inv.direction !== direction) continue;
        idx++;
        const party = direction === 'output' ? inv.buyer_name  : inv.seller_name;
        const tax   = direction === 'output' ? inv.buyer_tax_code : inv.seller_tax_code;
        const r = sh.addRow({
          stt:    idx,
          inv_no: inv.invoice_number,
          serial: inv.serial_number,
          date:   inv.invoice_date ? new Date(inv.invoice_date) : '',
          party,
          tax,
          sub:    inv.subtotal    ? Number(inv.subtotal)    : '',
          vat:    Number(inv.vat_amount),
          total:  Number(inv.total_amount),
          rate:   inv.vat_rate,
          pay:    inv.payment_method ?? '',
          cust:   inv.customer_code  ?? '',
          item:   inv.item_code      ?? '',
          status: inv.status,
        });
        for (const c of ['sub', 'vat', 'total']) r.getCell(c).numFmt = '#,##0';
        r.getCell('date').numFmt = 'DD/MM/YYYY';
      }

      if (idx === 0) {
        sh.addRow({ stt: '', inv_no: '(Không có hóa đơn trong kỳ)', serial: '', date: '', party: '', tax: '', sub: '', vat: '', total: '', rate: '', pay: '', cust: '', item: '', status: '' });
      }

      // Totals row
      sh.addRow({});
      const tr = sh.addRow({
        stt:   'Tổng',
        sub:   { formula: `SUM(G2:G${idx + 1})` },
        vat:   { formula: `SUM(H2:H${idx + 1})` },
        total: { formula: `SUM(I2:I${idx + 1})` },
      });
      tr.font = { bold: true };
      for (const c of ['sub', 'vat', 'total']) tr.getCell(c).numFmt = '#,##0';
    }

    addInvoiceSheet('Bán ra', invoices, 'output');
    addInvoiceSheet('Mua vào', invoices, 'input');

    const raw = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
  }

  async exportToPdf(declId: string, companyId: string): Promise<Buffer> {
    const { decl, company, invoices } = await this.loadData(declId, companyId);

    const outputInvoices = invoices.filter(i => i.direction === 'output');
    const inputInvoices  = invoices.filter(i => i.direction === 'input');

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Times New Roman', serif; font-size: 11px; margin: 20px; color: #000; }
  h1   { font-size: 14px; text-align: center; margin-bottom: 4px; }
  h2   { font-size: 12px; margin-top: 16px; border-bottom: 1px solid #000; padding-bottom: 2px; }
  .meta { text-align: center; font-size: 10px; color: #555; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
  th, td { border: 1px solid #aaa; padding: 3px 5px; }
  th { background: #DCE3F5; font-weight: bold; text-align: center; }
  .num { text-align: right; }
  .bold { font-weight: bold; }
  .red { color: #c00; }
  .green { color: #060; }
  .highlight-row td { background: #FFFDE7; }
  @page { size: A4; margin: 15mm 12mm; }
</style>
</head>
<body>
<h1>TỜ KHAI THUẾ GIÁ TRỊ GIA TĂNG — MẪU 01/GTGT</h1>
<div class="meta">
  Công ty: <b>${company?.name ?? ''}</b> &nbsp;|&nbsp; MST: <b>${company?.tax_code ?? ''}</b>
  &nbsp;|&nbsp; Kỳ kê khai: <b>${periodLabel(decl)}</b>
  &nbsp;|&nbsp; Trạng thái: <b>${decl.submission_status.toUpperCase()}</b>
</div>

<h2>I. Các chỉ tiêu tổng hợp</h2>
<table>
  <thead>
    <tr><th width="60">Chỉ tiêu</th><th>Nội dung</th><th width="130">Giá trị (VNĐ)</th></tr>
  </thead>
  <tbody>
    ${[
      ['[22]', 'Tổng thuế GTGT đầu vào phát sinh', decl.ct22_total_input_vat, false],
      ['[23]', 'Thuế GTGT đầu vào đủ điều kiện khấu trừ', decl.ct23_deductible_input_vat, false],
      ['[24]', 'Thuế GTGT kỳ trước chuyển sang', decl.ct24_carried_over_vat, false],
      ['[25]', 'Tổng thuế được khấu trừ ([23]+[24])', decl.ct25_total_deductible, true],
      ['[29]', 'Tổng doanh thu hàng hoá, dịch vụ', decl.ct29_total_revenue, false],
      ['[40]', 'Tổng doanh thu bán ra', decl.ct40_total_output_revenue, false],
      ['[40a]','Tổng thuế GTGT đầu ra', decl.ct40a_total_output_vat, true],
      ['[41]', 'Thuế GTGT còn phải nộp trong kỳ', decl.ct41_payable_vat, true],
      ['[43]', 'Thuế GTGT khấu trừ kỳ sau', decl.ct43_carry_forward_vat, true],
    ].map(([ct, label, val, bold]) => {
      const n = Number(val);
      const cls = ct === '[41]' && n > 0 ? 'red bold' : ct === '[43]' && n > 0 ? 'green bold' : bold ? 'bold' : '';
      return `<tr><td>${ct}</td><td>${label}</td><td class="num ${cls}">${vnd(n)}</td></tr>`;
    }).join('')}
  </tbody>
</table>

<h2>II. Hóa đơn bán ra (${outputInvoices.length} hóa đơn)</h2>
<table>
  <thead>
    <tr><th>#</th><th>Số HĐ</th><th>Ký hiệu</th><th>Ngày lập</th><th>Người mua</th><th>MST NM</th><th class="num">Tiền hàng</th><th class="num">Thuế</th><th class="num">Tổng</th></tr>
  </thead>
  <tbody>
    ${outputInvoices.slice(0, 100).map((inv, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${inv.invoice_number}</td>
      <td>${inv.serial_number}</td>
      <td>${new Date(inv.invoice_date).toLocaleDateString('vi-VN')}</td>
      <td>${inv.buyer_name}</td>
      <td>${inv.buyer_tax_code}</td>
      <td class="num">${vnd(Number(inv.subtotal ?? 0))}</td>
      <td class="num">${vnd(Number(inv.vat_amount))}</td>
      <td class="num">${vnd(Number(inv.total_amount))}</td>
    </tr>`).join('')}
    ${outputInvoices.length > 100 ? `<tr><td colspan="9" style="text-align:center;color:#888">… và ${outputInvoices.length - 100} hóa đơn khác (xem bản Excel đầy đủ)</td></tr>` : ''}
  </tbody>
</table>

<h2>III. Hóa đơn mua vào (${inputInvoices.length} hóa đơn)</h2>
<table>
  <thead>
    <tr><th>#</th><th>Số HĐ</th><th>Ký hiệu</th><th>Ngày lập</th><th>Người bán</th><th>MST NB</th><th class="num">Tiền hàng</th><th class="num">Thuế</th><th class="num">Tổng</th></tr>
  </thead>
  <tbody>
    ${inputInvoices.slice(0, 100).map((inv, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${inv.invoice_number}</td>
      <td>${inv.serial_number}</td>
      <td>${new Date(inv.invoice_date).toLocaleDateString('vi-VN')}</td>
      <td>${inv.seller_name}</td>
      <td>${inv.seller_tax_code}</td>
      <td class="num">${vnd(Number(inv.subtotal ?? 0))}</td>
      <td class="num">${vnd(Number(inv.vat_amount))}</td>
      <td class="num">${vnd(Number(inv.total_amount))}</td>
    </tr>`).join('')}
    ${inputInvoices.length > 100 ? `<tr><td colspan="9" style="text-align:center;color:#888">… và ${inputInvoices.length - 100} hóa đơn khác (xem bản Excel đầy đủ)</td></tr>` : ''}
  </tbody>
</table>

<div style="margin-top:16px;font-size:9px;color:#888;text-align:right">
  Xuất ngày: ${new Date().toLocaleDateString('vi-VN')} — INVONE Platform
</div>
</body>
</html>`;

    const { default: puppeteer } = await import('puppeteer');
    // On Linux VPS: set CHROMIUM_PATH=/usr/bin/chromium-browser (or chromium / google-chrome)
    // to use the system-installed browser instead of puppeteer's bundled one.
    // If CHROMIUM_PATH is not set, puppeteer uses its own bundled Chrome (needs system libs).
    const executablePath = process.env['CHROMIUM_PATH'] || undefined;
    const isLinux = process.platform === 'linux';
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ...(isLinux ? ['--disable-dev-shm-usage', '--no-zygote'] : []),
        '--disable-gpu',
      ],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }
}
