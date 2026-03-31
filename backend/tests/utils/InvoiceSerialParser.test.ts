import { parseInvoiceSerial } from '../../src/utils/InvoiceSerialParser';

describe('InvoiceSerialParser', () => {
  describe('Group 5 — Có mã CQT (C-prefix)', () => {
    it('parses C26TDL as Group 5', () => {
      const result = parseInvoiceSerial('C26TDL');
      expect(result.hasCqtCode).toBe(true);
      expect(result.invoiceYear).toBe(2026);
      expect(result.invoiceType).toBe('T');
      expect(result.invoiceTypeLabel).toBe('Hóa đơn thường');
      expect(result.companyCode).toBe('DL');
      expect(result.invoiceGroup).toBe(5);
      expect(result.isDetailAvailable).toBe(true);
    });

    it('parses C25MABC as Group 5 (C-prefix overrides M type)', () => {
      const result = parseInvoiceSerial('C25MABC');
      expect(result.hasCqtCode).toBe(true);
      expect(result.invoiceGroup).toBe(5);
      expect(result.invoiceType).toBe('M');
      expect(result.invoiceTypeLabel).toBe('Hóa đơn máy tính tiền');
      expect(result.isDetailAvailable).toBe(true);
    });

    it('parses C24DXYZ as Group 5 with type D (điện)', () => {
      const result = parseInvoiceSerial('C24DXYZ');
      expect(result.invoiceGroup).toBe(5);
      expect(result.invoiceType).toBe('D');
      expect(result.invoiceTypeLabel).toBe('Hóa đơn điện');
      expect(result.invoiceYear).toBe(2024);
    });
  });

  describe('Group 6 — Không mã CQT, HĐ thường (K-prefix, T-type)', () => {
    it('parses K26TABC as Group 6', () => {
      const result = parseInvoiceSerial('K26TABC');
      expect(result.hasCqtCode).toBe(false);
      expect(result.invoiceYear).toBe(2026);
      expect(result.invoiceType).toBe('T');
      expect(result.invoiceGroup).toBe(6);
      expect(result.isDetailAvailable).toBe(false);
    });

    it('parses K25DXYZ as Group 6 (K + non-M type)', () => {
      const result = parseInvoiceSerial('K25DXYZ');
      expect(result.invoiceGroup).toBe(6);
      expect(result.invoiceType).toBe('D');
      expect(result.isDetailAvailable).toBe(false);
    });

    it('parses K26NWAT as Group 6 with type N (nước)', () => {
      const result = parseInvoiceSerial('K26NWAT');
      expect(result.invoiceGroup).toBe(6);
      expect(result.invoiceType).toBe('N');
      expect(result.invoiceTypeLabel).toBe('Hóa đơn nước');
    });
  });

  describe('Group 8 — Không mã CQT, máy tính tiền (K-prefix, M-type)', () => {
    it('parses K26MDEF as Group 8', () => {
      const result = parseInvoiceSerial('K26MDEF');
      expect(result.hasCqtCode).toBe(false);
      expect(result.invoiceYear).toBe(2026);
      expect(result.invoiceType).toBe('M');
      expect(result.invoiceTypeLabel).toBe('Hóa đơn máy tính tiền');
      expect(result.invoiceGroup).toBe(8);
      expect(result.isDetailAvailable).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('returns null group for empty string', () => {
      const result = parseInvoiceSerial('');
      expect(result.raw).toBe('');
      expect(result.invoiceGroup).toBeNull();
      expect(result.isDetailAvailable).toBe(false);
      expect(result.invoiceTypeLabel).toBe('Không xác định');
    });

    it('returns null group for null-like input', () => {
      const result = parseInvoiceSerial(null as unknown as string);
      expect(result.invoiceGroup).toBeNull();
    });

    it('returns null group for short string (< 4 chars)', () => {
      const result = parseInvoiceSerial('C26');
      expect(result.invoiceGroup).toBeNull();
      expect(result.invoiceYear).toBe(0);
    });

    it('handles lowercase input by uppercasing', () => {
      const result = parseInvoiceSerial('c26tdl');
      expect(result.hasCqtCode).toBe(true);
      expect(result.invoiceGroup).toBe(5);
      expect(result.invoiceType).toBe('T');
      expect(result.companyCode).toBe('DL');
    });

    it('returns null group for unknown first character', () => {
      const result = parseInvoiceSerial('X26TABC');
      expect(result.invoiceGroup).toBeNull();
      expect(result.isDetailAvailable).toBe(false);
    });

    it('handles unknown type letter with fallback label', () => {
      const result = parseInvoiceSerial('C26ZABC');
      expect(result.invoiceGroup).toBe(5);
      expect(result.invoiceType).toBe('Z');
      expect(result.invoiceTypeLabel).toBe('Loại Z');
    });

    it('handles exact 4-char serial with no company code', () => {
      const result = parseInvoiceSerial('C26T');
      expect(result.hasCqtCode).toBe(true);
      expect(result.invoiceGroup).toBe(5);
      expect(result.companyCode).toBe('');
    });

    it('preserves raw value', () => {
      const result = parseInvoiceSerial('  c26tdl  ');
      expect(result.raw).toBe('  c26tdl  ');
    });
  });
});
