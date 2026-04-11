/**
 * gdtXmlParser.ts
 *
 * Parses GDT XML invoice format (HDon/DLHDon per Thông tư 78/2021) into
 * a structured JSON object preserving ALL fields from the original XML.
 *
 * Also provides:
 *   extractContentHash(xmlString)  — MD5 hash of raw XML for change detection
 *   extractMaCqt(xmlString)        — Quick MCCQT extraction without full parse
 *
 * Does NOT modify any existing parser or invoices table logic.
 */

import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GdtTTKhac {
  ttruong: string;  // Tên trường
  dlieu: string;    // Dữ liệu
  kdlieu: string;   // Kiểu dữ liệu
}

export interface GdtLineItem {
  tchat: number;        // Tính chất (1=hàng hóa, 2=dịch vụ…)
  stt: number;
  mhhdvu: string;
  thhdvu: string;       // Tên hàng hóa dịch vụ
  dvtinh: string;
  sluong: number;
  dgia: number;
  tl_ckhau: string;
  st_ckhau: number;
  th_tien: number;      // Thành tiền chưa thuế
  tsuat: string;        // Thuế suất
  t_thue: number;       // Tiền thuế
  tt_khac: GdtTTKhac[];
}

export interface GdtInvoiceJson {
  // TTChung (Thông tin chung)
  pban: string;
  ten_hdon: string;
  khmshhdon: string;
  khhdon: string;
  shdon: string;
  ngay_lap: string;        // ISO date (YYYY-MM-DD)
  dvt_te: string;
  tgia: number;
  htt_toan: string;
  mst_tcgp: string;
  hdcttchinh: number;
  tt_khac_chung: GdtTTKhac[];

  // NBan (Người bán)
  nban: {
    ten: string;
    mst: string;
    dchi: string;
    sdthoai: string;
    dctdtu: string;
    stk_nhang: string;
    ten_nhang: string;
    tt_khac: GdtTTKhac[];
  };

  // NMua (Người mua)
  nmua: {
    ten: string;
    mst: string;
    dchi: string;
    mk_hang: string;
    sdthoai: string;
    dctdtu: string;
    hvtn_mhang: string;
    stk_nhang: string;
    ten_nhang: string;
    tt_khac: GdtTTKhac[];
  };

  // DSHHDVu (Danh sách hàng hóa dịch vụ)
  ds_hhdvu: GdtLineItem[];

  // TToan (Thanh toán)
  ttoan: {
    thttt_ltsuat: Array<{ tsuat: string; t_thue: number; th_tien: number }>;
    tgt_cthue: number;
    tgt_thue: number;
    ttcktmai: number;
    tgtttt_bso: number;
    tgtttt_bchu: string;
    tt_khac: GdtTTKhac[];
  };

  // MCCQT — mã cơ quan thuế (unique GDT ID)
  ma_cqt: string;

  // Signing timestamps
  thoi_gian_ky_nban: string;
  thoi_gian_ky_cqt: string;
}

// ─── Parser instance (configured once, reused) ───────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
  isArray: (tagName) => {
    // Always treat these as arrays even when only one element exists
    return ['HHDVu', 'TTin', 'LTSuat', 'HDon'].includes(tagName);
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function num(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(String(value).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function mapTTKhac(raw: unknown): GdtTTKhac[] {
  if (!raw) return [];
  const container = raw as Record<string, unknown>;
  const items = container['TTin'];
  if (!items) return [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map((item: unknown) => {
    const it = item as Record<string, unknown>;
    return {
      ttruong: str(it['TTruong']),
      dlieu:   str(it['DLieu']),
      kdlieu:  str(it['KDLieu']),
    };
  });
}

function mapLineItems(raw: unknown): GdtLineItem[] {
  if (!raw) return [];
  const container = raw as Record<string, unknown>;
  const items = container['HHDVu'];
  if (!items) return [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map((item: unknown) => {
    const it = item as Record<string, unknown>;
    return {
      tchat:    num(it['TChat']),
      stt:      num(it['STT']),
      mhhdvu:   str(it['MHHDVu']),
      thhdvu:   str(it['THHDVu']),
      dvtinh:   str(it['DVTinh']),
      sluong:   num(it['SLuong']),
      dgia:     num(it['DGia']),
      tl_ckhau: str(it['TLCKhau']),
      st_ckhau: num(it['STCKhau']),
      th_tien:  num(it['ThTien']),
      tsuat:    str(it['TSuat']),
      t_thue:   num(it['TThue']),
      tt_khac:  mapTTKhac(it['TTKhac']),
    };
  });
}

function mapLTSuat(raw: unknown): Array<{ tsuat: string; t_thue: number; th_tien: number }> {
  if (!raw) return [];
  const container = raw as Record<string, unknown>;
  const items = container['LTSuat'];
  if (!items) return [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map((item: unknown) => {
    const it = item as Record<string, unknown>;
    return {
      tsuat:   str(it['TSuat']),
      t_thue:  num(it['TThue']),
      th_tien: num(it['ThTien']),
    };
  });
}

function extractSigningTime(dscks: unknown, sigId: 'seller' | 'cqt'): string {
  if (!dscks) return '';
  try {
    const d = dscks as Record<string, unknown>;
    const sigNode = sigId === 'seller'
      ? (d['NBan'] as Record<string, unknown> | undefined)
      : (d['CQT'] as Record<string, unknown> | undefined);
    if (!sigNode) return '';
    const sig = sigNode['Signature'] as Record<string, unknown> | undefined;
    if (!sig) return '';
    // Object can have multiple Object children; find the one with SignatureProperties
    const obj = sig['Object'] as unknown;
    const objArr = Array.isArray(obj) ? obj : [obj];
    for (const o of objArr) {
      const oo = o as Record<string, unknown>;
      const sp = oo['SignatureProperties'] as Record<string, unknown> | undefined;
      if (!sp) continue;
      const spProp = sp['SignatureProperty'] as Record<string, unknown> | undefined;
      if (spProp) return str(spProp['SigningTime']);
    }
    return '';
  } catch {
    return '';
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a GDT HDon XML string into a structured GdtInvoiceJson object.
 * All fields are preserved. Missing fields return empty string / 0 / [].
 */
export function parseGdtXmlToJson(xmlString: string): GdtInvoiceJson {
  const root = xmlParser.parse(xmlString) as Record<string, unknown>;

  // Navigate: HDon > DLHDon
  const hdon = (root['HDon'] ?? root) as Record<string, unknown>;
  const dlhdon = (hdon['DLHDon'] ?? {}) as Record<string, unknown>;

  // TTChung
  const ttchung = (dlhdon['TTChung'] ?? {}) as Record<string, unknown>;

  // NDHDon
  const ndhdon = (dlhdon['NDHDon'] ?? {}) as Record<string, unknown>;
  const nban   = (ndhdon['NBan']   ?? {}) as Record<string, unknown>;
  const nmua   = (ndhdon['NMua']   ?? {}) as Record<string, unknown>;
  const ttoan  = (ndhdon['TToan']  ?? {}) as Record<string, unknown>;
  const dshhdvu = ndhdon['DSHHDVu'];

  // MCCQT — can appear as element value or as @_Id attribute wrapper
  let maCqt = '';
  const mccqtRaw = hdon['MCCQT'];
  if (typeof mccqtRaw === 'string' || typeof mccqtRaw === 'number') {
    maCqt = str(mccqtRaw);
  } else if (mccqtRaw && typeof mccqtRaw === 'object') {
    // fast-xml-parser wraps element with attributes as { '@_Id': '...', '#text': '...' }
    maCqt = str((mccqtRaw as Record<string, unknown>)['#text']);
  }

  const dscks = hdon['DSCKS'];

  return {
    // TTChung
    pban:           str(ttchung['PBan']),
    ten_hdon:       str(ttchung['THDon']),
    khmshhdon:      str(ttchung['KHMSHDon']),
    khhdon:         str(ttchung['KHHDon']),
    shdon:          str(ttchung['SHDon']),
    ngay_lap:       str(ttchung['NLap']),
    dvt_te:         str(ttchung['DVTTe']),
    tgia:           num(ttchung['TGia']),
    htt_toan:       str(ttchung['HTTToan']),
    mst_tcgp:       str(ttchung['MSTTCGP']),
    hdcttchinh:     num(ttchung['HDCTTChinh']),
    tt_khac_chung:  mapTTKhac(ttchung['TTKhac']),

    // NBan
    nban: {
      ten:      str(nban['Ten']),
      mst:      str(nban['MST']),
      dchi:     str(nban['DChi']),
      sdthoai:  str(nban['SDThoai']),
      dctdtu:   str(nban['DCTDTu']),
      stk_nhang: str(nban['STKNHang']),
      ten_nhang: str(nban['TNHang']),
      tt_khac:  mapTTKhac(nban['TTKhac']),
    },

    // NMua
    nmua: {
      ten:       str(nmua['Ten']),
      mst:       str(nmua['MST']),
      dchi:      str(nmua['DChi']),
      mk_hang:   str(nmua['MKHang']),
      sdthoai:   str(nmua['SDThoai']),
      dctdtu:    str(nmua['DCTDTu']),
      hvtn_mhang: str(nmua['HVTNMHang']),
      stk_nhang: str(nmua['STKNHang']),
      ten_nhang: str(nmua['TNHang']),
      tt_khac:   mapTTKhac(nmua['TTKhac']),
    },

    // DSHHDVu
    ds_hhdvu: mapLineItems(dshhdvu),

    // TToan
    ttoan: {
      thttt_ltsuat: mapLTSuat(ttoan['THTTLTSuat']),
      tgt_cthue:    num(ttoan['TgTCThue']),
      tgt_thue:     num(ttoan['TgTThue']),
      ttcktmai:     num(ttoan['TTCKTMai']),
      tgtttt_bso:   num(ttoan['TgTTTBSo']),
      tgtttt_bchu:  str(ttoan['TgTTTBChu']),
      tt_khac:      mapTTKhac(ttoan['TTKhac']),
    },

    // MCCQT
    ma_cqt: maCqt,

    // Signing timestamps
    thoi_gian_ky_nban: extractSigningTime(dscks, 'seller'),
    thoi_gian_ky_cqt:  extractSigningTime(dscks, 'cqt'),
  };
}

/**
 * Compute MD5 hash of the raw XML string (before parsing).
 * Used for change detection: identical XML → identical hash.
 */
export function extractContentHash(xmlString: string): string {
  return createHash('md5').update(xmlString, 'utf8').digest('hex');
}

/**
 * Quick extraction of the MCCQT value from XML without full parse.
 * Uses regex for performance — avoids spinning up the full XML parser
 * just to check the unique GDT invoice ID.
 */
export function extractMaCqt(xmlString: string): string {
  const match = /<MCCQT[^>]*>([^<]+)<\/MCCQT>/.exec(xmlString);
  return match ? match[1].trim() : '';
}
