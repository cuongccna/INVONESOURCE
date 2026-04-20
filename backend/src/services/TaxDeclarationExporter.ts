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
  ct26_kct_revenue: number | null;
  ct29_0pct_revenue: number | null;
  ct32a_kkknt_revenue: number | null;
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
  ct37_adjustment_decrease: number | null;
  ct38_adjustment_increase: number | null;
  ct40b_investment_vat: number | null;
  ct21_no_activity: boolean | null;
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
  non_deductible: boolean | null;
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
              item_code, customer_code, payment_method, non_deductible
       FROM invoices
       WHERE company_id = $1
         AND EXTRACT(YEAR FROM invoice_date)::INT = $2
         AND EXTRACT(MONTH FROM invoice_date)::INT = ANY($3)
         AND status NOT IN ('cancelled', 'replaced', 'adjusted')
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

    /* ═══════════════════════════════════════════════════════════════
       Sheet 1: VAT declaration — Official 01/GTGT form layout
    ═══════════════════════════════════════════════════════════════ */
    const sh = wb.addWorksheet('VAT declaration', { views: [{ showGridLines: false }] });

    // Column widths: A=No., B=Chỉ tiêu, C=Giá trị HHDV, D=Thuế GTGT
    sh.getColumn(1).width = 10;
    sh.getColumn(2).width = 62;
    sh.getColumn(3).width = 24;
    sh.getColumn(4).width = 22;

    const THIN = { style: 'thin' as const };
    const BORDER_ALL = { top: THIN, bottom: THIN, left: THIN, right: THIN };
    const NUM_FMT = '#,##0';

    // Helper: add a full-width merged row (columns 1-4)
    function mergedRow(text: string, opts: {
      bold?: boolean; size?: number; italic?: boolean;
      align?: ExcelJS.Alignment['horizontal']; color?: string; height?: number;
      fill?: string;
    } = {}) {
      const r = sh.addRow([text, '', '', '']);
      sh.mergeCells(r.number, 1, r.number, 4);
      r.getCell(1).value = text;
      r.getCell(1).font = {
        bold: opts.bold,
        size: opts.size ?? 11,
        italic: opts.italic,
        color: opts.color ? { argb: opts.color } : undefined,
      };
      r.getCell(1).alignment = {
        horizontal: opts.align ?? 'left',
        vertical: 'middle',
        wrapText: true,
      };
      if (opts.fill) {
        r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
      }
      if (opts.height) r.height = opts.height;
      return r;
    }

    // Helper: table data row
    function tableRow(
      no: string,
      label: string,
      revenueVal?: number | null,
      vatVal?: number | null,
      opts: { bold?: boolean; sectionFill?: boolean; mergeValue?: boolean } = {},
    ) {
      const r = sh.addRow([no, label, '', '']);
      r.getCell(1).value = no;
      r.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      r.getCell(2).value = label;
      r.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };

      if (opts.mergeValue) {
        sh.mergeCells(r.number, 3, r.number, 4);
        r.getCell(3).value = revenueVal ?? '';
        if (typeof revenueVal === 'number') {
          r.getCell(3).numFmt = NUM_FMT;
          r.getCell(3).alignment = { horizontal: 'right', vertical: 'middle' };
        } else {
          r.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
        }
      } else {
        if (revenueVal !== null && revenueVal !== undefined) {
          r.getCell(3).value = revenueVal;
          r.getCell(3).numFmt = NUM_FMT;
          r.getCell(3).alignment = { horizontal: 'right', vertical: 'middle' };
        }
        if (vatVal !== null && vatVal !== undefined) {
          r.getCell(4).value = vatVal;
          r.getCell(4).numFmt = NUM_FMT;
          r.getCell(4).alignment = { horizontal: 'right', vertical: 'middle' };
        }
      }

      if (opts.bold || opts.sectionFill) r.font = { bold: true };
      if (opts.sectionFill) {
        for (let c = 1; c <= 4; c++) {
          r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE3F5' } };
        }
      }
      r.eachCell({ includeEmpty: true }, (_cell, colNum) => {
        if (colNum <= 4) _cell.border = BORDER_ALL;
      });
      return r;
    }

    // Helper: section-header row (spans B-D, colored)
    function sectionRow(no: string, label: string) {
      const r = sh.addRow([no, label, '', '']);
      sh.mergeCells(r.number, 2, r.number, 4);
      r.getCell(1).value = no;
      r.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      r.getCell(2).value = label;
      r.getCell(2).font = { bold: true };
      r.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      for (let c = 1; c <= 4; c++) {
        r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
        r.getCell(c).border = BORDER_ALL;
      }
      r.font = { bold: true };
      return r;
    }

    /* ── HEADER ── */
    mergedRow('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { bold: true, align: 'center' });
    mergedRow('Độc lập - Tự do - Hạnh phúc', { align: 'center' });
    sh.addRow([]);
    mergedRow('TỜ KHAI THUẾ GIÁ TRỊ GIA TĂNG (MẪU SỐ 01/GTGT)', {
      bold: true, size: 13, align: 'center', height: 22,
    });
    mergedRow('(Ban hành kèm theo Thông tư số 26/2015/TT-BTC ngày 27/02/2015 của Bộ Tài chính)', {
      italic: true, align: 'center',
    });
    sh.addRow([]);

    // Period + declaration type
    const periodStr = periodLabel(decl);
    const r01 = sh.addRow([`[01] Kỳ tính thuế: ${periodStr}`, '', '[02] Lần đầu    X', '[03] Bổ sung lần thứ:  [   ]']);
    r01.getCell(1).font = { bold: true };
    sh.mergeCells(r01.number, 1, r01.number, 2);
    r01.getCell(3).alignment = { horizontal: 'center' };
    r01.getCell(4).alignment = { horizontal: 'center' };
    sh.addRow([]);

    // Company info
    const r04 = sh.addRow([`[04] Tên người nộp thuế:  ${company?.name ?? ''}`, '', '', '']);
    sh.mergeCells(r04.number, 1, r04.number, 4);
    const r05 = sh.addRow([`[05] Mã số thuế:  ${company?.tax_code ?? ''}`, '', '', '']);
    sh.mergeCells(r05.number, 1, r05.number, 4);
    const r06 = sh.addRow(['[06] Địa chỉ: ', '', '', '']);
    sh.mergeCells(r06.number, 1, r06.number, 4);
    const r07 = sh.addRow(['[07] Quận/Huyện:', '', '[08] Tỉnh/Thành phố:', '']);
    sh.mergeCells(r07.number, 1, r07.number, 2);
    sh.mergeCells(r07.number, 3, r07.number, 4);
    const r09 = sh.addRow(['[09] Tel:', '[10] Fax:', '[11] Email:', '']);
    sh.mergeCells(r09.number, 3, r09.number, 4);
    sh.addRow([]);

    // Unit label
    const unitRow = sh.addRow(['', '', '', 'Đơn vị: VNĐ']);
    unitRow.getCell(4).alignment = { horizontal: 'right' };
    unitRow.getCell(4).font = { italic: true };

    // Table header
    const hdrRow = sh.addRow(['No.', 'Chỉ tiêu', 'Giá trị HHDV\n(chưa có thuế GTGT)', 'Thuế GTGT']);
    hdrRow.height = 32;
    hdrRow.font = { bold: true };
    hdrRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    hdrRow.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col > 4) return;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = BORDER_ALL;
    });

    /* ── COMPUTED VALUES ── */
    const form22 = Number(decl.ct24_carried_over_vat);           // B [22]
    const form23 = Number(decl.ct23_input_subtotal);             // I.1 [23] (revenue)
    const form24 = Number(decl.ct23_deductible_input_vat);       // I.1 [24] (VAT)
    const form25 = Number(decl.ct25_total_deductible);           // I.2 [25]
    const form26 = Number(decl.ct26_kct_revenue ?? decl.ct30_exempt_revenue); // II.1 [26]
    const form29 = Number(decl.ct29_0pct_revenue ?? 0);           // II.2.a [29]
    const form30 = Number(decl.ct32_revenue_5pct);               // II.2.b [30]
    const form31 = Number(decl.ct33_vat_5pct);                   // II.2.b [31]
    const form32 = Number(decl.ct36_revenue_10pct) + Number(decl.ct34_revenue_8pct); // II.2.c [32]
    const form33 = Number(decl.ct37_vat_10pct)    + Number(decl.ct35_vat_8pct);     // II.2.c [33]
    const form27 = form29 + form30 + form32 + Number(decl.ct32a_kkknt_revenue ?? 0); // II.2 [27]
    const form28 = form31 + form33;                               // II.2 [28]
    const form34 = Number(decl.ct40_total_output_revenue);        // II.3 [34]
    const nqRed  = Number(decl.ct36_nq_vat_reduction ?? 0);
    const form35 = Number(decl.ct40a_total_output_vat);          // II.3 [35] (gross)
    const form35net = form35 - nqRed;                            // net after NQ reduction
    const form36 = form35net - form25;                           // III [36]
    const adj37  = Number(decl.ct37_adjustment_decrease ?? 0);   // IV.a [37]
    const adj38  = Number(decl.ct38_adjustment_increase ?? 0);   // IV.b [38]
    const form40a = Number(decl.ct41_payable_vat);               // VI.1 [40a] (already computed)
    const form40b = Number(decl.ct40b_investment_vat ?? 0);      // VI.2 [40b]
    const form40  = Math.max(0, form40a - form40b);              // VI.3 [40]
    const form41  = form40a === 0 ? Number(decl.ct43_carry_forward_vat) : 0; // VI.4 [41]
    const form43  = Number(decl.ct43_carry_forward_vat);         // VI.4.2 [43]

    /* ── ROW A: No activity ── */
    const rA = sh.addRow([
      'A',
      'Không phát sinh hoạt động mua, bán trong kỳ (đánh dấu "X")',
      decl.ct21_no_activity ? 'X' : '',
      '',
    ]);
    sh.mergeCells(rA.number, 3, rA.number, 4);
    rA.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    rA.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    rA.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
    rA.eachCell({ includeEmpty: true }, (cell, col) => {
      if (col <= 4) cell.border = BORDER_ALL;
    });

    /* ── ROW B: Carry-forward [22] ── */
    tableRow('B', 'Thuế GTGT còn được khấu trừ kỳ trước chuyển sang',
      null, form22 || null);

    /* ── ROW C: Main section ── */
    sectionRow('C', 'Kê khai thuế GTGT phải nộp Ngân sách nhà nước');

    /* ── SUB-SECTION I: Input ── */
    sectionRow('I', 'Hàng hóa, dịch vụ (HHDV) mua vào trong kỳ');
    tableRow('1', 'Hàng hóa, dịch vụ (HHDV) mua vào trong kỳ',
      form23 || null, form24 || null);
    tableRow('2', 'Tổng số thuế GTGT được khấu trừ kỳ này',
      null, form25 || null, { bold: true });

    /* ── SUB-SECTION II: Output ── */
    sectionRow('II', 'Hàng hóa, dịch vụ bán ra trong kỳ');
    tableRow('1', 'Hàng hóa, dịch vụ bán ra không chịu thuế GTGT',
      form26 || null, null);
    tableRow('2',
      'Hàng hóa, dịch vụ bán ra chịu thuế GTGT ([27]=[29]+[30]+[32]+[32a]; [28]=[31]+[33])',
      form27 || null, form28 || null, { bold: true });
    tableRow('a', 'Hàng hóa, dịch vụ bán ra chịu thuế suất 0%',
      form29 || null, null);
    tableRow('b', 'Hàng hóa, dịch vụ bán ra chịu thuế suất 5%',
      form30 || null, form31 || null);
    tableRow('c', 'Hàng hóa, dịch vụ bán ra chịu thuế suất 10% (bao gồm 8% theo NQ)',
      form32 || null, form33 || null);
    tableRow('3',
      'Tổng doanh thu và thuế GTGT của HHDV bán ra ([34]=[26]+[27]; [35]=[28])',
      form34 || null,
      nqRed > 0 ? form35net : (form35 || null),
      { bold: true });

    /* ── ROW III: Net VAT position [36] ── */
    const r36 = tableRow('III',
      `Thuế GTGT phát sinh trong kỳ ([36]=[35]-[25])`,
      null, form36 !== 0 ? form36 : null, { bold: true });
    if (form36 < 0) r36.getCell(4).font = { bold: true, color: { argb: 'FF006600' } };
    else if (form36 > 0) r36.getCell(4).font = { bold: true, color: { argb: 'FFCC0000' } };

    /* ── ROW IV: Adjustments ── */
    sectionRow('IV', 'Điều chỉnh tăng, giảm thuế GTGT còn được khấu trừ của các kỳ trước');
    tableRow('a', 'Điều chỉnh giảm', null, adj37 || null);
    tableRow('b', 'Điều chỉnh tăng', null, adj38 || null);

    /* ── ROW V: Other province ── */
    tableRow('V',
      'Thuế GTGT ở địa phương khác từ hoạt động kinh doanh xây dựng, lắp đặt, bán hàng, bất động sản ngoại tỉnh',
      null, null);

    /* ── ROW VI: Obligations ── */
    sectionRow('VI', 'Xác định nghĩa vụ thuế GTGT phải nộp trong kỳ:');
    tableRow('1',
      'Thuế GTGT phải nộp từ hoạt động sản xuất kinh doanh trong kỳ [40a]=[36]-[22]+[37]-[38]-[39]≥0',
      null, form40a || null, { bold: form40a > 0 });
    if (form40a > 0) {
      const last = sh.lastRow!;
      last.getCell(4).font = { bold: true, color: { argb: 'FFCC0000' } };
    }
    tableRow('2',
      'Thuế GTGT mua vào của dự án đầu tư được bù trừ với thuế GTGT phải nộp của hoạt động sản xuất kinh doanh cùng kỳ',
      null, form40b || null);

    const r40 = tableRow('3',
      'Thuế GTGT còn phải nộp trong kỳ ([40]=[40a]-[40b])',
      null, form40 || null, { bold: true });
    if (form40 > 0) r40.getCell(4).font = { bold: true, color: { argb: 'FFCC0000' } };

    tableRow('4',
      'Thuế GTGT chưa khấu trừ hết kỳ này (nếu [41]=[36]-[22]+[37]-[38]-[39] < 0)',
      null, form41 || null);
    tableRow('4.1', 'Tổng số thuế GTGT đề nghị hoàn', null, null);

    const r43 = tableRow('4.2',
      'Thuế GTGT còn được khấu trừ chuyển kỳ sau ([43]=[41]-[42])',
      null, form43 || null, { bold: true });
    if (form43 > 0) r43.getCell(4).font = { bold: true, color: { argb: 'FF006600' } };

    /* ── SIGNATURE ── */
    sh.addRow([]);
    const sigRow = sh.addRow([
      '',
      'Tôi cam đoan số liệu khai trên là đúng và chịu trách nhiệm trước pháp luật về những số liệu đã khai / ……………………………………',
      '', '',
    ]);
    sh.mergeCells(sigRow.number, 2, sigRow.number, 4);
    sigRow.getCell(2).font = { italic: true };
    sigRow.getCell(2).alignment = { wrapText: true };

    sh.addRow([]);
    const cityRow = sh.addRow(['', '', 'HCMC,', new Date().toLocaleDateString('vi-VN')]);
    cityRow.getCell(3).alignment = { horizontal: 'right' };
    cityRow.getCell(4).alignment = { horizontal: 'center' };
    sh.addRow(['', '', '', 'Authorized representative of enterprise']);
    sh.addRow(['', '', '', 'Signed and sealed']);

    /* ═══════════════════════════════════════════════════════════════
       Invoice sheet helper
    ═══════════════════════════════════════════════════════════════ */
    function addInvoiceSheet(
      name: string,
      rows: InvoiceRow[],
      direction: 'output' | 'input',
    ) {
      const shInv = wb.addWorksheet(name);
      const partyName = direction === 'output' ? 'Người mua'     : 'Người bán';
      const partyTax  = direction === 'output' ? 'MST người mua' : 'MST người bán';

      const cols: Partial<ExcelJS.Column>[] = [
        { header: 'STT',           key: 'stt',    width: 6  },
        { header: 'Số HĐ',         key: 'inv_no', width: 16 },
        { header: 'Ký hiệu',       key: 'serial', width: 14 },
        { header: 'Ngày lập',      key: 'date',   width: 13 },
        { header: partyName,       key: 'party',  width: 30 },
        { header: partyTax,        key: 'tax',    width: 16 },
        { header: 'Tiền hàng',     key: 'sub',    width: 16 },
        { header: 'Thuế VAT',      key: 'vat',    width: 14 },
        { header: 'Tổng tiền',     key: 'total',  width: 16 },
        { header: 'TS%',           key: 'rate',   width: 6  },
        { header: 'TT thanh toán', key: 'pay',    width: 14 },
        { header: 'Mã KH/NCC',    key: 'cust',   width: 14 },
        { header: 'Mã hàng',      key: 'item',   width: 14 },
        { header: 'Trạng thái',   key: 'status', width: 12 },
      ];
      if (direction === 'input') {
        cols.push({ header: 'Đủ ĐK khấu trừ', key: 'deductible', width: 14 });
      }
      shInv.columns = cols;

      const hdr = shInv.getRow(1);
      hdr.font = { bold: true };
      hdr.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: direction === 'output' ? 'FFE3F2FD' : 'FFE8F5E9' },
      };
      hdr.eachCell(cell => { cell.border = BORDER_ALL; });

      let idx = 0;
      for (const inv of rows) {
        if (inv.direction !== direction) continue;
        idx++;
        const party = direction === 'output' ? inv.buyer_name     : inv.seller_name;
        const tax   = direction === 'output' ? inv.buyer_tax_code : inv.seller_tax_code;
        const rowData: Record<string, unknown> = {
          stt:    idx,
          inv_no: inv.invoice_number,
          serial: inv.serial_number,
          date:   inv.invoice_date ? new Date(inv.invoice_date) : '',
          party,
          tax,
          sub:    inv.subtotal ? Number(inv.subtotal) : '',
          vat:    Number(inv.vat_amount),
          total:  Number(inv.total_amount),
          rate:   inv.vat_rate,
          pay:    inv.payment_method ?? '',
          cust:   inv.customer_code  ?? '',
          item:   inv.item_code      ?? '',
          status: inv.status,
        };
        if (direction === 'input') {
          rowData['deductible'] = inv.non_deductible ? 'Không' : 'Có';
        }
        const r = shInv.addRow(rowData);
        for (const c of ['sub', 'vat', 'total']) r.getCell(c).numFmt = NUM_FMT;
        r.getCell('date').numFmt = 'DD/MM/YYYY';
        if (direction === 'input' && inv.non_deductible) {
          r.getCell('deductible').font = { color: { argb: 'FFCC0000' } };
        }
      }

      if (idx === 0) {
        shInv.addRow({
          stt: '', inv_no: '(Không có hóa đơn trong kỳ)',
          serial: '', date: '', party: '', tax: '', sub: '', vat: '',
          total: '', rate: '', pay: '', cust: '', item: '', status: '',
        });
      }

      // Totals row
      shInv.addRow({});
      const tr = shInv.addRow({
        stt:   'Tổng',
        sub:   { formula: `SUM(G2:G${idx + 1})` },
        vat:   { formula: `SUM(H2:H${idx + 1})` },
        total: { formula: `SUM(I2:I${idx + 1})` },
      });
      tr.font = { bold: true };
      for (const c of ['sub', 'vat', 'total']) tr.getCell(c).numFmt = NUM_FMT;
    }

    // Sheet 2: output invoices; Sheet 3: input invoices
    addInvoiceSheet('01 GTGT bán ra', invoices, 'output');
    addInvoiceSheet('02 GTGT đầu vào', invoices, 'input');

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
