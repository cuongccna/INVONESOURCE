import { TaxDeclaration } from 'shared';
import { pool } from '../db/pool';

interface CompanyInfo {
  name: string;
  tax_code: string;
  address: string;
}

/**
 * HtkkXmlGenerator — generates XML HTKK chuẩn TT80/2021 for 01/GTGT form
 * This is the ONLY format GDT accepts via thuedientu.gdt.gov.vn
 */
export class HtkkXmlGenerator {
  async generate(declaration: TaxDeclaration): Promise<string> {
    const { rows } = await pool.query<CompanyInfo>(
      'SELECT name, tax_code, address FROM companies WHERE id = $1',
      [declaration.company_id]
    );

    if (!rows.length) throw new Error(`Company not found: ${declaration.company_id}`);
    const company = rows[0];

    const periodStr = `${String(declaration.period_month).padStart(2, '0')}/${declaration.period_year}`;
    const now = new Date();
    const generatedAt = `${now.getDate().toString().padStart(2,'0')}/${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getFullYear()}`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDT>
  <HSoKKhaiThue>
    <TTinChung>
      <TTinDVNThue>
        <mSoThue>${company.tax_code}</mSoThue>
        <tenNNT>${escapeXml(company.name)}</tenNNT>
        <dChi>${escapeXml(company.address ?? '')}</dChi>
      </TTinDVNThue>
      <TTinTKhai>
        <mauSoBKhai>01/GTGT</mauSoBKhai>
        <tenMauBieu>Tờ khai thuế giá trị gia tăng</tenMauBieu>
        <soLanNopTKhai>1</soLanNopTKhai>
        <bSungTKhaiTruoc>0</bSungTKhaiTruoc>
        <kyDuLieu>
          <kieuKyDuLieu>KT</kieuKyDuLieu>
          <kyDuLieuThang>${String(declaration.period_month).padStart(2, '0')}</kyDuLieuThang>
          <kyDuLieuNam>${declaration.period_year}</kyDuLieuNam>
        </kyDuLieu>
        <ngayLapTKhai>${generatedAt}</ngayLapTKhai>
        <nguoiKy></nguoiKy>
        <ngayKy></ngayKy>
        <nguoiNopTien>${escapeXml(company.name)}</nguoiNopTien>
        <tenDaiLyThue></tenDaiLyThue>
        <maDaiLyThue></maDaiLyThue>
        <hinhThucKKhai>1</hinhThucKKhai>
        <phuongPhapTinhThue>1</phuongPhapTinhThue>
      </TTinTKhai>
    </TTinChung>
    <CTiet>
      <!-- [22] Tổng thuế GTGT đầu vào -->
      <ct22>${declaration.ct22_total_input_vat}</ct22>
      <!-- [23] Thuế GTGT đầu vào đủ điều kiện khấu trừ -->
      <ct23>${declaration.ct23_deductible_input_vat}</ct23>
      <!-- [24] Thuế GTGT kỳ trước chuyển sang -->
      <ct24>${declaration.ct24_carried_over_vat}</ct24>
      <!-- [25] Tổng được khấu trừ [23]+[24] -->
      <ct25>${declaration.ct25_total_deductible}</ct25>
      <!-- [29] Tổng doanh thu HHDV bán ra -->
      <ct29>${declaration.ct29_total_revenue}</ct29>
      <!-- [30] Doanh thu không chịu thuế -->
      <ct30>${declaration.ct30_exempt_revenue}</ct30>
      <!-- [32] Doanh thu chịu thuế 5% -->
      <ct32>${declaration.ct32_revenue_5pct}</ct32>
      <!-- [33] Thuế GTGT 5% -->
      <ct33>${declaration.ct33_vat_5pct}</ct33>
      <!-- [34] Doanh thu chịu thuế 8% -->
      <ct34>${declaration.ct34_revenue_8pct}</ct34>
      <!-- [35] Thuế GTGT 8% -->
      <ct35>${declaration.ct35_vat_8pct}</ct35>
      <!-- [36] Doanh thu chịu thuế 10% -->
      <ct36>${declaration.ct36_revenue_10pct}</ct36>
      <!-- [37] Thuế GTGT 10% -->
      <ct37>${declaration.ct37_vat_10pct}</ct37>
      <!-- [40] Tổng doanh thu đầu ra -->
      <ct40>${declaration.ct40_total_output_revenue}</ct40>
      <!-- [40a] Tổng thuế GTGT đầu ra -->
      <ct40a>${declaration.ct40a_total_output_vat}</ct40a>
      <!-- [41] Thuế GTGT phải nộp = MAX(0, [40a]-[25]) -->
      <ct41>${declaration.ct41_payable_vat}</ct41>
      <!-- [43] Thuế GTGT được khấu trừ kỳ sau -->
      <ct43>${declaration.ct43_carry_forward_vat}</ct43>
    </CTiet>
  </HSoKKhaiThue>
</GDT>`;

    // Save XML to declaration
    await pool.query(
      `UPDATE tax_declarations SET xml_content = $1, xml_generated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [xml, declaration.id]
    );

    return xml;
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
