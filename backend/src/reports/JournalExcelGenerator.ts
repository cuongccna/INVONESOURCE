/**
 * JournalExcelGenerator — generates Excel export for detailed invoice journals.
 * Produces 25-column report matching Vietnamese tax report format (BCTHUE).
 * Supports both sales (BÁN RA) and purchase (MUA VÀO) directions.
 */
import ExcelJS from 'exceljs';
import { pool } from '../db/pool';
import type { ResolvedPeriod } from '../utils/period';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const COLUMN_HEADERS = [
  'STT',                                  // 1  A
  'Ký hiệu hóa đơn',                      // 2  B
  'Số hóa đơn',                           // 3  C
  'Ngày, tháng, năm lập hóa đơn',         // 4  D
  'Phương thức thanh toán',               // 5  E
  'Mã khách hàng',                        // 6  F
  'Tên khách hàng',                       // 7  G
  'Tên đơn vị',                           // 8  H
  'Mã số thuế',                           // 9  I
  'CCCD',                                 // 10 J
  'Hộ chiếu',                             // 11 K
  'Địa chỉ',                              // 12 L
  'Mã hàng hóa',                          // 13 M
  'Tên hàng hóa',                         // 14 N
  'ĐVT',                                  // 15 O
  'Số lượng',                             // 16 P
  'Đơn giá',                              // 17 Q
  'Doanh số bán hàng chưa thuế VNĐ',      // 18 R
  'Chiết khấu trước thuế VNĐ',            // 19 S
  'Thuế suất (%)',                         // 20 T
  'Thuế GTGT đầu ra VNĐ',                 // 21 U
  'Tổng cộng VNĐ',                        // 22 V
  'Người lập',                            // 23 W
  'Tên người lập',                        // 24 X
  'Ghi chú',                              // 25 Y
] as const;

const COLUMN_WIDTHS = [
  6, 14, 10, 20, 16, 14, 22, 30, 16, 16, 14, 40,
  14, 35, 10, 10, 16, 22, 20, 14, 18, 18, 16, 28, 40,
] as const;

type HAlign = 'center' | 'left' | 'right';
const COLUMN_ALIGNMENTS: HAlign[] = [
  'center', 'center', 'center', 'center', 'center',   // A B C D E
  'center', 'left',   'left',   'center', 'center',   // F G H I J
  'center', 'left',   'center', 'left',   'center',   // K L M N O
  'right',  'right',  'right',  'right',  'center',   // P Q R S T
  'right',  'right',  'center', 'left',   'left',     // U V W X Y
];

/** Number-format codes for columns that contain amounts (1-based col index) */
const NUMBER_FORMATS: Record<number, string> = {
  17: '#,##0',  // Q  Đơn giá
  18: '#,##0',  // R  Doanh số chưa thuế
  19: '#,##0',  // S  Chiết khấu
  21: '#,##0',  // U  Thuế GTGT
  22: '#,##0',  // V  Tổng cộng
};

/** Columns that must be stored as Text to preserve leading zeros (1-based) */
const TEXT_FORMAT_COLS = new Set([2, 3, 9, 10, 11]);  // B C I J K

const DATA_START_ROW = 9;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function allBorders(): Partial<ExcelJS.Borders> {
  const thin = { style: 'thin' as ExcelJS.BorderStyle };
  return { top: thin, left: thin, bottom: thin, right: thin };
}

function formatVatRate(vatRate: unknown): string {
  if (vatRate === null || vatRate === undefined || vatRate === '') return 'Không chịu thuế';
  const n = Number(vatRate);
  if (isNaN(n)) return 'Không chịu thuế';
  if (n === 0) return '0%';
  return `${n.toFixed(1)}%`;
}

/** Parse a DATE string "YYYY-MM-DD" or a Date object into "dd/MM/yyyy" */
function formatDate(d: unknown): string {
  if (!d) return '';
  if (typeof d === 'string') {
    const bare = d.split('T')[0]!;
    const parts = bare.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return d;
  }
  if (d instanceof Date && !isNaN(d.getTime())) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
  return String(d);
}

function safeStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && isNaN(v)) return '';
  return String(v);
}

function buildPeriodLabel(p: ResolvedPeriod): string {
  if (p.periodType === 'quarterly') return `Quý  ${p.quarter} Năm  ${p.year}`;
  if (p.periodType === 'yearly')    return `Năm  ${p.year}`;
  return `Tháng  ${p.month} Năm  ${p.year}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generator class
// ─────────────────────────────────────────────────────────────────────────────

export class JournalExcelGenerator {
  async generateSalesExport(companyId: string, period: ResolvedPeriod): Promise<Buffer> {
    return this._generate('output', companyId, period);
  }

  async generatePurchaseExport(companyId: string, period: ResolvedPeriod): Promise<Buffer> {
    return this._generate('input', companyId, period);
  }

  private async _generate(
    direction: 'output' | 'input',
    companyId: string,
    period: ResolvedPeriod,
  ): Promise<Buffer> {
    const isSalesQuery = direction === 'output';

    // ── 1. Fetch data ────────────────────────────────────────────────────────
    // JOIN customer_catalog (sales) or supplier_catalog (purchase) to get catalog code.
    // JOIN product_catalog via normalized_name to get item_code when line item has none.
    const catalogJoin = isSalesQuery
      ? `LEFT JOIN customer_catalog cat
           ON cat.company_id = i.company_id AND cat.tax_code = i.buyer_tax_code`
      : `LEFT JOIN supplier_catalog cat
           ON cat.company_id = i.company_id AND cat.tax_code = i.seller_tax_code`;

    const catalogCode = isSalesQuery ? 'cat.customer_code' : 'cat.supplier_code';

    const { rows } = await pool.query(
      `SELECT
         i.id,
         i.invoice_date,
         i.invoice_number,
         i.serial_number,
         i.payment_method,
         COALESCE(i.customer_code, ${catalogCode})  AS catalog_code,
         i.notes,
         i.buyer_name,
         i.buyer_tax_code,
         i.seller_name,
         i.seller_tax_code,
         i.subtotal        AS inv_subtotal,
         i.vat_rate        AS inv_vat_rate,
         i.vat_amount      AS inv_vat_amount,
         i.total_amount    AS inv_total,
         i.buyer_address,
         i.seller_address,
         li.id             AS li_id,
         COALESCE(li.item_code, pc.item_code)        AS item_code,
         li.item_name,
         li.unit,
         li.quantity,
         li.unit_price,
         li.subtotal       AS li_subtotal,
         li.vat_rate       AS li_vat_rate,
         li.vat_amount     AS li_vat_amount,
         li.total          AS li_total,
         c.name            AS company_name,
         c.tax_code        AS company_tax_code,
         c.address         AS company_address
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       ${catalogJoin}
       LEFT JOIN invoice_line_items li
         ON li.invoice_id = i.id AND li.deleted_at IS NULL
       LEFT JOIN product_catalog pc
         ON pc.company_id = i.company_id
        AND pc.normalized_name = LOWER(TRIM(li.item_name))
       WHERE i.company_id   = $1
         AND i.direction    = $2
         AND i.status       = 'valid'
         AND i.deleted_at   IS NULL
         AND i.invoice_date BETWEEN $3 AND $4
       ORDER BY i.invoice_date, i.invoice_number, li.line_number`,
      [companyId, direction, period.start, period.end],
    );

    // ── 2. Company info (same for every row) ─────────────────────────────────
    const companyName    = safeStr(rows[0]?.company_name);
    const companyTaxCode = safeStr(rows[0]?.company_tax_code);
    const companyAddress = safeStr(rows[0]?.company_address);

    const isSales     = direction === 'output';
    const reportTitle = isSales
      ? 'BÁO CÁO DOANH THU BÁN HÀNG CHI TIẾT'
      : 'BÁO CÁO CHI PHÍ ĐẦU VÀO CHI TIẾT';
    const sheetName = isSales ? 'CHI TIẾT BÁN HÀNG' : 'CHI TIẾT ĐẦU VÀO';

    // ── 3. Build workbook ─────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = 'HĐĐT Platform';
    wb.created = new Date();

    const ws = wb.addWorksheet(sheetName, {
      pageSetup: { paperSize: 9, orientation: 'landscape' },
    });

    // Column widths
    COLUMN_WIDTHS.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    // ── Row 1: Tên công ty ────────────────────────────────────────────────────
    {
      const row = ws.addRow([
        'Tên công ty :',
        companyName || '………………………………………',
      ]);
      row.getCell(1).font = { name: 'Arial', size: 10 };
      row.getCell(2).font = { name: 'Arial', size: 10 };
    }

    // ── Row 2: Mã số thuế ─────────────────────────────────────────────────────
    {
      const row = ws.addRow([
        'Mã số thuế :',
        companyTaxCode || '………………………………………………',
      ]);
      row.getCell(1).font = { name: 'Arial', size: 10 };
      row.getCell(2).font = { name: 'Arial', size: 10 };
    }

    // ── Row 3: Địa chỉ ────────────────────────────────────────────────────────
    {
      const row = ws.addRow([
        'Địa chỉ :',
        companyAddress || '…………………………………………………………..',
      ]);
      row.getCell(1).font = { name: 'Arial', size: 10 };
      row.getCell(2).font = { name: 'Arial', size: 10 };
    }

    // ── Row 4: Blank ──────────────────────────────────────────────────────────
    ws.addRow([]);

    // ── Row 5: Report title (merge A→Y) ───────────────────────────────────────
    ws.mergeCells('A5:Y5');
    const titleCell = ws.getCell('A5');
    titleCell.value = reportTitle;
    titleCell.font      = { name: 'Arial', bold: true, size: 12 };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(5).height = 22;

    // ── Row 6: Period label (merge A→Y) ───────────────────────────────────────
    ws.mergeCells('A6:Y6');
    const periodCell = ws.getCell('A6');
    periodCell.value = buildPeriodLabel(period);
    periodCell.font      = { name: 'Arial', bold: true, size: 12 };
    periodCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(6).height = 20;

    // ── Row 7: Blank ──────────────────────────────────────────────────────────
    ws.addRow([]);

    // ── Row 8: Column headers ─────────────────────────────────────────────────
    const headerRow = ws.addRow([...COLUMN_HEADERS]);
    headerRow.height = 30;
    headerRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font      = { name: 'Arial', bold: true, size: 10 };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border    = allBorders();
    });

    // ── Rows 9+: Data ─────────────────────────────────────────────────────────
    let stt = 0;

    for (const r of rows) {
      stt++;

      const hasLineItem  = r.li_id !== null && r.li_id !== undefined;
      const partnerName  = safeStr(isSales ? r.buyer_name  : r.seller_name);
      const partnerTax   = safeStr(isSales ? r.buyer_tax_code : r.seller_tax_code);

      const lineSubtotal  = hasLineItem ? Number(r.li_subtotal)   : Number(r.inv_subtotal);
      const lineVatRate   = hasLineItem ? r.li_vat_rate            : r.inv_vat_rate;
      const lineVatAmount = hasLineItem ? Number(r.li_vat_amount)  : Number(r.inv_vat_amount);
      const lineTotal     = hasLineItem ? Number(r.li_total)       : Number(r.inv_total);

      const rowData = [
        stt,                                               // A  STT
        safeStr(r.serial_number),                          // B  Ký hiệu HĐ
        safeStr(r.invoice_number),                         // C  Số HĐ
        formatDate(r.invoice_date),                        // D  Ngày
        safeStr(r.payment_method),                         // E  Phương thức TT
        safeStr(r.catalog_code),                           // F  Mã KH (từ catalog)
        partnerName,                                       // G  Tên KH
        partnerName,                                       // H  Tên đơn vị (same field)
        partnerTax,                                        // I  MST
        '',                                                // J  CCCD (not stored)
        '',                                                // K  Hộ chiếu (not stored)
        safeStr(isSales ? r.buyer_address : r.seller_address), // L  Địa chỉ
        hasLineItem ? safeStr(r.item_code)  : '',          // M  Mã HH (từ catalog)
        hasLineItem ? safeStr(r.item_name)  : '',          // N  Tên HH
        hasLineItem ? safeStr(r.unit)       : '',          // O  ĐVT
        hasLineItem ? Number(r.quantity)    : '',          // P  Số lượng
        hasLineItem ? Number(r.unit_price)  : '',          // Q  Đơn giá
        lineSubtotal,                                      // R  Doanh số chưa thuế
        0,                                                 // S  Chiết khấu
        formatVatRate(lineVatRate),                        // T  Thuế suất (TEXT)
        lineVatAmount,                                     // U  Thuế GTGT
        lineTotal,                                         // V  Tổng cộng
        '',                                                // W  Người lập
        companyName,                                       // X  Tên người lập
        safeStr(r.notes),                                  // Y  Ghi chú
      ];

      const dataRow = ws.addRow(rowData);
      dataRow.height = 15;

      dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.font      = { name: 'Arial', size: 10 };
        cell.border    = allBorders();
        cell.alignment = { horizontal: COLUMN_ALIGNMENTS[colNum - 1], vertical: 'middle' };

        if (NUMBER_FORMATS[colNum]) {
          cell.numFmt = NUMBER_FORMATS[colNum]!;
        }
        // Force text format for serial, invoice number, tax code, CCCD, passport
        if (TEXT_FORMAT_COLS.has(colNum)) {
          cell.numFmt = '@';
        }
      });
    }

    // ── Total row ─────────────────────────────────────────────────────────────
    const dataEndRow  = DATA_START_ROW + stt - 1;
    const totalRowNum = dataEndRow + 1;

    // Merge A→Q for "Tổng cộng:" label
    ws.mergeCells(`A${totalRowNum}:Q${totalRowNum}`);

    const totalRow = ws.getRow(totalRowNum);
    totalRow.height = 16;

    const labelCell = totalRow.getCell(1);
    labelCell.value     = 'Tổng cộng:';
    labelCell.font      = { name: 'Arial', bold: true, size: 10 };
    labelCell.alignment = { horizontal: 'left', vertical: 'middle' };
    labelCell.border    = allBorders();

    const sumCols: Array<{ col: number; letter: string }> = [
      { col: 18, letter: 'R' },
      { col: 19, letter: 'S' },
      { col: 21, letter: 'U' },
      { col: 22, letter: 'V' },
    ];

    for (const { col, letter } of sumCols) {
      const cell = totalRow.getCell(col);
      cell.value  = stt > 0
        ? { formula: `SUM(${letter}${DATA_START_ROW}:${letter}${dataEndRow})` }
        : 0;
      cell.font      = { name: 'Arial', bold: true, size: 10 };
      cell.numFmt    = '#,##0';
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cell.border    = allBorders();
    }

    const buf = await wb.xlsx.writeBuffer();
    // ExcelJS may return ArrayBuffer | Buffer | Uint8Array depending on environment.
    // Ensure we return a Node.js Buffer for downstream code and typing compatibility.
    const nodeBuffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as any);
    return nodeBuffer;
  }
}
