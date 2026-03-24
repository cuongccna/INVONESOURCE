import ExcelJS from 'exceljs';
import { pool } from '../db/pool';

interface InvoiceRow {
  invoice_number: string;
  serial_number: string;
  invoice_date: Date;
  seller_tax_code: string;
  seller_name: string;
  buyer_tax_code: string;
  buyer_name: string;
  subtotal: string;
  vat_rate: string;
  vat_amount: string;
  total_amount: string;
  status: string;
  provider: string;
}

/**
 * VatDeclarationGenerator — generates Excel workbooks for VAT declaration annexes.
 * PL01-1: Bảng kê bán ra (output invoices)
 * PL01-2: Bảng kê mua vào (input invoices)
 * Vietnamese number format: comma thousands, dot decimal, date DD/MM/YYYY
 */
export class VatDeclarationGenerator {
  async generatePL011(companyId: string, month: number, year: number): Promise<Buffer> {
    const { rows } = await pool.query<InvoiceRow>(
      `SELECT invoice_number, serial_number, invoice_date, seller_tax_code, seller_name,
              buyer_tax_code, buyer_name, subtotal, vat_rate, vat_amount, total_amount, status, provider
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status = 'valid'
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
       ORDER BY invoice_date, invoice_number`,
      [companyId, month, year]
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'HĐĐT Platform';
    wb.created = new Date();

    const ws = wb.addWorksheet('Bảng kê bán ra (01-1)', {
      pageSetup: { paperSize: 9, orientation: 'landscape' },
    });

    // Title
    ws.mergeCells('A1:K1');
    const title = ws.getCell('A1');
    title.value = `BẢNG KÊ HÓA ĐƠN, CHỨNG TỪ HÀNG HÓA, DỊCH VỤ BÁN RA`;
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    title.font = { bold: true, size: 14 };

    ws.mergeCells('A2:K2');
    ws.getCell('A2').value = `Tháng ${String(month).padStart(2,'0')} năm ${year} (Mẫu số: 01-1/GTGT)`;
    ws.getCell('A2').alignment = { horizontal: 'center' };

    ws.addRow([]);  // blank row

    // Headers
    const headerRow = ws.addRow([
      'STT', 'Ký hiệu HĐ', 'Số HĐ', 'Ngày HĐ',
      'Tên người mua', 'MST người mua',
      'Doanh thu chưa có thuế', 'Thuế suất', 'Tiền thuế GTGT',
      'Tổng cộng', 'Trạng thái',
    ]);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    });
    headerRow.height = 30;

    // Data rows
    let stt = 1;
    let totalSubtotal = 0, totalVat = 0, totalAmount = 0;

    for (const inv of rows) {
      const subtotal = parseFloat(inv.subtotal);
      const vat = parseFloat(inv.vat_amount);
      const total = parseFloat(inv.total_amount);
      totalSubtotal += subtotal;
      totalVat += vat;
      totalAmount += total;

      const row = ws.addRow([
        stt++,
        inv.serial_number,
        inv.invoice_number,
        formatDate(inv.invoice_date),
        inv.buyer_name,
        inv.buyer_tax_code,
        subtotal,
        `${inv.vat_rate}%`,
        vat,
        total,
        inv.status === 'valid' ? 'Hợp lệ' : inv.status,
      ]);

      // Format numbers
      [7, 9, 10].forEach((col) => {
        const cell = row.getCell(col);
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
      });

      styleBorderRow(row);
    }

    // Summary row
    const summaryRow = ws.addRow([
      '', '', '', '', 'TỔNG CỘNG', '',
      totalSubtotal, '', totalVat, totalAmount, '',
    ]);
    summaryRow.getCell(5).font = { bold: true };
    [7, 9, 10].forEach((col) => {
      const cell = summaryRow.getCell(col);
      cell.numFmt = '#,##0';
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'right' };
    });
    styleBorderRow(summaryRow);

    // Column widths
    ws.columns = [
      { width: 5 }, { width: 12 }, { width: 15 }, { width: 12 },
      { width: 35 }, { width: 15 }, { width: 18 }, { width: 10 },
      { width: 18 }, { width: 18 }, { width: 12 },
    ];

    ws.getRow(1).height = 25;
    const excelBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(excelBuffer);
  }

  async generatePL012(companyId: string, month: number, year: number): Promise<Buffer> {
    const { rows } = await pool.query<InvoiceRow>(
      `SELECT invoice_number, serial_number, invoice_date, seller_tax_code, seller_name,
              buyer_tax_code, buyer_name, subtotal, vat_rate, vat_amount, total_amount, status, provider
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status = 'valid'
         AND gdt_validated = true
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
       ORDER BY invoice_date, invoice_number`,
      [companyId, month, year]
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = 'HĐĐT Platform';
    wb.created = new Date();

    const ws = wb.addWorksheet('Bảng kê mua vào (01-2)', {
      pageSetup: { paperSize: 9, orientation: 'landscape' },
    });

    ws.mergeCells('A1:K1');
    const title = ws.getCell('A1');
    title.value = `BẢNG KÊ HÓA ĐƠN, CHỨNG TỪ HÀNG HÓA, DỊCH VỤ MUA VÀO`;
    title.alignment = { horizontal: 'center', vertical: 'middle' };
    title.font = { bold: true, size: 14 };

    ws.mergeCells('A2:K2');
    ws.getCell('A2').value = `Tháng ${String(month).padStart(2,'0')} năm ${year} (Mẫu số: 01-2/GTGT)`;
    ws.getCell('A2').alignment = { horizontal: 'center' };

    ws.addRow([]);

    const headerRow = ws.addRow([
      'STT', 'Ký hiệu HĐ', 'Số HĐ', 'Ngày HĐ',
      'Tên người bán', 'MST người bán',
      'Giá mua chưa có thuế', 'Thuế suất', 'Tiền thuế GTGT',
      'Tổng cộng', 'Trạng thái',
    ]);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065F46' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' },
      };
    });
    headerRow.height = 30;

    let stt = 1;
    let totalSubtotal = 0, totalVat = 0, totalAmount = 0;

    for (const inv of rows) {
      const subtotal = parseFloat(inv.subtotal);
      const vat = parseFloat(inv.vat_amount);
      const total = parseFloat(inv.total_amount);
      totalSubtotal += subtotal;
      totalVat += vat;
      totalAmount += total;

      const row = ws.addRow([
        stt++,
        inv.serial_number,
        inv.invoice_number,
        formatDate(inv.invoice_date),
        inv.seller_name,
        inv.seller_tax_code,
        subtotal,
        `${inv.vat_rate}%`,
        vat,
        total,
        inv.status === 'valid' ? 'Hợp lệ' : inv.status,
      ]);

      [7, 9, 10].forEach((col) => {
        const cell = row.getCell(col);
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
      });

      styleBorderRow(row);
    }

    const summaryRow = ws.addRow([
      '', '', '', '', 'TỔNG CỘNG', '',
      totalSubtotal, '', totalVat, totalAmount, '',
    ]);
    summaryRow.getCell(5).font = { bold: true };
    [7, 9, 10].forEach((col) => {
      const cell = summaryRow.getCell(col);
      cell.numFmt = '#,##0';
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'right' };
    });
    styleBorderRow(summaryRow);

    ws.columns = [
      { width: 5 }, { width: 12 }, { width: 15 }, { width: 12 },
      { width: 35 }, { width: 15 }, { width: 18 }, { width: 10 },
      { width: 18 }, { width: 18 }, { width: 12 },
    ];

    ws.getRow(1).height = 25;
    const excelBuffer = await wb.xlsx.writeBuffer();
    return Buffer.from(excelBuffer);
  }
}

function formatDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  const day = date.getDate().toString().padStart(2, '0');
  const mon = (date.getMonth() + 1).toString().padStart(2, '0');
  const yr = date.getFullYear();
  return `${day}/${mon}/${yr}`;
}

function styleBorderRow(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin' }, left: { style: 'thin' },
      bottom: { style: 'thin' }, right: { style: 'thin' },
    };
  });
}
