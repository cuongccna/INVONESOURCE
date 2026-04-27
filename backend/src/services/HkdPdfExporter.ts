import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { INDUSTRY_GROUP_RATES } from './HkdDeclarationEngine';

// Font bundled inside backend/assets/fonts/ — works from dist/src/services/ at runtime
const FONTS_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');

function resolveFont(filename: string): string {
  const bundled = path.join(FONTS_DIR, filename);
  if (fs.existsSync(bundled)) return bundled;
  // Windows dev fallback
  const winPath = path.join('C:', 'Windows', 'Fonts', filename);
  if (fs.existsSync(winPath)) return winPath;
  throw new Error(`Font ${filename} not found. Add it to backend/assets/fonts/`);
}

export interface HkdPdfDeclaration {
  company_name: string;
  tax_code: string | null;
  address: string | null;
  period_quarter: number;
  period_year: number;
  industry_group?: number | null;
  revenue_m1: number | string;
  revenue_m2: number | string;
  revenue_m3: number | string;
  revenue_total: number | string;
  vat_rate: number | string;
  vat_m1: number | string;
  vat_m2: number | string;
  vat_m3: number | string;
  vat_total: number | string;
  pit_rate?: number | string | null;
  pit_m1: number | string;
  pit_m2: number | string;
  pit_m3: number | string;
  pit_total: number | string;
  total_payable: number | string;
  submission_status?: string | null;
}

function n(v: number | string | null | undefined): number {
  return Number(v ?? 0);
}

function fmt(v: number | string | null | undefined): string {
  return n(v).toLocaleString('vi-VN');
}

function statusLabel(s?: string | null): string {
  if (s === 'ready') return 'Hoàn thiện';
  if (s === 'submitted') return 'Đã nộp';
  if (s === 'accepted') return 'GDT tiếp nhận';
  if (s === 'rejected') return 'Từ chối';
  return 'Nháp';
}

export class HkdPdfExporter {
  async generate(declaration: HkdPdfDeclaration): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // --- Fonts (NotoSans has full Vietnamese Unicode support) ---
      const fontReg = resolveFont('NotoSans-Regular.ttf');
      const fontBold = resolveFont('NotoSans-Bold.ttf');

      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 60, bottom: 40, left: 42, right: 36 },
        info: { Title: 'Tờ khai thuế HKD/CNKD (TT40/2021)', Author: 'INVONE' },
      });

      doc.registerFont('Reg', fontReg);
      doc.registerFont('Bold', fontBold);

      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const ML = doc.page.margins.left;        // 42
      const MR = doc.page.margins.right;       // 36
      const PW = doc.page.width;               // 595.28
      const UW = PW - ML - MR;                 // usable width ~517

      const q  = declaration.period_quarter;
      const yr = declaration.period_year;
      const sm = (q - 1) * 3 + 1;
      const em = sm + 2;
      const months = [sm, sm + 1, sm + 2];

      const ig       = Number(declaration.industry_group ?? 28);
      const industry = INDUSTRY_GROUP_RATES[ig] ?? INDUSTRY_GROUP_RATES[28]!;
      const vatPct   = n(declaration.vat_rate);
      const pitPct   = n(declaration.pit_rate ?? 0);

      const today      = new Date();
      const exportDate = today.toLocaleDateString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit', month: '2-digit', year: 'numeric',
      });

      // ── Helpers ────────────────────────────────────────────────────────────

      const hLine = (y: number, lw = 0.5, color = '#9CA3AF') => {
        doc.save().strokeColor(color).lineWidth(lw)
          .moveTo(ML, y).lineTo(PW - MR, y).stroke().restore();
      };

      // Draw a labelled field (label: value) — two-tone, same line
      const fld = (label: string, value: string, x: number, y: number, w: number) => {
        const lbl = `${label}: `;
        doc.font('Reg').fontSize(8.5).fillColor('#6B7280').text(lbl, x, y, { continued: true, width: w });
        doc.font('Bold').fontSize(8.5).fillColor('#111827').text(value || '—');
      };

      // Draw a checkbox with label
      const checkbox = (checked: boolean, label: string, x: number, y: number) => {
        const bx = 9;
        doc.save().rect(x, y + 1, bx, bx).fillAndStroke('#FFFFFF', '#9CA3AF').restore();
        if (checked) {
          doc.font('Bold').fontSize(8).fillColor('#1D4ED8').text('x', x + 1, y + 1);
        }
        doc.font('Reg').fontSize(8.5).fillColor('#374151').text(label, x + bx + 5, y, { width: 220 });
      };

      // Draw table cell with border
      const cell = (
        x: number, y: number, w: number, h: number, text: string,
        opts: { bold?: boolean; align?: 'left'|'center'|'right'; bg?: string; fg?: string } = {},
      ) => {
        doc.save()
          .rect(x, y, w, h)
          .fillAndStroke(opts.bg ?? '#FFFFFF', '#D1D5DB')
          .restore();
        doc.font(opts.bold ? 'Bold' : 'Reg')
          .fontSize(8.5)
          .fillColor(opts.fg ?? '#111827')
          .text(text, x + 4, y + (h - 10) / 2 + 1, { width: w - 8, align: opts.align ?? 'left', lineBreak: false });
      };

      // ── PAGE HEADER ────────────────────────────────────────────────────────

      let cy = doc.page.margins.top; // 36

      // Top-right authority block — 2 lines × 11px = 22px, give 30px clearance
      doc.font('Reg').fontSize(7.5).fillColor('#9CA3AF')
        .text('Bộ Tài Chính – Tổng cục Thuế', ML, cy, { align: 'right', width: UW });
      doc.font('Reg').fontSize(7.5).fillColor('#9CA3AF')
        .text('Mẫu 01/CNKD (Ban hành kèm theo TT40/2021/TT-BTC)', ML, cy + 11, { align: 'right', width: UW });

      cy += 30; // clear the 2-line authority block before drawing the title

      // Title — starts well below the authority block
      doc.font('Bold').fontSize(15).fillColor('#111827')
        .text('TỜ KHAI THUẾ ĐỐI VỚI CÁ NHÂN KINH DOANH', ML, cy, { align: 'center', width: UW });
      cy += 22;
      doc.font('Reg').fontSize(9.5).fillColor('#374151')
        .text('(Dành cho HKD, CNKD nộp thuế theo phương pháp kê khai – TT40/2021)', ML, cy, { align: 'center', width: UW });
      cy += 16;

      // Period badge
      const badgeText = `Kỳ tính thuế: Quý ${q} năm ${yr}  (T${sm}/${yr} – T${em}/${yr})`;
      const bW = 340; const bH = 22; const bX = ML + (UW - bW) / 2;
      doc.save().roundedRect(bX, cy, bW, bH, 4).fillAndStroke('#EFF6FF', '#BFDBFE').restore();
      doc.font('Bold').fontSize(10).fillColor('#1D4ED8')
        .text(badgeText, bX, cy + 5, { width: bW, align: 'center' });
      cy += bH + 10;
      hLine(cy, 1.5, '#1D4ED8');
      cy += 10;

      // ── DECLARATION TYPE ──────────────────────────────────────────────────

      doc.font('Bold').fontSize(8.5).fillColor('#374151').text('Loại tờ khai:', ML, cy);
      cy += 14;
      const col2X = ML + UW / 2;
      checkbox(false, 'HKD, CNKD nộp thuế theo phương pháp khoán',       ML,    cy);
      checkbox(false, 'CNKD nộp thuế theo từng lần phát sinh',             col2X, cy);
      cy += 14;
      checkbox(true,  'HKD, CNKD nộp thuế theo phương pháp kê khai',      ML,    cy);
      checkbox(false, 'Tổ chức, cá nhân khai thuế thay, nộp thuế thay',   col2X, cy);
      cy += 16;

      // [01] [02] [03]
      doc.font('Reg').fontSize(8.5).fillColor('#374151')
        .text(`[01] Kỳ tính thuế:  [01c] Quý ${q} năm ${yr}  (từ tháng ${String(sm).padStart(2,'0')}/${yr} đến tháng ${String(em).padStart(2,'0')}/${yr})`, ML, cy);
      cy += 13;
      doc.font('Reg').fontSize(8.5).fillColor('#374151')
        .text('[02] Lần đầu: ', ML, cy, { continued: true });
      doc.font('Bold').fillColor('#111827').text('[X]', { continued: true });
      doc.font('Reg').fillColor('#374151').text('          [03] Bổ sung lần thứ: [  ]');
      cy += 13;

      hLine(cy, 0.5, '#E5E7EB');
      cy += 8;

      // ── TAXPAYER INFO ─────────────────────────────────────────────────────

      doc.font('Bold').fontSize(9).fillColor('#1F2937').text('THÔNG TIN NGƯỜI NỘP THUẾ', ML, cy);
      cy += 14;

      const lW = UW * 0.58;
      const rX = ML + lW + 12;
      const rW = UW - lW - 12;

      fld('[04] Tên người nộp thuế',       declaration.company_name ?? '',       ML, cy, lW);
      fld('[07] Mã số thuế',               declaration.tax_code ?? 'Chưa cập nhật', rX, cy, rW);
      cy += 14;

      fld('[05] Tên cửa hàng/thương hiệu', declaration.company_name ?? '',       ML, cy, lW);
      fld('[08a] Trạng thái',              statusLabel(declaration.submission_status), rX, cy, rW);
      cy += 14;

      fld('[09] Ngành nghề kinh doanh',
        `Nhóm ${ig} – ${industry.label}   (GTGT ${vatPct}% | TNCN ${pitPct}%)`,
        ML, cy, UW);
      cy += 14;

      fld('[12] Địa chỉ kinh doanh',  declaration.address ?? 'Chưa cập nhật', ML, cy, UW);
      cy += 16;

      hLine(cy, 1, '#374151');
      cy += 10;

      // ── SECTION A ─────────────────────────────────────────────────────────

      doc.font('Bold').fontSize(10).fillColor('#111827')
        .text('A. KÊ KHAI THUẾ GIÁ TRỊ GIA TĂNG, THUẾ THU NHẬP CÁ NHÂN (TNCN)', ML, cy);
      cy += 17;

      // Table columns: STT | Chỉ tiêu | T1 | T2 | T3 | Tổng quý
      const sttW   = 26;
      const lblW   = 188;
      const remW   = UW - sttW - lblW;
      const mW     = remW / 4;          // each of 3 months + 1 total column
      const cX: number[] = [
        ML,
        ML + sttW,
        ML + sttW + lblW,
        ML + sttW + lblW + mW,
        ML + sttW + lblW + mW * 2,
        ML + sttW + lblW + mW * 3,
      ];
      const cW = [sttW, lblW, mW, mW, mW, mW];
      const rH = 26;

      // Header
      cell(cX[0]!, cy, cW[0]!, rH, 'STT',      { bold: true, align: 'center', bg: '#F3F4F6' });
      cell(cX[1]!, cy, cW[1]!, rH, 'Chỉ tiêu', { bold: true, align: 'center', bg: '#F3F4F6' });
      cell(cX[2]!, cy, cW[2]!, rH, `Tháng ${months[0]}`, { bold: true, align: 'center', bg: '#F3F4F6' });
      cell(cX[3]!, cy, cW[3]!, rH, `Tháng ${months[1]}`, { bold: true, align: 'center', bg: '#F3F4F6' });
      cell(cX[4]!, cy, cW[4]!, rH, `Tháng ${months[2]}`, { bold: true, align: 'center', bg: '#F3F4F6' });
      cell(cX[5]!, cy, cW[5]!, rH, 'Tổng quý', { bold: true, align: 'center', bg: '#F3F4F6' });
      cy += rH;

      type Row = { stt: string; label: string; m1: number; m2: number; m3: number; total: number; accent?: boolean };
      const rows: Row[] = [
        { stt: '1', label: 'Doanh thu tính thuế GTGT',
          m1: n(declaration.revenue_m1), m2: n(declaration.revenue_m2),
          m3: n(declaration.revenue_m3), total: n(declaration.revenue_total) },
        { stt: '2', label: `Thuế GTGT (${vatPct.toFixed(2)}%)`,
          m1: n(declaration.vat_m1), m2: n(declaration.vat_m2),
          m3: n(declaration.vat_m3), total: n(declaration.vat_total), accent: true },
        { stt: '3', label: 'Doanh thu tính thuế TNCN',
          m1: n(declaration.revenue_m1), m2: n(declaration.revenue_m2),
          m3: n(declaration.revenue_m3), total: n(declaration.revenue_total) },
        { stt: '4', label: `Thuế TNCN (${pitPct.toFixed(2)}%)`,
          m1: n(declaration.pit_m1), m2: n(declaration.pit_m2),
          m3: n(declaration.pit_m3), total: n(declaration.pit_total), accent: true },
      ];

      rows.forEach((row) => {
        const fg = row.accent ? '#B45309' : '#111827';
        cell(cX[0]!, cy, cW[0]!, rH, row.stt,         { align: 'center', fg });
        cell(cX[1]!, cy, cW[1]!, rH, row.label,        { fg });
        cell(cX[2]!, cy, cW[2]!, rH, fmt(row.m1),      { align: 'right', fg });
        cell(cX[3]!, cy, cW[3]!, rH, fmt(row.m2),      { align: 'right', fg });
        cell(cX[4]!, cy, cW[4]!, rH, fmt(row.m3),      { align: 'right', fg });
        cell(cX[5]!, cy, cW[5]!, rH, fmt(row.total),   { align: 'right', bold: true, fg });
        cy += rH;
      });

      // Total row — label spans first 5 cols
      const totalLblW = cX[5]! - ML;
      doc.save().rect(ML, cy, totalLblW, rH).fillAndStroke('#FEF2F2', '#D1D5DB').restore();
      doc.font('Bold').fontSize(8.5).fillColor('#991B1B')
        .text('TỔNG CỘNG PHẢI NỘP (VNĐ)', ML + 4, cy + (rH - 10) / 2 + 1, {
          width: totalLblW - 8, align: 'right', lineBreak: false,
        });
      cell(cX[5]!, cy, cW[5]!, rH, fmt(declaration.total_payable),
        { bold: true, align: 'right', bg: '#FEF2F2', fg: '#991B1B' });
      cy += rH + 14;

      // ── SUMMARY HIGHLIGHT BOXES ───────────────────────────────────────────

      const bxGap = 10;
      const bxW = (UW - bxGap * 2) / 3;
      const bxH = 52;
      const drawBox = (x: number, t: string, val: string, fill: string, accent: string) => {
        doc.save().roundedRect(x, cy, bxW, bxH, 8).fillAndStroke(fill, '#E5E7EB').restore();
        doc.font('Reg').fontSize(8.5).fillColor('#6B7280')
          .text(t, x + 8, cy + 9, { width: bxW - 16, align: 'center' });
        doc.font('Bold').fontSize(15).fillColor(accent)
          .text(fmt(val) + ' đ', x + 8, cy + 24, { width: bxW - 16, align: 'center' });
      };
      drawBox(ML,                   'Doanh thu quý', String(declaration.revenue_total), '#EFF6FF', '#2563EB');
      drawBox(ML + bxW + bxGap,     'Thuế GTGT',     String(declaration.vat_total),     '#FFF7ED', '#EA580C');
      drawBox(ML + (bxW + bxGap)*2, 'Tổng phải nộp', String(declaration.total_payable),'#FEF2F2', '#DC2626');
      cy += bxH + 16;

      // ── CERTIFICATION & SIGNATURE ─────────────────────────────────────────

      hLine(cy, 0.5, '#E5E7EB');
      cy += 8;

      doc.font('Reg').fontSize(8).fillColor('#374151')
        .text(
          'Tôi cam đoan số liệu khai trên là đúng và chịu trách nhiệm trước pháp luật về những số liệu đã khai.',
          ML, cy, { width: UW },
        );
      cy += 20;

      const sigW = 220;
      doc.font('Reg').fontSize(8.5).fillColor('#374151')
        .text(`TP. Hồ Chí Minh, ngày ${exportDate}`, ML + UW - sigW, cy, { width: sigW, align: 'center' });
      cy += 13;
      doc.font('Bold').fontSize(8.5).fillColor('#111827')
        .text('NGƯỜI NỘP THUẾ HOẶC ĐẠI DIỆN HỢP PHÁP', ML + UW - sigW, cy, { width: sigW, align: 'center' });
      cy += 11;
      doc.font('Reg').fontSize(8).fillColor('#6B7280')
        .text('(Ký, ghi rõ họ tên; chức vụ, đóng dấu nếu có)', ML + UW - sigW, cy, { width: sigW, align: 'center' });
      cy += 36;

      // ── FOOTER ────────────────────────────────────────────────────────────

      hLine(cy, 0.3, '#E5E7EB');
      cy += 6;
      doc.font('Reg').fontSize(7.5).fillColor('#9CA3AF')
        .text(
          `Xuất bởi INVONE  |  ${exportDate}  |  MST: ${declaration.tax_code ?? ''}  |  INVONE – HKD PDF Export`,
          ML, cy, { width: UW, align: 'center' },
        );

      doc.end();
    });
  }
}