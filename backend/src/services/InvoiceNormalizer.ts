import { NormalizedInvoice, InvoiceStatus } from 'shared';
import { parseInvoiceSerial } from '../utils/InvoiceSerialParser';

/**
 * InvoiceNormalizer — normalizes raw invoice data from different providers
 * into a unified NormalizedInvoice schema.
 *
 * Handles field name differences:
 * - BKAV: ArisingDate (may be string or epoch ms)
 * - MISA: invoiceDate (ISO string)
 * - Viettel: arisingDate (milliseconds!)
 * - VAT rate: 0.1 / 10 / "10%" → normalize to number (10)
 *
 * GROUP 47: Also parses serial number to set invoice_group, serial_has_cqt, has_line_items.
 */
export class InvoiceNormalizer {
  /**
   * Normalize from MISA meInvoice raw JSON
   */
  static fromMisa(raw: Record<string, unknown>, direction: 'output' | 'input'): NormalizedInvoice {
    return InvoiceNormalizer.enrichWithSerialInfo({
      externalId: InvoiceNormalizer.str(raw['invoiceId'] ?? raw['id']),
      invoiceNumber: InvoiceNormalizer.str(raw['invoiceNumber'] ?? raw['refId']),
      serialNumber: InvoiceNormalizer.str(raw['serialNumber'] ?? raw['symbol']),
      issuedDate: InvoiceNormalizer.date(raw['invoiceDate'] ?? raw['arisingDate']),
      sellerTaxCode: InvoiceNormalizer.str(raw['sellerTaxCode'] ?? raw['sellerCode']),
      sellerName: InvoiceNormalizer.str(raw['sellerName']),
      buyerTaxCode: InvoiceNormalizer.str(raw['buyerTaxCode'] ?? raw['buyerCode']),
      buyerName: InvoiceNormalizer.str(raw['buyerName']),
      subtotal: InvoiceNormalizer.num(raw['total'] ?? raw['originalAmountWithoutVAT']),
      vatRate: InvoiceNormalizer.vatRate(raw['vatRate'] ?? raw['vatPercentage']),
      vatAmount: InvoiceNormalizer.num(raw['vatAmount'] ?? raw['originalVATAmount']),
      total: InvoiceNormalizer.num(raw['totalAmount'] ?? raw['originalAmount']),
      currency: InvoiceNormalizer.str(raw['currencyCode']) || 'VND',
      status: InvoiceNormalizer.misaStatus(InvoiceNormalizer.str(raw['invoiceStatus'] ?? raw['status'])),
      direction,
      rawXml: typeof raw['xmlContent'] === 'string' ? raw['xmlContent'] : undefined,
      source: 'misa',
    });
  }

  /**
   * Normalize from Viettel SInvoice raw JSON
   * ⚠️ Viettel dates are in MILLISECONDS
   */
  static fromViettel(raw: Record<string, unknown>, direction: 'output' | 'input'): NormalizedInvoice {
    return InvoiceNormalizer.enrichWithSerialInfo({
      externalId: InvoiceNormalizer.str(raw['invoiceNo'] ?? raw['transactionID']),
      invoiceNumber: InvoiceNormalizer.str(raw['invoiceNo'] ?? raw['transactionID']),
      serialNumber: InvoiceNormalizer.str(raw['serialNo'] ?? raw['templateCode']),
      // Viettel dates are in milliseconds
      issuedDate: InvoiceNormalizer.date(raw['arisingDate'] ?? raw['invoiceDate']),
      sellerTaxCode: InvoiceNormalizer.str(raw['sellerTaxCode'] ?? raw['supplierTaxCode']),
      sellerName: InvoiceNormalizer.str(raw['sellerName'] ?? raw['supplierName']),
      buyerTaxCode: InvoiceNormalizer.str(raw['buyerTaxCode'] ?? raw['customerTaxCode']),
      buyerName: InvoiceNormalizer.str(raw['buyerName'] ?? raw['customerName']),
      subtotal: InvoiceNormalizer.num(raw['totalAmountWithoutVAT'] ?? raw['totalAmount']),
      vatRate: InvoiceNormalizer.vatRate(raw['vatRate'] ?? raw['vatPercentage']),
      vatAmount: InvoiceNormalizer.num(raw['totalVATAmount'] ?? raw['vatAmount']),
      total: InvoiceNormalizer.num(raw['totalAmount'] ?? raw['paymentAmount']),
      currency: InvoiceNormalizer.str(raw['currencyCode']) || 'VND',
      status: InvoiceNormalizer.viettelStatus(InvoiceNormalizer.str(raw['invoiceStatus'] ?? '')),
      direction,
      source: 'viettel',
    });
  }

  /**
   * Normalize from BKAV eInvoice raw JSON
   * GDT validation is handled internally — gdt_validated defaults true
   */
  static fromBkav(raw: Record<string, unknown>, direction: 'output' | 'input'): NormalizedInvoice {
    return InvoiceNormalizer.enrichWithSerialInfo({
      externalId: InvoiceNormalizer.str(raw['id'] ?? raw['invoiceId']),
      invoiceNumber: InvoiceNormalizer.str(raw['invoiceNumber'] ?? raw['soHoaDon']),
      serialNumber: InvoiceNormalizer.str(raw['serialNumber'] ?? raw['kyHieu']),
      issuedDate: InvoiceNormalizer.date(raw['ArisingDate'] ?? raw['arisingDate'] ?? raw['issuedDate']),
      sellerTaxCode: InvoiceNormalizer.str(raw['sellerTaxCode'] ?? raw['mstNguoiBan']),
      sellerName: InvoiceNormalizer.str(raw['sellerName'] ?? raw['tenNguoiBan']),
      buyerTaxCode: InvoiceNormalizer.str(raw['buyerTaxCode'] ?? raw['mstNguoiMua']),
      buyerName: InvoiceNormalizer.str(raw['buyerName'] ?? raw['tenNguoiMua']),
      subtotal: InvoiceNormalizer.num(raw['totalAmountWithoutVAT'] ?? raw['tienHangHoaDichVu']),
      vatRate: InvoiceNormalizer.vatRate(raw['vatRate'] ?? raw['thueSuatGTGT']),
      vatAmount: InvoiceNormalizer.num(raw['vatAmount'] ?? raw['tienThueGTGT']),
      total: InvoiceNormalizer.num(raw['totalAmount'] ?? raw['tongTienThanhToan']),
      currency: InvoiceNormalizer.str(raw['currency']) || 'VND',
      status: InvoiceNormalizer.bkavStatus(InvoiceNormalizer.str(raw['status'] ?? raw['trangThai'] ?? '')),
      direction,
      source: 'bkav',
    });
  }

  // ============================================================
  // Private helpers
  // ============================================================

  static str(val: unknown): string {
    if (typeof val === 'string') return val.trim();
    if (val === null || val === undefined) return '';
    return String(val).trim();
  }

  static num(val: unknown): number {
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const n = parseFloat(val.replace(/,/g, ''));
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  static date(val: unknown): Date {
    if (val instanceof Date) return val;
    if (typeof val === 'number') return new Date(val);
    if (typeof val === 'string') {
      const d = new Date(val);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  /**
   * Normalize VAT rate:
   * - 0.1 → 10
   * - 10 → 10
   * - "10%" → 10
   * - "KCTGT" / exempt → 0
   */
  static vatRate(val: unknown): number {
    if (typeof val === 'number') {
      if (val <= 0) return 0;
      return val <= 1 ? Math.round(val * 100) : val;
    }
    if (typeof val === 'string') {
      const cleaned = val.replace('%', '').trim().toUpperCase();
      if (['KCTGT', 'KCT', ''].includes(cleaned)) return 0;
      const n = parseFloat(cleaned);
      if (!isNaN(n)) return n <= 1 ? Math.round(n * 100) : n;
    }
    return 0;
  }

  static misaStatus(status: string): InvoiceStatus {
    const map: Record<string, InvoiceStatus> = {
      '1': 'valid', 'valid': 'valid', 'active': 'valid',
      '2': 'cancelled', 'cancelled': 'cancelled', 'huy': 'cancelled',
      '3': 'replaced', 'replaced': 'replaced',
      '4': 'adjusted', 'adjusted': 'adjusted',
      '5': 'invalid', 'invalid': 'invalid',
    };
    return map[status.toLowerCase()] ?? 'valid';
  }

  static viettelStatus(status: string): InvoiceStatus {
    const map: Record<string, InvoiceStatus> = {
      '1': 'valid', 'valid': 'valid', 'signed': 'valid',
      '2': 'replaced', 'replaced': 'replaced',
      '3': 'adjusted', 'adjusted': 'adjusted',
      '4': 'cancelled', '5': 'cancelled', 'cancelled': 'cancelled',
    };
    return map[status.toLowerCase()] ?? 'valid';
  }

  static bkavStatus(status: string): InvoiceStatus {
    const map: Record<string, InvoiceStatus> = {
      '1': 'valid', 'valid': 'valid', 'signed': 'valid',
      '2': 'cancelled', 'cancelled': 'cancelled', 'huy': 'cancelled',
      '3': 'replaced', 'replaced': 'replaced', 'thayte': 'replaced',
      '4': 'adjusted', 'adjusted': 'adjusted', 'dieuchinH': 'adjusted',
    };
    return map[status.toLowerCase()] ?? 'valid';
  }

  /**
   * GROUP 47: Enrich a normalized invoice with serial number classification.
   * Parses serial_number to determine invoice_group (5/6/8), serial_has_cqt, has_line_items.
   * Also corrects is_sco: any MTT invoice (group 8) must have is_sco=true regardless of
   * which endpoint it was fetched from (C26MED fetched via /query still = SCO/MTT).
   */
  static enrichWithSerialInfo(inv: NormalizedInvoice): NormalizedInvoice {
    const parsed = parseInvoiceSerial(inv.serialNumber);
    inv.invoiceGroup = parsed.invoiceGroup;
    inv.serialHasCqt = parsed.hasCqtCode;
    inv.hasLineItems = parsed.isDetailAvailable;
    return inv;
  }
}
