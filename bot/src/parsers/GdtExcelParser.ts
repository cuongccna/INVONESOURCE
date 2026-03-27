/**
 * BOT-04 — GDT Excel Parser
 *
 * Parses Excel (.xlsx / .xls) exports from hoadondientu.gdt.gov.vn.
 * Uses flexible column header matching — never hardcodes column indices.
 * Handles Excel serial dates and Vietnamese column names.
 * source='gdt_bot', has_line_items=false (Excel does not include line items).
 */
import * as XLSX from 'xlsx';
import { RawInvoice } from './GdtXmlParser';
import { logger } from '../logger';

// Vietnamese column header → internal field mapping
// Match by substring include (case-insensitive)
const HEADER_PATTERNS: Array<[string, keyof RawInvoice]> = [
  ['số hóa đơn',           'invoice_number'],
  ['số hd',                'invoice_number'],
  ['ký hiệu hóa đơn',      'serial_number'],
  ['ký hiệu',              'serial_number'],
  ['ngày hóa đơn',         'invoice_date'],
  ['ngày lập',             'invoice_date'],
  ['tên người bán',        'seller_name'],
  ['người bán',            'seller_name'],
  ['mst người bán',        'seller_tax_code'],
  ['mst nb',               'seller_tax_code'],
  ['tên người mua',        'buyer_name'],
  ['người mua',            'buyer_name'],
  ['mst người mua',        'buyer_tax_code'],
  ['mst nm',               'buyer_tax_code'],
  ['tổng tiền thanh toán', 'total_amount'],
  ['tổng cộng',            'total_amount'],
  ['tiền thuế',            'vat_amount'],
  ['thuế gtgt',            'vat_amount'],
  ['thuế suất',            'vat_rate'],
  ['trạng thái',           'status'],
];

export class GdtExcelParser {
  parse(buffer: Buffer, direction: 'output' | 'input'): RawInvoice[] {
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('Empty workbook');

    const ws = wb.Sheets[sheetName]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null, raw: true });

    if (rows.length === 0) {
      logger.warn('[GdtExcelParser] Empty sheet');
      return [];
    }

    // Build column map from first row's keys
    const firstRow = rows[0]!;
    const colMap   = this._buildColMap(Object.keys(firstRow));

    logger.debug('[GdtExcelParser] Column map', { colMap });

    const results: RawInvoice[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const inv = this._mapRow(row, colMap, direction, i);
      if (inv) results.push(inv);
    }

    logger.info('[GdtExcelParser] Parsed', { count: results.length, direction });
    return results;
  }

  private _buildColMap(keys: string[]): Record<string, keyof RawInvoice> {
    const map: Record<string, keyof RawInvoice> = {};
    for (const key of keys) {
      const keyNorm = key.toLowerCase().normalize('NFC').trim();
      for (const [pattern, field] of HEADER_PATTERNS) {
        if (keyNorm.includes(pattern)) {
          if (!(field in Object.values(map))) {
            map[key] = field;
          }
          break;
        }
      }
    }
    return map;
  }

  private _mapRow(
    row:       Record<string, unknown>,
    colMap:    Record<string, keyof RawInvoice>,
    direction: 'output' | 'input',
    rowIndex:  number
  ): RawInvoice | null {
    const get = <T>(field: keyof RawInvoice): T | null => {
      const key = Object.entries(colMap).find(([, f]) => f === field)?.[0];
      return key ? (row[key] as T) : null;
    };

    const invoiceNumber = this._str(get('invoice_number'));
    if (!invoiceNumber) {
      // Skip clearly blank rows (e.g. totals row at bottom)
      if (rowIndex > 0) logger.debug('[GdtExcelParser] Skip blank row', { rowIndex });
      return null;
    }

    const statusRaw = this._str(get('status'));
    const status   = this._parseStatus(statusRaw);

    return {
      invoice_number:  invoiceNumber,
      invoice_date:    this._parseDate(get('invoice_date')),
      direction,
      status,
      seller_name:     this._str(get('seller_name')),
      seller_tax_code: this._str(get('seller_tax_code')),
      buyer_name:      this._str(get('buyer_name')),
      buyer_tax_code:  this._str(get('buyer_tax_code')),
      total_amount:    this._num(get('total_amount')),
      vat_amount:      this._num(get('vat_amount')),
      vat_rate:        this._normaliseVatRate(get('vat_rate')),
      serial_number:   this._str(get('serial_number')),
      invoice_type:    null,
      source:          'gdt_bot',
      gdt_validated:   true,
    };
  }

  private _str(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s || null;
  }

  private _num(v: unknown): number | null {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? null : n;
  }

  private _parseDate(raw: unknown): string | null {
    if (raw == null) return null;
    // Excel serial date
    if (typeof raw === 'number') {
      const d = XLSX.SSF.parse_date_code(raw);
      if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    const s = String(raw).trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const vn = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
    if (vn) return `${vn[3]}-${vn[2]}-${vn[1]}`;
    return null;
  }

  private _parseStatus(raw: string | null): RawInvoice['status'] {
    if (!raw) return 'valid';
    const s = raw.toLowerCase();
    if (s.includes('hủy') || s.includes('cancel') || s === '3') return 'cancelled';
    if (s.includes('thay thế') || s === '5') return 'replaced';
    if (s.includes('điều chỉnh') || s === '6') return 'adjusted';
    return 'valid';
  }

  private _normaliseVatRate(raw: unknown): string | null {
    if (raw == null) return null;
    const s = String(raw).trim().toUpperCase();
    if (s === 'KCT' || s === 'KKKTT' || s === '0' || s === '0%') return '0%';
    if (s === '5' || s === '5%') return '5%';
    if (s === '8' || s === '8%') return '8%';
    if (s === '10' || s === '10%') return '10%';
    return null;
  }
}
