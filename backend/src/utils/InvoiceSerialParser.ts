import { ParsedSerial } from 'shared';

/**
 * Invoice Serial Number Parser — TT78/2021
 *
 * Serial number format (Ký hiệu hóa đơn): C26TDL
 *   Position 1:   C = Có mã CQT | K = Không có mã CQT
 *   Position 2-3: Year (26 = 2026)
 *   Position 4:   Type: T=Thường, M=Máy tính tiền, D=Điện, N=Nước, V=Viễn thông, X=Xăng dầu
 *   Position 5+:  Company identifier code (DN tự đặt)
 *
 * Group classification (invoiceType checked FIRST — overrides C/K prefix):
 *   Group 8: Type=M (máy tính tiền) — both C26MED and K26MED → group 8 regardless of prefix
 *   Group 5: C-prefix + non-M type → đã cấp mã CQT, full detail (line items) available
 *   Group 6: K-prefix + non-M type → không mã CQT, header only
 */

const TYPE_LABELS: Record<string, string> = {
  'T': 'Hóa đơn thường',
  'M': 'Hóa đơn máy tính tiền',
  'D': 'Hóa đơn điện',
  'N': 'Hóa đơn nước',
  'V': 'Hóa đơn viễn thông',
  'X': 'Hóa đơn xăng dầu',
};

export function parseInvoiceSerial(serial: string): ParsedSerial {
  if (!serial || serial.length < 4) {
    return {
      raw: serial ?? '',
      hasCqtCode: false,
      invoiceYear: 0,
      invoiceType: '',
      invoiceTypeLabel: 'Không xác định',
      companyCode: '',
      invoiceGroup: null,
      isDetailAvailable: false,
    };
  }

  const s = serial.toUpperCase().trim();
  const firstChar = s[0];
  const hasCqtCode = firstChar === 'C';
  const yearStr = s.substring(1, 3);
  const invoiceYear = 2000 + parseInt(yearStr || '0', 10);
  const invoiceType = s[3] || 'T';
  const companyCode = s.substring(4);

  // Group classification per TT78/2021
  // invoiceType (position 4) takes priority — 'M' always means MTT (group 8),
  // regardless of whether the invoice has a CQT code (C prefix) or not (K prefix).
  // C26MED = CQT-coded MTT invoice → group 8 (not 5!)
  let invoiceGroup: 5 | 6 | 8 | null = null;
  if (firstChar === 'C' || firstChar === 'K') {
    if (invoiceType === 'M') {
      invoiceGroup = 8;                     // Máy tính tiền (both C and K prefix)
    } else if (hasCqtCode) {
      invoiceGroup = 5;                     // Có mã CQT, hóa đơn thường/điện/nước/...
    } else {
      invoiceGroup = 6;                     // Không mã CQT, hóa đơn thường
    }
  }

  return {
    raw: serial,
    hasCqtCode,
    invoiceYear,
    invoiceType,
    invoiceTypeLabel: TYPE_LABELS[invoiceType] || `Loại ${invoiceType}`,
    companyCode,
    invoiceGroup,
    isDetailAvailable: hasCqtCode,
  };
}
