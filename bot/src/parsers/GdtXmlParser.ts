/**
 * BOT-03 — GDT XML Parser
 *
 * Parses TT78/2021 / TT80/2021 XML format from hoadondientu.gdt.gov.vn.
 *
 * XML structure (simplified):
 *   <TDiep>
 *     <DLieu>
 *       <TBao>
 *         <DLHDon>
 *           <DSHDon>
 *             <HDon>
 *               <TTChung> SHDon, NLap, TTHThue, ... </TTChung>
 *               <NDHDon>  TSuat, TgTThue, TgTTTBSo, ... </NDHDon>
 *               <NBan>    Ten, MST </NBan>
 *               <NMua>    Ten, MST </NMua>
 *             </HDon>
 *           </DSHDon>
 *         </DLHDon>
 *       </TBao>
 *     </DLieu>
 *   </TDiep>
 *
 * Both camelCase and PascalCase variants are handled.
 */
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../logger';

export interface RawInvoice {
  invoice_number:  string | null;
  invoice_date:    string | null;
  direction:       'output' | 'input';
  status:          'valid' | 'cancelled' | 'replaced' | 'adjusted';
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
}

// GDT invoice status codes (TTHThue field)
const STATUS_MAP: Record<number, RawInvoice['status']> = {
  1: 'valid',
  3: 'cancelled',
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
}
