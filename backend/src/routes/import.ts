import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { XMLParser } from 'fast-xml-parser';
import AdmZip from 'adm-zip';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';
import { parseInvoiceSerial } from '../utils/InvoiceSerialParser';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// ── Multer: memory storage, 10 MB max ────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/xml',
      'application/xml',
      'text/csv',
      'application/zip',
      'application/x-zip-compressed',
    ];
    const ext = file.originalname.toLowerCase();
    if (
      allowed.includes(file.mimetype) ||
      ext.endsWith('.xlsx') ||
      ext.endsWith('.xls') ||
      ext.endsWith('.xml') ||
      ext.endsWith('.csv') ||
      ext.endsWith('.zip')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file .xlsx / .xls / .xml / .csv / .zip'));
    }
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────
interface LineItem {
  line_number:  number | null;
  item_code:    string | null;
  item_name:    string | null;
  unit:         string | null;
  quantity:     number | null;
  unit_price:   number | null;
  subtotal:     number | null;
  vat_rate:     string | null;
  vat_amount:   number | null;
  total:        number | null;
}

interface PreviewRow {
  row_index:      number;
  invoice_number: string | null;
  serial_number:  string | null;
  invoice_date:   string | null;
  direction:      'output' | 'input' | null;
  subtotal:       number | null;  // pre-tax amount (tiền hàng chưa VAT)
  total_amount:   number | null;
  vat_amount:     number | null;
  vat_rate:       string | null;
  seller_name:    string | null;
  seller_tax_code:string | null;
  buyer_name:     string | null;
  buyer_tax_code: string | null;
  payment_method: string | null;
  status:         string | null;
  error:          string | null;
  line_items:     LineItem[];
  // GROUP 28: GDT XML replacement/adjustment tracking (TTHDLQuan block)
  tc_hdon:        number | null;   // 1=thay thế, 2=điều chỉnh, null=bình thường
  lhd_cl_quan:    number | null;   // LHDCLQuan
  khhd_cl_quan:   string | null;   // KHHDCLQuan — ký hiệu HĐ bị thay thế/điều chỉnh
  so_hd_cl_quan:  string | null;   // SHDCLQuan  — số HĐ bị thay thế/điều chỉnh
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Detect file format from buffer + filename */
function detectFormat(filename: string, buffer: Buffer): 'gdt_xml' | 'gdt_excel' | 'gdt_list_excel' | 'hkd_excel' | 'csv' | 'zip' | 'unknown' {
  const ext = filename.toLowerCase();
  if (ext.endsWith('.zip')) return 'zip';
  if (ext.endsWith('.xml')) {
    // Peek for GDT XML signature
    const head = buffer.toString('utf-8', 0, 400);
    if (head.includes('DSHDon') || head.includes('TDiep') || head.includes('HDon')) return 'gdt_xml';
    return 'unknown';
  }
  if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
    // Peek into first 8 rows to detect GDT list format
    try {
      const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: 8 });
      const ws = wb.Sheets[wb.SheetNames[0]!]!;
      const peekRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null });
      const flatText = peekRows.flat()
        .map(c => String(c ?? '').toLowerCase())
        .join(' ');
      // GDT list markers: title row or unique column name
      if (
        flatText.includes('danh sách hóa đơn') ||
        flatText.includes('kết quả kiểm tra') ||
        flatText.includes('tổng tiền chưa thuế')
      ) {
        return 'gdt_list_excel';
      }
    } catch { /* fall through to gdt_excel */ }
    return 'gdt_excel';
  }
  if (ext.endsWith('.csv')) return 'csv';
  return 'unknown';
}

/** Normalise Vietnamese VAT rate string → bare numeric string compatible with numeric(5,2) column.
 *  KCT / KKKTT (không chịu thuế) → null  */
function normaliseVatRate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'kct' || s === 'kkktt') return null;
  if (s === '0' || s === '0%') return '0';
  if (s === '5' || s === '5%') return '5';
  if (s === '8' || s === '8%') return '8';
  if (s === '10' || s === '10%') return '10';
  // Strip % and validate numeric
  const stripped = s.replace('%', '').trim();
  const n = parseFloat(stripped);
  return !isNaN(n) ? String(n) : null;
}

/** Parse serial-date or string → YYYY-MM-DD */
function parseDate(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  // Excel serial number
  if (typeof raw === 'number') {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(raw).trim();
  // ISO
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // DD/MM/YYYY
  const vn = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (vn) return `${vn[3]}-${vn[2]}-${vn[1]}`;
  return null;
}

function toNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

// ── GDT XML Parser ────────────────────────────────────────────────────────────
function parseGdtXml(buffer: Buffer): PreviewRow[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    parseAttributeValue: true,
    trimValues: true,
    isArray: (name) => ['HDon', 'HHDVu', 'LTSuat'].includes(name),
  });
  const obj = parser.parse(buffer.toString('utf-8')) as Record<string, unknown>;

  function ensureArr(v: unknown): unknown[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
  }

  function deepFind(node: unknown, key: string): unknown {
    if (node == null || typeof node !== 'object') return undefined;
    const rec = node as Record<string, unknown>;
    if (key in rec) return rec[key];
    for (const k of Object.keys(rec)) {
      const found = deepFind(rec[k], key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // Locate invoice data nodes.
  // Multi-invoice portal export: TDiep? > ... > DSHDon > HDon[]  (data directly in HDon)
  // Single-invoice portal export: root HDon > DLHDon            (data inside DLHDon)
  let invoiceNodes: Record<string, unknown>[] = [];

  const dsHDon = deepFind(obj, 'DSHDon') as Record<string, unknown> | undefined;
  if (dsHDon) {
    invoiceNodes = ensureArr(dsHDon['HDon']) as Record<string, unknown>[];
  }

  if (invoiceNodes.length === 0) {
    // Single-invoice format: find DLHDon
    const dlhdon = deepFind(obj, 'DLHDon') as Record<string, unknown> | undefined;
    if (dlhdon) invoiceNodes = [dlhdon];
  }

  const rows: PreviewRow[] = [];

  for (let i = 0; i < invoiceNodes.length; i++) {
    const inv = invoiceNodes[i]!;
    const ttchung = (inv['TTChung'] ?? inv['ttchung'] ?? {}) as Record<string, unknown>;
    const ndhdon  = (inv['NDHDon']  ?? inv['ndhdon']  ?? {}) as Record<string, unknown>;
    // NBan / NMua may live inside NDHDon (single-invoice) or directly in node (multi-invoice)
    const nban = (ndhdon['NBan'] ?? ndhdon['nBan'] ?? inv['NBan'] ?? inv['nBan'] ?? {}) as Record<string, unknown>;
    const nmua = (ndhdon['NMua'] ?? ndhdon['nMua'] ?? inv['NMua'] ?? inv['nMua'] ?? {}) as Record<string, unknown>;
    // Totals are in NDHDon > TToan
    const ttoan = (ndhdon['TToan'] ?? ndhdon['tToan'] ?? {}) as Record<string, unknown>;
    // VAT rate: THTTLTSuat > LTSuat[0] > TSuat, or DSHHDVu > HHDVu[0] > TSuat
    const thttt   = ndhdon['THTTLTSuat'] as Record<string, unknown> | undefined;
    const lt0     = thttt ? (ensureArr(thttt['LTSuat'])[0] as Record<string, unknown> | undefined) : undefined;
    const dshhdvu = ndhdon['DSHHDVu'] as Record<string, unknown> | undefined;
    const hhItems = dshhdvu ? ensureArr(dshhdvu['HHDVu']) as Record<string, unknown>[] : [];
    const hh0     = hhItems[0] as Record<string, unknown> | undefined;
    const vatRateRaw = lt0?.['TSuat'] ?? hh0?.['TSuat'] ?? hh0?.['tSuat'] ?? ndhdon['TSuat'] ?? null;

    // Extract line items from DSHHDVu > HHDVu[]
    const lineItems: LineItem[] = hhItems.map(item => {
      const lineSubtotal = toNumber(item['ThTien'] ?? item['thTien']);
      const lineVatRate  = normaliseVatRate(item['TSuat'] ?? item['tSuat']);
      const lineVatAmt   = toNumber(item['TThue'] ?? item['tThue']);
      const computedVat  = lineVatAmt ?? (lineSubtotal != null && lineVatRate != null ? lineSubtotal * parseFloat(lineVatRate) / 100 : null);
      const lineTotal    = lineSubtotal != null ? lineSubtotal + (computedVat ?? 0) : null;
      return {
        line_number: toNumber(item['STT'] ?? item['stt']) as number | null,
        item_code:   item['MHHDVu'] ?? item['mHHDVu'] ? String(item['MHHDVu'] ?? item['mHHDVu']) : null,
        item_name:   item['THHDVu'] ?? item['tHHDVu'] ? String(item['THHDVu'] ?? item['tHHDVu']) : null,
        unit:        item['DVTinh'] ?? item['dVTinh'] ? String(item['DVTinh'] ?? item['dVTinh']) : null,
        quantity:    toNumber(item['SLuong'] ?? item['sLuong']),
        unit_price:  toNumber(item['DGia'] ?? item['dGia']),
        subtotal:    lineSubtotal,
        vat_rate:    lineVatRate,
        vat_amount:  computedVat,
        total:       lineTotal,
      };
    });

    const statusRaw = ttchung['TTHThue'] ?? ttchung['ttHThue'] ?? ttchung['TTHD'] ?? null;
    let status = 'valid';
    if (statusRaw != null) {
      const n = Number(statusRaw);
      if (n === 3) status = 'cancelled';
      else if (n === 5) status = 'replaced';
      else if (n === 6) status = 'adjusted';
    }

    // Parse GDT XML replacement/adjustment relationship block: TTChung > TTHDLQuan
    const tthd = (ttchung['TTHDLQuan'] ?? ttchung['ttHDLQuan'] ?? {}) as Record<string, unknown>;
    const tcHDon     = tthd['TCHDon']     ?? tthd['tcHDon']     ?? null;
    const lhdClQuan  = tthd['LHDCLQuan']  ?? tthd['lHDCLQuan']  ?? null;
    const khhdClQuan = tthd['KHHDCLQuan'] ?? tthd['kHHDCLQuan'] ?? null;
    const shdClQuan  = tthd['SHDCLQuan']  ?? tthd['sHDCLQuan']  ?? null;

    const tcHDonNum    = tcHDon    != null ? Number(tcHDon)    : null;
    const lhdClQuanNum = lhdClQuan != null ? Number(lhdClQuan) : null;

    const invNum = ttchung['SHDon'] ?? ttchung['sHDon'];
    const invDate = parseDate(ttchung['NLap'] ?? ttchung['nLap']);
    const totalAmt    = toNumber(ttoan['TgTTTBSo'] ?? ttoan['tgTTTBSo'] ?? ndhdon['TgTTTBSo'] ?? null);
    const vatAmt      = toNumber(ttoan['TgTThue']  ?? ttoan['tgTThue']  ?? ndhdon['TgTThue']  ?? null);
    const subtotalAmt = toNumber(ttoan['TgTCThue'] ?? ttoan['tgTCThue'] ?? ndhdon['TgTCThue'] ?? null)
                        ?? (totalAmt != null && vatAmt != null ? totalAmt - vatAmt : null);

    const invoiceNumber = invNum != null ? String(invNum) : null;
    const serialNumber  = ttchung['KHHDon'] ?? ttchung['kHHDon'] ?? null;
    const paymentMethod = ttchung['HTTToan'] ?? ttchung['hTTToan'] ?? null;
    let error: string | null = null;
    if (!invoiceNumber) error = 'Thiếu số hóa đơn';
    else if (!invDate)  error = 'Thiếu ngày hóa đơn';

    rows.push({
      row_index:       i,
      invoice_number:  invoiceNumber,
      serial_number:   serialNumber != null ? String(serialNumber) : null,
      invoice_date:    invDate,
      direction:       null,
      subtotal:        subtotalAmt,
      total_amount:    totalAmt,
      vat_amount:      vatAmt,
      vat_rate:        normaliseVatRate(vatRateRaw),
      seller_name:     String(nban['Ten'] ?? nban['ten'] ?? ''),
      seller_tax_code: String(nban['MST'] ?? nban['mst'] ?? ''),
      buyer_name:      String(nmua['Ten'] ?? nmua['ten'] ?? ''),
      buyer_tax_code:  String(nmua['MST'] ?? nmua['mst'] ?? ''),
      payment_method:  paymentMethod != null ? String(paymentMethod) : null,
      status,
      error,
      line_items:      lineItems,
      tc_hdon:        tcHDonNum,
      lhd_cl_quan:    lhdClQuanNum,
      khhd_cl_quan:   khhdClQuan != null ? String(khhdClQuan) : null,
      so_hd_cl_quan:  shdClQuan  != null ? String(shdClQuan)  : null,
    });
  }

  return rows;
}

// ── GDT Excel / CSV Parser ────────────────────────────────────────────────────
const HEADER_MAP: Record<string, keyof PreviewRow> = {
  'số hóa đơn': 'invoice_number',
  'ký hiệu mẫu số': 'invoice_number',
  'số hd': 'invoice_number',
  'ngày hóa đơn': 'invoice_date',
  'ngày lập': 'invoice_date',
  'tên người bán': 'seller_name',
  'mst người bán': 'seller_tax_code',
  'tên người mua': 'buyer_name',
  'mst người mua': 'buyer_tax_code',
  'tổng tiền thanh toán': 'total_amount',
  'tổng cộng tiền thanh toán': 'total_amount',
  'tiền hàng': 'subtotal',
  'tiền chưa thuế': 'subtotal',
  'tiền chưa vat': 'subtotal',
  'thành tiền chưa thuế': 'subtotal',
  'tiền thuế gtgt': 'vat_amount',
  'thuế suất': 'vat_rate',
  'trạng thái': 'status',
};

function parseExcelOrCsv(buffer: Buffer, isCsv: boolean): PreviewRow[] {
  const wb = isCsv
    ? XLSX.read(buffer, { type: 'buffer', raw: false })
    : XLSX.read(buffer, { type: 'buffer', cellDates: false });

  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, raw: true });

  if (raw.length === 0) return [];

  // Build column index map from first row keys
  const firstRow = raw[0]!;
  const colMap: Record<string, keyof PreviewRow> = {};
  for (const key of Object.keys(firstRow)) {
    const norm = key.toLowerCase().trim();
    for (const [pattern, field] of Object.entries(HEADER_MAP)) {
      if (norm.includes(pattern)) {
        colMap[key] = field;
        break;
      }
    }
  }

  return raw.map((row, i) => {
    const result: PreviewRow = {
      row_index: i + 1,
      invoice_number: null, serial_number: null, invoice_date: null, direction: null,
      subtotal: null, total_amount: null, vat_amount: null, vat_rate: null,
      seller_name: null, seller_tax_code: null,
      buyer_name: null, buyer_tax_code: null,
      payment_method: null,
      status: 'valid', error: null,
      line_items: [],
      tc_hdon: null, lhd_cl_quan: null, khhd_cl_quan: null, so_hd_cl_quan: null,
    };

    for (const [col, field] of Object.entries(colMap)) {
      const val = row[col];
      if (field === 'total_amount' || field === 'vat_amount' || field === 'subtotal') {
        (result as unknown as Record<string, unknown>)[field] = toNumber(val);
      } else if (field === 'vat_rate') {
        result.vat_rate = normaliseVatRate(val);
      } else if (field === 'invoice_date') {
        result.invoice_date = parseDate(val);
      } else if (field === 'status') {
        const s = String(val ?? '').trim();
        if (s.includes('hủy') || s.includes('cancel') || s === '3') result.status = 'cancelled';
        else if (s.includes('thay thế') || s === '5') result.status = 'replaced';
        else if (s.includes('điều chỉnh') || s === '6') result.status = 'adjusted';
        else result.status = 'valid';
      } else {
        (result as unknown as Record<string, unknown>)[field] = val != null ? String(val) : null;
      }
    }

    // Minimal validation
    if (!result.invoice_number) result.error = 'Thiếu số hóa đơn';
    else if (!result.invoice_date) result.error = 'Thiếu ngày hóa đơn';

    return result;
  });
}

// ── GDT List Excel Parser (Danh sách hóa đơn từ cổng hoadondientu.gdt.gov.vn) ──
// Columns: Số HĐ | Ngày lập | MST người bán | Tên người bán | MST người mua |
//          Tên người mua | Địa chỉ người mua | Tổng tiền chưa thuế | Tổng tiền thuế |
//          Chiết khấu | Phí | Tổng tiền thanh toán | Đơn vị tiền | Tỷ giá |
//          Trạng thái HĐ | Kết quả kiểm tra HĐ
function parseGdtListExcel(buffer: Buffer): PreviewRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]!]!;

  // Read all rows as raw arrays (no header inference)
  const allRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true });

  // Find the actual header row: first row containing a cell with "số hóa đơn"
  let headerRowIdx = -1;
  const colIdx: Record<string, number> = {};

  for (let r = 0; r < Math.min(allRows.length, 15); r++) {
    const row = allRows[r] as unknown[];
    const hasInvoiceNumHeader = row.some(
      cell => cell != null && String(cell).toLowerCase().replace(/\s+/g, ' ').includes('số hóa đơn')
    );
    if (hasInvoiceNumHeader) {
      headerRowIdx = r;
      row.forEach((cell, idx) => {
        if (cell == null) return;
        // Normalise: lowercase, collapse whitespace, replace newline/slash separators
        const h = String(cell)
          .toLowerCase()
          .replace(/[\n\r]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (h.includes('số hóa đơn'))                              colIdx['invoice_number']  = idx;
        else if (h.includes('ngày lập') || h.includes('ngày hóa đơn')) colIdx['invoice_date'] = idx;
        else if ((h.includes('mst') || h.includes('mã số thuế')) &&
                 (h.includes('người bán') || h.includes('người xuất')))  colIdx['seller_tax_code'] = idx;
        else if ((h.includes('tên') ) &&
                 (h.includes('người bán') || h.includes('người xuất')))  colIdx['seller_name'] = idx;
        else if ((h.includes('mst') || h.includes('mã số thuế')) &&
                 (h.includes('người mua') || h.includes('người nhận')))  colIdx['buyer_tax_code'] = idx;
        else if ((h.includes('tên')) &&
                 (h.includes('người mua') || h.includes('người nhận')))  colIdx['buyer_name'] = idx;
        else if (h.includes('địa chỉ'))                            colIdx['buyer_address']  = idx;
        else if (h.includes('tổng tiền chưa thuế'))                colIdx['subtotal']       = idx;
        else if (h.includes('tổng tiền thuế') &&
                 !h.includes('thanh toán'))                        colIdx['vat_amount']     = idx;
        else if (h.includes('tổng tiền thanh toán'))               colIdx['total_amount']   = idx;
        else if (h.includes('trạng thái'))                         colIdx['status']         = idx;
        else if (h.includes('kết quả kiểm tra'))                   colIdx['gdt_check']      = idx;
        else if (h.includes('ký hiệu') && h.includes('hóa đơn'))  colIdx['serial_number']  = idx;
      });
      break;
    }
  }

  if (headerRowIdx < 0) return []; // Unrecognised layout

  const rows: PreviewRow[] = [];

  for (let r = headerRowIdx + 1; r < allRows.length; r++) {
    const row = allRows[r] as unknown[];

    // Skip completely empty rows or summary rows
    const nonEmpty = row.filter(c => c != null && String(c).trim() !== '');
    if (nonEmpty.length === 0) continue;

    const getCell = (key: string): unknown =>
      colIdx[key] !== undefined ? row[colIdx[key]!] : null;

    const invoiceNumber = getCell('invoice_number') != null
      ? String(getCell('invoice_number')).trim()
      : null;

    // Skip rows that clearly aren't invoice data (e.g. totals row)
    if (invoiceNumber && !/^\d/.test(invoiceNumber)) continue;

    const invDate       = parseDate(getCell('invoice_date'));
    const sellerTax     = getCell('seller_tax_code') != null ? String(getCell('seller_tax_code')).trim() : null;
    const sellerName    = getCell('seller_name')    != null ? String(getCell('seller_name')).trim()    : null;
    const buyerTax      = getCell('buyer_tax_code') != null ? String(getCell('buyer_tax_code')).trim()  : null;
    const buyerName     = getCell('buyer_name')     != null ? String(getCell('buyer_name')).trim()     : null;
    const serialNumber  = getCell('serial_number')  != null ? String(getCell('serial_number')).trim()  : null;
    const subtotal      = toNumber(getCell('subtotal'));
    const vatAmount     = toNumber(getCell('vat_amount'));
    const totalAmount   = toNumber(getCell('total_amount'));

    // Derive VAT rate from subtotal + vatAmount when possible
    let vatRate: string | null = null;
    if (subtotal != null && subtotal > 0 && vatAmount != null) {
      const rate = Math.round((vatAmount / subtotal) * 100);
      if ([0, 5, 8, 10].includes(rate)) vatRate = String(rate);
    }

    // Status mapping
    let status = 'valid';
    const statusRaw = getCell('status') != null ? String(getCell('status')).toLowerCase() : '';
    if (statusRaw.includes('hủy') || statusRaw.includes('cancel'))   status = 'cancelled';
    else if (statusRaw.includes('thay thế'))                         status = 'replaced';
    else if (statusRaw.includes('điều chỉnh'))                       status = 'adjusted';

    // GDT validated: "Tổng cục thuế đã nhận" → true
    // (all items from this portal export are by definition GDT-confirmed)

    let error: string | null = null;
    if (!invoiceNumber) error = 'Thiếu số hóa đơn';
    else if (!invDate)  error = 'Thiếu ngày hóa đơn';

    rows.push({
      row_index:       r - headerRowIdx,
      invoice_number:  invoiceNumber,
      serial_number:   serialNumber,
      invoice_date:    invDate,
      direction:       null, // User must select direction
      subtotal,
      total_amount:    totalAmount,
      vat_amount:      vatAmount,
      vat_rate:        vatRate,
      seller_name:     sellerName,
      seller_tax_code: sellerTax,
      buyer_name:      buyerName,
      buyer_tax_code:  buyerTax,
      payment_method:  null,
      status,
      error,
      line_items:      [], // List format — no line item detail
      tc_hdon: null, lhd_cl_quan: null, khhd_cl_quan: null, so_hd_cl_quan: null,
    });
  }

  return rows;
}

// ── ZIP File Processor ────────────────────────────────────────────────────────
interface ZipFileResult {
  filename: string;
  rows: PreviewRow[];
  error: string | null;
}

function parseZipFile(buffer: Buffer): { files: ZipFileResult[]; totalRows: number } {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // Security: max 100 XML files, max 200MB uncompressed total
  const xmlEntries = entries.filter(e =>
    !e.isDirectory && e.entryName.toLowerCase().endsWith('.xml')
  );

  if (xmlEntries.length === 0) {
    return { files: [{ filename: '(zip)', rows: [], error: 'ZIP không chứa file XML nào' }], totalRows: 0 };
  }
  if (xmlEntries.length > 100) {
    return { files: [{ filename: '(zip)', rows: [], error: 'ZIP chứa quá nhiều file (tối đa 100 file XML)' }], totalRows: 0 };
  }

  let totalUncompressed = 0;
  for (const entry of xmlEntries) {
    totalUncompressed += entry.header.size;
    if (totalUncompressed > 200 * 1024 * 1024) {
      return { files: [{ filename: '(zip)', rows: [], error: 'Tổng dung lượng giải nén vượt 200MB' }], totalRows: 0 };
    }
  }

  const files: ZipFileResult[] = [];
  let totalRows = 0;

  for (const entry of xmlEntries) {
    try {
      const xmlBuffer = entry.getData();
      const rows = parseGdtXml(xmlBuffer);
      totalRows += rows.length;
      files.push({
        filename: entry.entryName.split('/').pop() ?? entry.entryName,
        rows,
        error: rows.length === 0 ? 'Không tìm thấy hóa đơn trong file' : null,
      });
    } catch (err) {
      files.push({
        filename: entry.entryName.split('/').pop() ?? entry.entryName,
        rows: [],
        error: `Lỗi đọc file: ${err instanceof Error ? err.message : 'unknown'}`,
      });
    }
  }

  return { files, totalRows };
}

// ── POST /api/import/preview ──────────────────────────────────────────────────
router.post(
  '/preview',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw new ValidationError('Vui lòng chọn file');
      const { direction } = req.body as { direction?: string };

      const format = detectFormat(req.file.originalname, req.file.buffer);
      if (format === 'unknown') throw new ValidationError('Định dạng file không được hỗ trợ. Dùng .xml .xlsx .xls .csv .zip');

      let rows: PreviewRow[];
      let zipFiles: ZipFileResult[] | undefined;

      if (format === 'zip') {
        const zipResult = parseZipFile(req.file.buffer);
        zipFiles = zipResult.files;
        rows = zipResult.files.flatMap(f => f.rows);
      } else if (format === 'gdt_xml') {
        rows = parseGdtXml(req.file.buffer);
      } else if (format === 'gdt_list_excel') {
        rows = parseGdtListExcel(req.file.buffer);
      } else if (format === 'csv') {
        rows = parseExcelOrCsv(req.file.buffer, true);
      } else {
        rows = parseExcelOrCsv(req.file.buffer, false);
      }

      // Assign direction override
      if (direction === 'output' || direction === 'input') {
        rows = rows.map(r => ({ ...r, direction: direction }));
      }

      const preview = rows.slice(0, 5);
      const validRows     = rows.filter(r => !r.error).length;
      const errorRows     = rows.filter(r => !!r.error).length;

      // Check duplicates: batch check
      const companyId = req.user!.companyId;
      const invoiceNums = rows.filter(r => r.invoice_number).map(r => r.invoice_number!);
      let duplicateRows = 0;
      if (invoiceNums.length > 0) {
        const dupRes = await pool.query(
          `SELECT COUNT(*) FROM invoices WHERE company_id = $1 AND invoice_number = ANY($2::text[])`,
          [companyId, invoiceNums]
        );
        duplicateRows = parseInt(dupRes.rows[0].count, 10);
      }

      // Store file buffer in a temp record so /execute can use it without re-upload
      const fileId = uuidv4();
      await pool.query(
        `INSERT INTO import_temp_files (id, company_id, filename, buffer, format, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT DO NOTHING`,
        [fileId, companyId, req.file.originalname, req.file.buffer, format]
      );

      const formatLabelMap: Record<string, string> = {
        gdt_xml:          'XML từ cổng thuế GDT',
        gdt_excel:        'Excel từ cổng thuế GDT',
        gdt_list_excel:   'Danh sách HĐ từ cổng GDT (.xlsx)',
        csv:              'CSV',
        hkd_excel:        'Excel HKD',
        zip:              'ZIP (chứa XML)',
      };

      // Determine effective direction from rows (override may have been applied)
      const rowDirections = [...new Set(rows.map(r => r.direction).filter(Boolean))];
      const detectedDirection = rowDirections.length === 1 ? rowDirections[0] : 'both';

      sendSuccess(res, {
        fileId,
        format,
        formatLabel: formatLabelMap[format] ?? format,
        totalRows: rows.length,
        validRows,
        errorRows,
        duplicateRows,
        direction: detectedDirection,
        preview,
        errors: rows.filter(r => !!r.error).slice(0, 20),
        ...(zipFiles ? {
          zipFiles: zipFiles.map(f => ({
            filename: f.filename,
            invoiceCount: f.rows.filter(r => !r.error).length,
            errorCount: f.rows.filter(r => !!r.error).length,
            error: f.error,
          })),
        } : {}),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/import/execute ──────────────────────────────────────────────────
const executeSchema = z.object({
  fileId:          z.string().uuid(),
  direction:       z.enum(['output', 'input']),
  duplicatePolicy: z.enum(['skip', 'overwrite']).default('skip'),
});

router.post(
  '/execute',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = executeSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

      const { fileId, direction, duplicatePolicy } = parsed.data;
      const companyId = req.user!.companyId;

      // Retrieve temp file
      const fileRes = await pool.query(
        `SELECT filename, buffer, format FROM import_temp_files WHERE id = $1 AND company_id = $2`,
        [fileId, companyId]
      );
      if (fileRes.rows.length === 0) throw new NotFoundError('File tạm không tìm thấy — vui lòng upload lại');

      const { filename, buffer, format } = fileRes.rows[0] as { filename: string; buffer: Buffer; format: string };

      // Parse again
      let rows: PreviewRow[];
      if (format === 'zip') {
        const zipResult = parseZipFile(buffer);
        rows = zipResult.files.flatMap(f => f.rows);
      } else if (format === 'gdt_xml') {
        rows = parseGdtXml(buffer);
      } else if (format === 'gdt_list_excel') {
        rows = parseGdtListExcel(buffer);
      } else if (format === 'csv') {
        rows = parseExcelOrCsv(buffer, true);
      } else {
        rows = parseExcelOrCsv(buffer, false);
      }
      rows = rows.map(r => ({ ...r, direction }));

      const sessionId = uuidv4();
      const validRows = rows.filter(r => !r.error);

      // Create import session FIRST (invoices FK constraint references this id)
      await pool.query(
        `INSERT INTO import_sessions
         (id, company_id, filename, format, direction, total_rows, success_count, duplicate_count, error_count, imported_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,0,0,0,$7,NOW())`,
        [sessionId, companyId, filename, format, direction, rows.length, req.user!.userId]
      );

      // Upsert invoices
      let successCount = 0;
      let dupCount = 0;
      let errCount = rows.filter(r => !!r.error).length;

      for (const row of validRows) {
        try {
          const invoiceId = uuidv4();
          const rowDirection = row.direction ?? direction;
          const vatRate = row.vat_rate !== '' ? row.vat_rate : null;

          // Manual dedup — uses SELECT+INSERT/UPDATE to avoid relying on a specific unique constraint
          const dupRes = await pool.query(
            `SELECT id, is_permanently_ignored FROM invoices
             WHERE company_id = $1 AND invoice_number = $2 AND direction = $3
             LIMIT 1`,
            [companyId, row.invoice_number, rowDirection]
          );
          const existingRow = dupRes.rows[0] ?? null;
          const existingId: string | null = existingRow?.id ?? null;

          // Nếu hóa đơn đã bị bỏ qua vĩnh viễn → không bao giờ nhập lại
          if (existingRow?.is_permanently_ignored) {
            dupCount++;
            continue;
          }

          // Derive invoice classification fields from serial number (TT78/2021)
          const serialInfo = parseInvoiceSerial(row.serial_number ?? '');

          if (existingId && duplicatePolicy === 'skip') {
            dupCount++;
          } else if (existingId && duplicatePolicy === 'overwrite') {
            const rowSubtotalOvr = row.subtotal ?? ((row.total_amount ?? 0) - (row.vat_amount ?? 0));
            await pool.query(
              `UPDATE invoices SET
                 serial_number = $1, invoice_date = $2, status = $3,
                 seller_name = $4, seller_tax_code = $5,
                 buyer_name = $6, buyer_tax_code = $7,
                 subtotal = $8, total_amount = $9, vat_amount = $10, vat_rate = $11,
                 payment_method = $12, import_session_id = $13,
                 tc_hdon = $15, lhd_cl_quan = $16, khhd_cl_quan = $17, so_hd_cl_quan = $18,
                 invoice_group = $19, serial_has_cqt = $20, has_line_items = $21,
                 updated_at = NOW()
               WHERE id = $14`,
              [
                row.serial_number,
                row.invoice_date, row.status ?? 'valid',
                row.seller_name, row.seller_tax_code,
                row.buyer_name, row.buyer_tax_code,
                rowSubtotalOvr, row.total_amount, row.vat_amount, vatRate,
                row.payment_method, sessionId, existingId,
                row.tc_hdon ?? null, row.lhd_cl_quan ?? null,
                row.khhd_cl_quan ?? null, row.so_hd_cl_quan ?? null,
                serialInfo.invoiceGroup, serialInfo.hasCqtCode, serialInfo.isDetailAvailable,
              ]
            );
            // Replace line items on overwrite
            if (row.line_items.length > 0) {
              await pool.query(`DELETE FROM invoice_line_items WHERE invoice_id = $1`, [existingId]);
              for (const li of row.line_items) {
                await pool.query(
                  `INSERT INTO invoice_line_items
                   (id, invoice_id, company_id, line_number, item_code, item_name, unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total, created_at)
                   VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
                  [existingId, companyId, li.line_number, li.item_code, li.item_name, li.unit, li.quantity, li.unit_price, li.subtotal, li.vat_rate, li.vat_amount, li.total]
                );
              }
            }
            // Mark original invoice as replaced/adjusted when this invoice references it
            if (row.tc_hdon != null && row.khhd_cl_quan && row.so_hd_cl_quan) {
              const newStatus = row.tc_hdon === 1 ? 'replaced' : 'adjusted';
              await pool.query(
                `UPDATE invoices SET status = $1, updated_at = NOW()
                 WHERE company_id = $2
                   AND serial_number = $3
                   AND invoice_number = $4
                   AND status NOT IN ('cancelled', 'replaced', 'adjusted')`,
                [newStatus, companyId, row.khhd_cl_quan, row.so_hd_cl_quan]
              );
            }
            successCount++;
          } else {
            const rowSubtotal = row.subtotal ?? ((row.total_amount ?? 0) - (row.vat_amount ?? 0));
            await pool.query(
              `INSERT INTO invoices
               (id, company_id, invoice_number, serial_number, invoice_date, direction, status,
                seller_name, seller_tax_code, buyer_name, buyer_tax_code,
                subtotal, total_amount, vat_amount, vat_rate, payment_method,
                tc_hdon, lhd_cl_quan, khhd_cl_quan, so_hd_cl_quan,
                invoice_group, serial_has_cqt, has_line_items,
                gdt_validated, source, import_session_id, provider, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,true,'manual_import',$24,'manual',NOW())`,
              [
                invoiceId, companyId,
                row.invoice_number, row.serial_number,
                row.invoice_date, rowDirection,
                row.status ?? 'valid',
                row.seller_name, row.seller_tax_code,
                row.buyer_name, row.buyer_tax_code,
                rowSubtotal, row.total_amount, row.vat_amount, vatRate,
                row.payment_method,
                row.tc_hdon ?? null, row.lhd_cl_quan ?? null,
                row.khhd_cl_quan ?? null, row.so_hd_cl_quan ?? null,
                serialInfo.invoiceGroup, serialInfo.hasCqtCode, serialInfo.isDetailAvailable,
                sessionId,
              ]
            );
            // Insert line items
            for (const li of row.line_items) {
              await pool.query(
                `INSERT INTO invoice_line_items
                 (id, invoice_id, company_id, line_number, item_code, item_name, unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total, created_at)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
                [invoiceId, companyId, li.line_number, li.item_code, li.item_name, li.unit, li.quantity, li.unit_price, li.subtotal, li.vat_rate, li.vat_amount, li.total]
              );
            }
            // Mark original invoice as replaced/adjusted when this invoice references it
            if (row.tc_hdon != null && row.khhd_cl_quan && row.so_hd_cl_quan) {
              const newStatus = row.tc_hdon === 1 ? 'replaced' : 'adjusted';
              await pool.query(
                `UPDATE invoices SET status = $1, updated_at = NOW()
                 WHERE company_id = $2
                   AND serial_number = $3
                   AND invoice_number = $4
                   AND status NOT IN ('cancelled', 'replaced', 'adjusted')`,
                [newStatus, companyId, row.khhd_cl_quan, row.so_hd_cl_quan]
              );
            }
            successCount++;
          }
        } catch (rowErr) {
          console.error('[import/execute] row insert failed:', rowErr);
          errCount++;
        }
      }

      // Update session with final counts
      await pool.query(
        `UPDATE import_sessions
         SET success_count = $1, duplicate_count = $2, error_count = $3
         WHERE id = $4`,
        [successCount, dupCount, errCount, sessionId]
      );

      // Clean up temp file
      await pool.query(`DELETE FROM import_temp_files WHERE id = $1`, [fileId]);

      sendSuccess(res, { session_id: sessionId, success_count: successCount, duplicate_count: dupCount, error_count: errCount });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/import/execute-stream — SSE progress during import ──────────────
router.post(
  '/execute-stream',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = executeSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

      const { fileId, direction, duplicatePolicy } = parsed.data;
      const companyId = req.user!.companyId;

      // Retrieve temp file
      const fileRes = await pool.query(
        `SELECT filename, buffer, format FROM import_temp_files WHERE id = $1 AND company_id = $2`,
        [fileId, companyId]
      );
      if (fileRes.rows.length === 0) throw new NotFoundError('File tạm không tìm thấy — vui lòng upload lại');

      const { filename, buffer, format } = fileRes.rows[0] as { filename: string; buffer: Buffer; format: string };

      // Parse
      let rows: PreviewRow[];
      if (format === 'zip') {
        const zipResult = parseZipFile(buffer);
        rows = zipResult.files.flatMap(f => f.rows);
      } else if (format === 'gdt_xml') {
        rows = parseGdtXml(buffer);
      } else if (format === 'gdt_list_excel') {
        rows = parseGdtListExcel(buffer);
      } else if (format === 'csv') {
        rows = parseExcelOrCsv(buffer, true);
      } else {
        rows = parseExcelOrCsv(buffer, false);
      }
      rows = rows.map(r => ({ ...r, direction }));

      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendEvent = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const sessionId = uuidv4();
      const validRows = rows.filter(r => !r.error);
      const totalValid = validRows.length;

      await pool.query(
        `INSERT INTO import_sessions
         (id, company_id, filename, format, direction, total_rows, success_count, duplicate_count, error_count, imported_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,0,0,0,$7,NOW())`,
        [sessionId, companyId, filename, format, direction, rows.length, req.user!.userId]
      );

      sendEvent({ type: 'start', totalRows: rows.length, validRows: totalValid });

      let successCount = 0;
      let dupCount = 0;
      let errCount = rows.filter(r => !!r.error).length;
      let processed = 0;

      for (const row of validRows) {
        try {
          const invoiceId = uuidv4();
          const rowDirection = row.direction ?? direction;
          const vatRate = row.vat_rate !== '' ? row.vat_rate : null;

          const dupRes = await pool.query(
            `SELECT id, is_permanently_ignored FROM invoices
             WHERE company_id = $1 AND invoice_number = $2 AND direction = $3
             LIMIT 1`,
            [companyId, row.invoice_number, rowDirection]
          );
          const existingRow = dupRes.rows[0] ?? null;
          const existingId: string | null = existingRow?.id ?? null;

          // Derive invoice classification fields from serial number (TT78/2021)
          const serialInfo = parseInvoiceSerial(row.serial_number ?? '');

          if (existingRow?.is_permanently_ignored) {
            dupCount++;
          } else if (existingId && duplicatePolicy === 'skip') {
            dupCount++;
          } else if (existingId && duplicatePolicy === 'overwrite') {
            const rowSubtotalOvr = row.subtotal ?? ((row.total_amount ?? 0) - (row.vat_amount ?? 0));
            await pool.query(
              `UPDATE invoices SET
                 serial_number = $1, invoice_date = $2, status = $3,
                 seller_name = $4, seller_tax_code = $5,
                 buyer_name = $6, buyer_tax_code = $7,
                 subtotal = $8, total_amount = $9, vat_amount = $10, vat_rate = $11,
                 payment_method = $12, import_session_id = $13,
                 tc_hdon = $15, lhd_cl_quan = $16, khhd_cl_quan = $17, so_hd_cl_quan = $18,
                 invoice_group = $19, serial_has_cqt = $20, has_line_items = $21,
                 updated_at = NOW()
               WHERE id = $14`,
              [
                row.serial_number,
                row.invoice_date, row.status ?? 'valid',
                row.seller_name, row.seller_tax_code,
                row.buyer_name, row.buyer_tax_code,
                rowSubtotalOvr, row.total_amount, row.vat_amount, vatRate,
                row.payment_method, sessionId, existingId,
                row.tc_hdon ?? null, row.lhd_cl_quan ?? null,
                row.khhd_cl_quan ?? null, row.so_hd_cl_quan ?? null,
                serialInfo.invoiceGroup, serialInfo.hasCqtCode, serialInfo.isDetailAvailable,
              ]
            );
            if (row.line_items.length > 0) {
              await pool.query(`DELETE FROM invoice_line_items WHERE invoice_id = $1`, [existingId]);
              for (const li of row.line_items) {
                await pool.query(
                  `INSERT INTO invoice_line_items
                   (id, invoice_id, company_id, line_number, item_code, item_name, unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total, created_at)
                   VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
                  [existingId, companyId, li.line_number, li.item_code, li.item_name, li.unit, li.quantity, li.unit_price, li.subtotal, li.vat_rate, li.vat_amount, li.total]
                );
              }
            }
            // Mark original invoice as replaced/adjusted when this invoice references it
            if (row.tc_hdon != null && row.khhd_cl_quan && row.so_hd_cl_quan) {
              const newStatus = row.tc_hdon === 1 ? 'replaced' : 'adjusted';
              await pool.query(
                `UPDATE invoices SET status = $1, updated_at = NOW()
                 WHERE company_id = $2
                   AND serial_number = $3
                   AND invoice_number = $4
                   AND status NOT IN ('cancelled', 'replaced', 'adjusted')`,
                [newStatus, companyId, row.khhd_cl_quan, row.so_hd_cl_quan]
              );
            }
            successCount++;
          } else {
            const rowSubtotal = row.subtotal ?? ((row.total_amount ?? 0) - (row.vat_amount ?? 0));
            await pool.query(
              `INSERT INTO invoices
               (id, company_id, invoice_number, serial_number, invoice_date, direction, status,
                seller_name, seller_tax_code, buyer_name, buyer_tax_code,
                subtotal, total_amount, vat_amount, vat_rate, payment_method,
                tc_hdon, lhd_cl_quan, khhd_cl_quan, so_hd_cl_quan,
                invoice_group, serial_has_cqt, has_line_items,
                gdt_validated, source, import_session_id, provider, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,true,'manual_import',$24,'manual',NOW())`,
              [
                invoiceId, companyId,
                row.invoice_number, row.serial_number,
                row.invoice_date, rowDirection,
                row.status ?? 'valid',
                row.seller_name, row.seller_tax_code,
                row.buyer_name, row.buyer_tax_code,
                rowSubtotal, row.total_amount, row.vat_amount, vatRate,
                row.payment_method,
                row.tc_hdon ?? null, row.lhd_cl_quan ?? null,
                row.khhd_cl_quan ?? null, row.so_hd_cl_quan ?? null,
                serialInfo.invoiceGroup, serialInfo.hasCqtCode, serialInfo.isDetailAvailable,
                sessionId,
              ]
            );
            for (const li of row.line_items) {
              await pool.query(
                `INSERT INTO invoice_line_items
                 (id, invoice_id, company_id, line_number, item_code, item_name, unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total, created_at)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
                [invoiceId, companyId, li.line_number, li.item_code, li.item_name, li.unit, li.quantity, li.unit_price, li.subtotal, li.vat_rate, li.vat_amount, li.total]
              );
            }
            // Mark original invoice as replaced/adjusted when this invoice references it
            if (row.tc_hdon != null && row.khhd_cl_quan && row.so_hd_cl_quan) {
              const newStatus = row.tc_hdon === 1 ? 'replaced' : 'adjusted';
              await pool.query(
                `UPDATE invoices SET status = $1, updated_at = NOW()
                 WHERE company_id = $2
                   AND serial_number = $3
                   AND invoice_number = $4
                   AND status NOT IN ('cancelled', 'replaced', 'adjusted')`,
                [newStatus, companyId, row.khhd_cl_quan, row.so_hd_cl_quan]
              );
            }
            successCount++;
          }
        } catch (rowErr) {
          console.error('[import/execute-stream] row insert failed:', rowErr);
          errCount++;
        }

        processed++;
        // Emit progress every 5 rows or on last row
        if (processed % 5 === 0 || processed === totalValid) {
          sendEvent({
            type: 'progress',
            processed,
            total: totalValid,
            percent: Math.round((processed / totalValid) * 100),
            successCount,
            dupCount,
            errCount,
          });
        }
      }

      await pool.query(
        `UPDATE import_sessions
         SET success_count = $1, duplicate_count = $2, error_count = $3
         WHERE id = $4`,
        [successCount, dupCount, errCount, sessionId]
      );

      await pool.query(`DELETE FROM import_temp_files WHERE id = $1`, [fileId]);

      sendEvent({
        type: 'complete',
        session_id: sessionId,
        success_count: successCount,
        duplicate_count: dupCount,
        error_count: errCount,
      });

      res.end();
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/import/sessions ──────────────────────────────────────────────────
router.get(
  '/sessions',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page     = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
      const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query['pageSize'] ?? '20'), 10)));
      const offset   = (page - 1) * pageSize;
      const companyId = req.user!.companyId;

      const [countRes, dataRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM import_sessions WHERE company_id = $1`, [companyId]),
        pool.query(
          `SELECT s.id, s.filename, s.format, s.direction,
            NULL::int AS period_month, NULL::int AS period_year,
            s.total_rows, s.success_count, s.duplicate_count, s.error_count,
            s.created_at, u.full_name AS user_name
             FROM import_sessions s
             LEFT JOIN users u ON u.id = s.imported_by
             WHERE s.company_id = $1
             ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
          [companyId, pageSize, offset]
        ),
      ]);

      sendPaginated(res, dataRes.rows, parseInt(countRes.rows[0].count, 10), page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/import/sessions/:id ──────────────────────────────────────────
router.delete(
  '/sessions/:id',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId;
      const { id } = req.params;

      // Validate UUID
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError('Invalid session ID');

      // Ownership check
      const sessionRes = await pool.query(
        `SELECT id FROM import_sessions WHERE id = $1 AND company_id = $2`,
        [id, companyId]
      );
      if (sessionRes.rows.length === 0) throw new NotFoundError('Phiên nhập không tìm thấy');

      // Delete imported invoices
      await pool.query(
        `DELETE FROM invoices WHERE import_session_id = $1 AND company_id = $2`,
        [id, companyId]
      );
      await pool.query(`DELETE FROM import_sessions WHERE id = $1`, [id]);

      sendSuccess(res, { deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
