/**
 * BOT-03 — GDT XML Parser
 *
 * Parses TT78/2021 / TT80/2021 XML format from hoadondientu.gdt.gov.vn.
 *
 * XML structure (simplified):
 *   Bulk XML (list export):
 *     <TDiep><DLieu><TBao><DLHDon><DSHDon>
 *       <HDon><TTChung>...</TTChung><NDHDon>...</NDHDon></HDon>
 *
 *   Single-invoice XML (export-xml endpoint, served inside a ZIP archive):
 *     <HDon><DLHDon><TTChung>...</TTChung><NDHDon>...<DSHHDVu><HHDVu/></DSHHDVu></NDHDon></DLHDon></HDon>
 *   The export-xml endpoint returns a ZIP file. The ZIP contains invoice.xml (the actual XML),
 *   invoice.html, details.js, sign images, etc.
 *
 * Both camelCase and PascalCase variants are handled.
 */
import * as zlib from 'zlib';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../logger';

export interface RawInvoice {
  invoice_number:  string | null;
  invoice_date:    string | null;
  direction:       'output' | 'input';
  status:          'valid' | 'cancelled' | 'replaced' | 'adjusted' | 'replaced_original';
  seller_name:     string | null;
  seller_tax_code: string | null;
  buyer_name:      string | null;
  buyer_tax_code:  string | null;
  total_amount:    number | null;
  vat_amount:      number | null;
  vat_rate:        string | null;
  serial_number:   string | null;
  invoice_type:    string | null;
  source:          'gdt_bot';
  gdt_validated:   true;
  /**
   * Whether GDT has a signed XML for this invoice.
   * false for ttxly==6 (không mã) and ttxly==8 (ủy nhiệm) —
   * these are paper/non-coded invoices; calling export-xml returns HTTP 500.
   */
  xml_available:   boolean;
  /**
   * true = fetched from /sco-query (HĐ có mã khởi tạo từ máy tính tiền — MTTTT).
   * false = fetched from /query (HĐ điện tử thông thường).
   */
  is_sco:          boolean;
  /**
   * Tính chất hóa đơn: 1 = hóa đơn thay thế, 2 = hóa đơn điều chỉnh, 0/null = gốc.
   * Derived from: shdgoc non-null → 1, else 0.
   */
  tc_hdon:         number | null;
  /** Ký hiệu hóa đơn bị thay thế/điều chỉnh (khhdon của hóa đơn gốc). */
  khhd_cl_quan:    string | null;
  /** Số hóa đơn bị thay thế/điều chỉnh (shdon của hóa đơn gốc). */
  so_hd_cl_quan:   string | null;
  /**
   * Ngày lập hóa đơn gốc (tdlhdgoc từ GDT).
   * Dùng phát hiện điều chỉnh cross-period cho [37]/[38].
   * null = không phải hóa đơn điều chỉnh.
   */
  original_invoice_date: string | null;
  /**
   * Phân loại thuế suất — dùng để phân bucket chỉ tiêu tờ khai 01/GTGT:
   *   'KCT'   = Không chịu thuế GTGT ([26])
   *   'KKKNT' = Không phải kê khai, tính nộp GTGT ([32a])
   *   '0'     = Thuế suất 0% / xuất khẩu ([29])
   *   '5'|'8'|'10' = thuế suất thông thường ([30]/[32])
   * null = chưa xác định
   */
  tax_category:    string | null;
  /**
   * Optional stable identity from source payload (e.g. GDT row id).
   * Used for in-memory dedup when invoice_number/serial/date are not unique enough.
   */
  source_row_key?: string | null;
}

export interface LineItem {
  line_number:     number | null;
  item_code:       string | null;
  item_name:       string | null;
  unit:            string | null;
  quantity:        number | null;
  unit_price:      number | null;
  subtotal:        number | null;
  vat_rate:        number | null;   // integer % (e.g. 8)
  vat_rate_label:  string | null;   // raw string from GDT (e.g. "KCT", "8%")
  vat_amount:      number | null;
  total:           number | null;
  discount_amount: number | null;   // stckhau — chiết khấu dòng
  discount_rate:   number | null;   // tlckhau — tỷ lệ chiết khấu (e.g. 0.05 = 5%)
  line_type:       number | null;   // tchat (1=hàng hóa, 2=dịch vụ)
  gdt_line_id:     string | null;   // id — UUID dòng từ GDT
  gdt_invoice_id:  string | null;   // idhdon — UUID hóa đơn từ GDT
}

// GDT invoice status codes (TTHThue field)
const STATUS_MAP: Record<number, RawInvoice['status']> = {
  1: 'valid',
  3: 'cancelled',
  4: 'replaced_original',  // original invoice superseded by a replacement
  5: 'replaced',
  6: 'adjusted',
};

export class GdtXmlParser {
  private parser: XMLParser;

  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes:   false,
      parseTagValue:      true,
      parseAttributeValue: true,
      trimValues:         true,
      isArray: (name) => name === 'HDon', // always treat HDon as array
    });
  }

  parse(buffer: Buffer, direction: 'output' | 'input'): RawInvoice[] {
    let obj: Record<string, unknown>;
    try {
      obj = this.parser.parse(buffer.toString('utf-8')) as Record<string, unknown>;
    } catch (err) {
      logger.error('[GdtXmlParser] XML parse error', { err });
      throw new Error('Invalid XML structure');
    }

    const invoices = this._findInvoices(obj);
    logger.debug('[GdtXmlParser] Found invoice nodes', { count: invoices.length });

    return invoices.map((inv, i) => this._mapInvoice(inv, direction, i)).filter(Boolean) as RawInvoice[];
  }

  private _findInvoices(root: unknown): unknown[] {
    if (root == null || typeof root !== 'object') return [];
    const rec = root as Record<string, unknown>;

    // Direct hit
    if ('HDon' in rec) {
      const v = rec['HDon'];
      return Array.isArray(v) ? v : [v];
    }

    // Recurse into children
    for (const k of Object.keys(rec)) {
      const found = this._findInvoices(rec[k]);
      if (found.length > 0) return found;
    }
    return [];
  }

  private _mapInvoice(
    node: unknown,
    direction: 'output' | 'input',
    index: number
  ): RawInvoice | null {
    if (node == null || typeof node !== 'object') return null;
    const inv = node as Record<string, unknown>;

    const ttchung = this._obj(inv, 'TTChung', 'ttchung', 'ttChung');
    const ndhdon  = this._obj(inv, 'NDHDon', 'ndhdon', 'ndHDon');
    const nban    = this._obj(inv, 'NBan', 'nban', 'nBan');
    const nmua    = this._obj(inv, 'NMua', 'nmua', 'nMua');

    if (!ttchung && !ndhdon) {
      logger.warn('[GdtXmlParser] Skipping malformed invoice node', { index });
      return null;
    }

    const statusRaw = this._num(ttchung, 'TTHThue', 'ttHThue', 'TTHD');
    const status: RawInvoice['status'] = (statusRaw != null && statusRaw in STATUS_MAP)
      ? STATUS_MAP[statusRaw]!
      : 'valid';

    return {
      invoice_number:  this._str(ttchung, 'SHDon', 'sHDon', 'sHdon'),
      invoice_date:    this._parseDate(this._val(ttchung, 'NLap', 'nLap', 'nlap')),
      direction,
      status,
      seller_name:     this._str(nban, 'Ten', 'ten'),
      seller_tax_code: this._str(nban, 'MST', 'mst'),
      buyer_name:      this._str(nmua, 'Ten', 'ten'),
      buyer_tax_code:  this._str(nmua, 'MST', 'mst'),
      total_amount:    this._num(ndhdon, 'TgTTTBSo', 'tgTTTBSo', 'TToan', 'tToan'),
      vat_amount:      this._num(ndhdon, 'TgTThue', 'tgTThue'),
      vat_rate:        this._normaliseVatRate(this._val(ndhdon, 'TSuat', 'tSuat')),
      serial_number:   this._str(ttchung, 'KHMSHDon', 'khMSHDon'),
      invoice_type:    this._str(ttchung, 'THDon', 'tHDon'),
      source:          'gdt_bot',
      gdt_validated:   true,
      // Invoices parsed directly from XML by definition have XML available
      xml_available:   true,
      // XML-parsed invoices come from direct upload, not sco-query endpoint
      is_sco:          false,
      // TT80/2021 replacement / adjustment fields
      tc_hdon:         this._num(ttchung, 'TCHDon', 'tcHDon', 'LHDCLQuan') ?? 0,
      khhd_cl_quan:    this._str(ttchung, 'KHHDCLQuan', 'KHHDon_goc', 'kHHDCLQuan'),
      so_hd_cl_quan:   this._str(ttchung, 'SHDCLQuan',  'SHDon_goc',  'sHDCLQuan'),
      tax_category:    this._extractTaxCategory(this._val(ndhdon, 'TSuat', 'tSuat')),
      original_invoice_date: null,
    };
  }

  // ── Access helpers ───────────────────────────────────────────────────────────

  private _obj(rec: Record<string, unknown> | null, ...keys: string[]): Record<string, unknown> | null {
    if (!rec) return null;
    for (const k of keys) {
      if (k in rec && rec[k] != null && typeof rec[k] === 'object') {
        return rec[k] as Record<string, unknown>;
      }
    }
    return null;
  }

  private _val(rec: Record<string, unknown> | null, ...keys: string[]): unknown {
    if (!rec) return null;
    for (const k of keys) {
      if (k in rec && rec[k] != null) return rec[k];
    }
    return null;
  }

  private _str(rec: Record<string, unknown> | null, ...keys: string[]): string | null {
    const v = this._val(rec, ...keys);
    return v != null ? String(v).trim() || null : null;
  }

  private _num(rec: Record<string, unknown> | null, ...keys: string[]): number | null {
    const v = this._val(rec, ...keys);
    if (v == null) return null;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
  }

  /**
   * Đọc giá trị từ cấu trúc <TTKhac><TTin><TTruong>fieldName</TTruong><DLieu>value</DLieu></TTin></TTKhac>.
   * Một số hóa đơn GDT/Viettel ghi VATAmount và Amount per-line vào TTKhac thay vì tag trực tiếp.
   */
  private _ttkhacVal(r: Record<string, unknown>, fieldName: string): number | null {
    const ttkhac = this._val(r, 'TTKhac', 'tTKhac', 'ttKhac');
    if (!ttkhac || typeof ttkhac !== 'object') return null;
    const ttinRaw = (ttkhac as Record<string, unknown>)['TTin'] ?? (ttkhac as Record<string, unknown>)['tTin'];
    if (!ttinRaw) return null;
    const ttinArr: unknown[] = Array.isArray(ttinRaw) ? ttinRaw : [ttinRaw];
    for (const item of ttinArr) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const truong = this._str(rec, 'TTruong', 'tTruong');
      if (truong === fieldName) return this._num(rec, 'DLieu', 'dLieu');
    }
    return null;
  }

  private _parseDate(raw: unknown): string | null {
    if (raw == null) return null;
    const s = String(raw).trim();
    // ISO 2024-01-15 or 2024-01-15T00:00:00
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    // DD/MM/YYYY
    const vn = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
    if (vn) return `${vn[3]}-${vn[2]}-${vn[1]}`;
    // YYYYMMDD
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    return null;
  }

  private _normaliseVatRate(raw: unknown): string | null {
    if (raw == null) return null;
    const s = String(raw).trim().toUpperCase();
    if (s === 'KCT' || s === 'KKKTT' || s === '0' || s === '0%') return '0%';
    if (s === '5' || s === '5%') return '5%';
    if (s === '8' || s === '8%') return '8%';
    if (s === '10' || s === '10%') return '10%';
    return s.toLowerCase() || null;
  }

  private _extractTaxCategory(raw: unknown): string | null {
    if (raw == null) return null;
    const s = String(raw).trim().toUpperCase().replace('%', '');
    if (s === 'KCT') return 'KCT';
    if (s === 'KKKNT' || s === 'KKKTT') return 'KKKNT';
    if (s === '0') return '0';
    if (s === '5') return '5';
    if (s === '8') return '8';
    if (s === '10') return '10';
    return null;
  }

  /**
   * Parse line items (mặt hàng) from a single-invoice buffer.
   *
   * The export-xml endpoint returns a ZIP archive containing invoice.xml (+ html, images, etc.).
   * This method auto-detects ZIP (PK magic bytes) and extracts invoice.xml before parsing.
   *
   * Single-invoice XML structure:
   *   <HDon><DLHDon><TTChung/><NDHDon><DSHHDVu><HHDVu/></DSHHDVu></NDHDon></DLHDon></HDon>
   *
   * Returns [] if the buffer is not parseable or has no line item data.
   */
  parseLineItems(buffer: Buffer): LineItem[] {
    // Step 1: If the buffer is a ZIP archive, extract invoice.xml from it
    const xmlBuffer = this._extractXmlFromZip(buffer) ?? buffer;

    let obj: Record<string, unknown>;
    try {
      obj = this.parser.parse(xmlBuffer.toString('utf-8')) as Record<string, unknown>;
    } catch {
      return [];
    }

    // Find first invoice node
    const invoices = this._findInvoices(obj);
    if (invoices.length === 0) return [];
    const inv = invoices[0] as Record<string, unknown>;

    // Single-invoice XML wraps content in DLHDon:
    //   inv = { DLHDon: { TTChung, NDHDon }, DLQRCode, ... }
    // Bulk XML has NDHDon directly in inv.
    // Try both layouts.
    const payload: Record<string, unknown> =
      (this._obj(inv, 'DLHDon', 'dLHDon', 'dlhdon') as Record<string, unknown> | null) ?? inv;

    const ndhdon = this._obj(payload, 'NDHDon', 'ndhdon', 'ndHDon');
    if (!ndhdon) return [];

    // DSHHDVu may be an array or single object depending on parser config
    const dshhd = ndhdon['DSHHDVu'] ?? ndhdon['dSHHDVu'] ?? ndhdon['dsHHDVu'];
    if (!dshhd || typeof dshhd !== 'object') return [];

    const hhdvu = (dshhd as Record<string, unknown>)['HHDVu'] ??
                  (dshhd as Record<string, unknown>)['hHDVu'];
    if (!hhdvu) return [];

    const rows = Array.isArray(hhdvu) ? hhdvu : [hhdvu];

    return rows.map((row, idx): LineItem => {
      const r = row as Record<string, unknown>;

      // Normalise VAT rate to numeric (e.g. "10%" → 10)
      const vatRateRaw = this._val(r, 'TSuat', 'tSuat', 'TsT');
      const vatRateNum = (() => {
        if (vatRateRaw == null) return null;
        const s = String(vatRateRaw).replace('%', '').trim();
        if (s === 'KCT' || s === 'KKKTT' || s === '') return 0;
        const n = parseFloat(s);
        return isNaN(n) ? null : n;
      })();

      return {
        line_number:    this._num(r, 'STT', 'stt') ?? idx + 1,
        item_code:      this._str(r, 'MHHDVu', 'mHHDVu', 'MHH', 'ma_hh'),
        item_name:      this._str(r, 'THHDVu', 'tHHDVu', 'Ten', 'ten_hh'),
        unit:           this._str(r, 'DVTinh', 'dVTinh', 'dvt'),
        quantity:       this._num(r, 'SLuong', 'sLuong', 'so_luong'),
        unit_price:     this._num(r, 'DGia', 'dGia', 'don_gia'),
        subtotal:       this._num(r, 'ThTien', 'thTien', 'thanh_tien'),
        vat_rate:       vatRateNum,
        vat_rate_label: vatRateRaw != null ? String(vatRateRaw) : null,
        vat_amount:     this._num(r, 'TienThue', 'tienThue', 'tien_thue') ?? this._ttkhacVal(r, 'VATAmount'),
        // 'Amount' (TTKhac) = tổng tiền thanh toán per-line (subtotal + VAT)
        total:          this._ttkhacVal(r, 'Amount') ?? this._num(r, 'TgTTTBSo', 'tgTTTBSo', 'TToan', 'tToan'),
        discount_amount: null,
        discount_rate:   null,
        line_type:       null,
        gdt_line_id:     null,
        gdt_invoice_id:  null,
      };
    }).filter(item => item.item_name != null);
  }

  // ── ZIP extraction helper ────────────────────────────────────────────────────

  /**
   * The GDT export-xml endpoint returns a ZIP archive, not raw XML.
   * The ZIP contains invoice.xml (the signed e-invoice), invoice.html, images, and JS.
   *
   * The ZIP uses data descriptors (bit 3 in general-purpose flag) which means the
   * compressed size in each local file header is ZERO — the real sizes are only in
   * the ZIP Central Directory at the end of the file. This method reads the Central
   * Directory first, then extracts invoice.xml using the correct offsets.
   *
   * Supports ZIP compression methods:
   *   0 = stored (no compression)
   *   8 = deflate (raw DEFLATE via zlib.inflateRawSync)
   *
   * Returns null if the buffer is not a ZIP or does not contain invoice.xml.
   */
  private _extractXmlFromZip(buffer: Buffer): Buffer | null {
    // ZIP magic: PK\x03\x04 = 0x04034b50
    if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return null;

    // ── Step 1: Find End of Central Directory (EOCD) ──────────────────────────
    // EOCD signature: PK\x05\x06 = 0x06054b50
    // Located at the end of the file (before optional comment)
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) return null;

    const cdOffset = buffer.readUInt32LE(eocdOffset + 16); // start of central directory
    const cdSize   = buffer.readUInt32LE(eocdOffset + 12); // size of central directory

    // ── Step 2: Walk Central Directory ────────────────────────────────────────
    // Central directory file header signature: PK\x01\x02 = 0x02014b50
    let cdPos = cdOffset;
    const cdEnd = cdOffset + cdSize;

    while (cdPos + 46 <= cdEnd) {
      if (buffer.readUInt32LE(cdPos) !== 0x02014b50) break;

      const compressionMethod  = buffer.readUInt16LE(cdPos + 10);
      const compressedSize     = buffer.readUInt32LE(cdPos + 20);
      const fileNameLen        = buffer.readUInt16LE(cdPos + 28);
      const extraFieldLen      = buffer.readUInt16LE(cdPos + 30);
      const fileCommentLen     = buffer.readUInt16LE(cdPos + 32);
      const localHeaderOffset  = buffer.readUInt32LE(cdPos + 42);

      const fileName = buffer.slice(cdPos + 46, cdPos + 46 + fileNameLen).toString('utf-8');
      cdPos += 46 + fileNameLen + extraFieldLen + fileCommentLen;

      if (fileName !== 'invoice.xml') continue;

      // ── Step 3: Read local file header to find data start ─────────────────
      // Local file header: PK\x03\x04, offsets 26=fnLen, 28=extraLen
      if (localHeaderOffset + 30 > buffer.length) return null;
      const localFnLen    = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart     = localHeaderOffset + 30 + localFnLen + localExtraLen;
      const dataEnd       = dataStart + compressedSize;

      if (dataEnd > buffer.length) return null;

      const data = buffer.slice(dataStart, dataEnd);
      if (compressionMethod === 0) return data;   // stored
      if (compressionMethod === 8) {
        try { return zlib.inflateRawSync(data); } catch { return null; }
      }
      return null; // unsupported compression
    }
    return null;
  }
}
