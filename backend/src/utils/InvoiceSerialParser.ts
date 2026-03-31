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
 * Group classification:
 *   Group 5: C-prefix → có mã CQT → full detail (line items) available
 *   Group 6: K-prefix, T-type → không mã CQT, hóa đơn thường → header only
 *   Group 8: K-prefix, M-type → không mã CQT, máy tính tiền → header only
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
  let invoiceGroup: 5 | 6 | 8 | null = null;
  if (firstChar === 'C' || firstChar === 'K') {
    if (hasCqtCode) {
      invoiceGroup = 5;
    } else if (invoiceType === 'M') {
      invoiceGroup = 8;
    } else {
      invoiceGroup = 6;
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
