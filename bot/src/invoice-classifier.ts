/**
 * PROMPT 2 — Invoice Classifier
 *
 * Classifies GDT invoices by status, process type, and tax usability.
 * Uses config-driven field resolution — never hardcodes field names.
 */

import type { GdtConfig } from './gdt-config';
import { resolveField, resolveNumber, resolveString } from './gdt-config';
import { logger } from './logger';

// ─── PART 1: Types ───────────────────────────────────────────────────────────

export enum InvoiceStatus {
  VALID             = 'valid',
  CANCELLED         = 'cancelled',
  REPLACED_ORIGINAL = 'replaced_original',
  REPLACED          = 'replaced',
  ADJUSTED          = 'adjusted',
}

export enum InvoiceProcessType {
  CO_MA         = 'co_ma',           // ttxly=5: có mã CQT
  KHONG_MA      = 'khong_ma',        // ttxly=6: không mã, không có XML
  MAY_TINH_TIEN = 'may_tinh_tien',   // ttxly=8: máy tính tiền
}

export interface OriginalInvoiceRef {
  serial: string;       // khhdgoc
  serialType: number;   // khmshdgoc
  num: number;          // shdgoc
  issuedDate: string;   // tdlhdgoc
}

export interface VatRateEntry {
  rate: string;
  amount: number;
  taxAmount: number;
}

export interface LineItem {
  id: string;
  stt: number;
  name: string;       // ten
  unit: string;       // dvtinh
  qty: number;        // sluong
  price: number;      // dgia
  amount: number;     // thtien
  vatRate: number;     // tsuat (0.08 = 8%)
  vatRateLabel: string;  // ltsuat ("8%", "KCT")
  vatAmount: number;   // from ttkhac[TThue].dlieu
}

export interface ClassifiedInvoice {
  // Identity
  id: string;
  invoiceNum: number;
  serial: string;
  serialType: number;
  sellerTax: string;
  sellerName: string;
  buyerTax: string;
  buyerName: string;
  issuedDate: string;

  // Classification
  status: InvoiceStatus;
  processType: InvoiceProcessType;
  isSco: boolean;
  direction: 'purchase' | 'sold';

  // Tax usability
  isUsableForTax: boolean;

  // Replacement chain
  originalInvoiceRef: OriginalInvoiceRef | null;

  // Amounts
  subtotal: number;
  vatAmount: number;
  total: number;
  currency: string;
  vatRates: VatRateEntry[];

  // Payment
  /** Extracted from thtttoan (string) or htttoan (number: 9 = "TM/CK", others = null) */
  paymentMethod: string | null;

  // Line items
  hasLineItems: boolean;
  lineItems: LineItem[];

  rawData: Record<string, unknown>;
}

// ─── PART 2: Classifier ──────────────────────────────────────────────────────

/**
 * Map raw status code to InvoiceStatus enum.
 */
function resolveStatus(raw: string, config: GdtConfig): InvoiceStatus {
  const mapped = config.statusMap[raw];
  switch (mapped) {
    case 'valid':              return InvoiceStatus.VALID;
    case 'cancelled':          return InvoiceStatus.CANCELLED;
    case 'replaced_original':  return InvoiceStatus.REPLACED_ORIGINAL;
    case 'replaced':           return InvoiceStatus.REPLACED;
    case 'adjusted':           return InvoiceStatus.ADJUSTED;
    default:                   return InvoiceStatus.VALID;
  }
}

/**
 * Map raw ttxly code to InvoiceProcessType enum.
 */
function resolveProcessType(raw: string, config: GdtConfig): InvoiceProcessType {
  const mapped = config.ttxlyMap[raw];
  switch (mapped) {
    case 'co_ma':           return InvoiceProcessType.CO_MA;
    case 'khong_ma':        return InvoiceProcessType.KHONG_MA;
    case 'may_tinh_tien':   return InvoiceProcessType.MAY_TINH_TIEN;
    default:                return InvoiceProcessType.CO_MA;
  }
}

/**
 * Determine if an invoice is usable for tax declaration.
 *
 * Rules:
 *   VALID (tthai=1):              true
 *   REPLACED (tthai=5):           true   ← replacement that is valid
 *   ADJUSTED (tthai=6):           true
 *   REPLACED_ORIGINAL (tthai=4):  FALSE  ← has been replaced, exclude
 *   CANCELLED (tthai=3):          FALSE
 */
function determineUsableForTax(status: InvoiceStatus): boolean {
  switch (status) {
    case InvoiceStatus.VALID:
    case InvoiceStatus.REPLACED:
    case InvoiceStatus.ADJUSTED:
      return true;
    case InvoiceStatus.REPLACED_ORIGINAL:
    case InvoiceStatus.CANCELLED:
      return false;
    default:
      return false;
  }
}

/**
 * Parse original invoice reference from raw fields (replacement chain).
 * Returns null if all fields are empty.
 */
function parseOriginalRef(raw: Record<string, unknown>): OriginalInvoiceRef | null {
  const serial     = String(raw['khhdgoc'] ?? '');
  const serialType = Number(raw['khmshdgoc'] ?? 0);
  const num        = Number(raw['shdgoc'] ?? 0);
  const issuedDate = String(raw['tdlhdgoc'] ?? '');

  if (!serial && !num && !issuedDate) return null;

  return { serial, serialType, num, issuedDate };
}

/**
 * Parse VAT rate breakdown from nested thttltsuat array.
 */
function parseVatRates(raw: Record<string, unknown>, config: GdtConfig): VatRateEntry[] {
  const nestedPath = config.fields.vatRateNestedPath;
  if (typeof nestedPath !== 'string') return [];

  const nested = raw[nestedPath];
  if (!Array.isArray(nested)) return [];

  return nested.map((entry: Record<string, unknown>) => ({
    rate: String(entry['tsuat'] ?? entry['ltsuat'] ?? ''),
    amount: Number(entry['thtien'] ?? 0),
    taxAmount: Number(entry['tthue'] ?? 0),
  }));
}

/**
 * Extract VAT amount from a line item's ttkhac array.
 * Looks for ttruong "TThue" or "Tiền thuế".
 */
function extractLineItemVat(item: Record<string, unknown>): number {
  const ttkhac = item['ttkhac'];
  if (!Array.isArray(ttkhac)) return 0;

  for (const entry of ttkhac) {
    const fieldName = String((entry as Record<string, unknown>)['ttruong'] ?? '');
    if (fieldName === 'TThue' || fieldName === 'Tiền thuế') {
      const val = Number((entry as Record<string, unknown>)['dlieu'] ?? 0);
      return Number.isNaN(val) ? 0 : val;
    }
  }
  return 0;
}

/**
 * Parse line items from hdhhdvu array.
 */
function parseLineItems(raw: Record<string, unknown>): LineItem[] {
  const items = raw['hdhhdvu'];
  if (!Array.isArray(items)) return [];

  return items.map((item: Record<string, unknown>, index: number) => {
    const stt = Number(item['stt'] ?? index + 1);
    const tsuat = Number(item['tsuat'] ?? 0);

    return {
      id: String(item['id'] ?? `item-${index}`),
      stt,
      name: String(item['ten'] ?? ''),
      unit: String(item['dvtinh'] ?? ''),
      qty: Number(item['sluong'] ?? 0),
      price: Number(item['dgia'] ?? 0),
      amount: Number(item['thtien'] ?? 0),
      vatRate: tsuat,
      vatRateLabel: String(item['ltsuat'] ?? (tsuat > 0 ? `${tsuat * 100}%` : 'KCT')),
      vatAmount: extractLineItemVat(item),
    };
  });
}

/**
 * Classify a single raw GDT invoice into a structured ClassifiedInvoice.
 *
 * Uses resolveField for all field lookups — never hardcodes GDT field names.
 */
export function classifyInvoice(
  raw: Record<string, unknown>,
  config: GdtConfig,
  direction: 'purchase' | 'sold',
  isSco: boolean,
): ClassifiedInvoice {
  const f = config.fields;

  const statusRaw = String(resolveField(raw, f.status as string[]) ?? '1');
  const ttxlyRaw  = String(resolveField(raw, f.ttxly as string[]) ?? '5');

  const status      = resolveStatus(statusRaw, config);
  const processType = resolveProcessType(ttxlyRaw, config);

  const lineItems = parseLineItems(raw);

  return {
    id:          String(raw['id'] ?? raw['_id'] ?? ''),
    invoiceNum:  resolveNumber(raw, f.invoiceNum as string[]),
    serial:      resolveString(raw, f.serial as string[]),
    serialType:  Number(raw['khmshdon'] ?? 0),
    sellerTax:   resolveString(raw, f.sellerTax as string[]),
    sellerName:  resolveString(raw, f.sellerName as string[]),
    buyerTax:    resolveString(raw, f.buyerTax as string[]),
    buyerName:   resolveString(raw, f.buyerName as string[]),
    issuedDate:  resolveString(raw, f.date as string[]),

    status,
    processType,
    isSco,
    direction,

    isUsableForTax: determineUsableForTax(status),

    originalInvoiceRef: parseOriginalRef(raw),

    subtotal:  resolveNumber(raw, f.subtotal as string[]),
    vatAmount: resolveNumber(raw, f.vatAmount as string[]),
    total:     resolveNumber(raw, f.total as string[]),
    currency:  String(raw['dvtte'] ?? 'VND'),
    vatRates:  parseVatRates(raw, config),

    paymentMethod: (() => {
      const thtttoan = raw['thtttoan'];
      if (typeof thtttoan === 'string' && thtttoan.trim()) return thtttoan.trim();
      const htttoan = raw['htttoan'];
      if (htttoan === 9) return 'TM/CK';
      return null;
    })(),

    hasLineItems: lineItems.length > 0,
    lineItems,

    rawData: raw,
  };
}

// ─── PART 3: Batch + Summary ─────────────────────────────────────────────────

export interface ClassifyBatchResult {
  classified: ClassifiedInvoice[];
  errors: Array<{ id: string; error: string }>;
}

/**
 * Classify a batch of raw GDT invoices.
 * Each item is wrapped in try/catch — one failure does not stop the batch.
 */
export function classifyBatch(
  items: Record<string, unknown>[],
  config: GdtConfig,
  direction: 'purchase' | 'sold',
  isSco: boolean,
): ClassifyBatchResult {
  const classified: ClassifiedInvoice[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const item of items) {
    try {
      classified.push(classifyInvoice(item, config, direction, isSco));
    } catch (err) {
      const id = String(item['id'] ?? item['_id'] ?? 'unknown');
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ id, error: msg });
      logger.warn('Failed to classify invoice', { id, error: msg });
    }
  }

  return { classified, errors };
}

export interface TaxSummary {
  total: number;
  usableCount: number;
  cancelledCount: number;
  replacedOriginalCount: number;
  replacedCount: number;
  adjustedCount: number;
  totalSubtotal: number;     // only isUsableForTax=true
  totalVat: number;
  totalAmount: number;
  byVatRate: Record<string, { subtotal: number; vat: number }>;
}

/**
 * Generate a tax summary from classified invoices.
 *
 * Only isUsableForTax=true invoices are counted in monetary totals.
 */
export function generateTaxSummary(invoices: ClassifiedInvoice[]): TaxSummary {
  const summary: TaxSummary = {
    total: invoices.length,
    usableCount: 0,
    cancelledCount: 0,
    replacedOriginalCount: 0,
    replacedCount: 0,
    adjustedCount: 0,
    totalSubtotal: 0,
    totalVat: 0,
    totalAmount: 0,
    byVatRate: {},
  };

  for (const inv of invoices) {
    // Count by status
    switch (inv.status) {
      case InvoiceStatus.CANCELLED:
        summary.cancelledCount++;
        break;
      case InvoiceStatus.REPLACED_ORIGINAL:
        summary.replacedOriginalCount++;
        break;
      case InvoiceStatus.REPLACED:
        summary.replacedCount++;
        break;
      case InvoiceStatus.ADJUSTED:
        summary.adjustedCount++;
        break;
    }

    if (inv.isUsableForTax) {
      summary.usableCount++;
      summary.totalSubtotal += inv.subtotal;
      summary.totalVat += inv.vatAmount;
      summary.totalAmount += inv.total;

      // Aggregate by VAT rate
      for (const vr of inv.vatRates) {
        const key = vr.rate || 'unknown';
        if (!summary.byVatRate[key]) {
          summary.byVatRate[key] = { subtotal: 0, vat: 0 };
        }
        summary.byVatRate[key].subtotal += vr.amount;
        summary.byVatRate[key].vat += vr.taxAmount;
      }
    }
  }

  return summary;
}
