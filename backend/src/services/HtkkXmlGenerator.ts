import { TaxDeclaration } from 'shared';
import { pool } from '../db/pool';

interface CompanyInfo {
  name: string;
  tax_code: string;
  address: string;
  phone: string | null;
  email: string | null;
}

/**
 * HtkkXmlGenerator — tạo XML HTKK chuẩn TT80/2021 cho tờ khai 01/GTGT (maTKhai=842).
 *
 * Cấu trúc XML theo đúng mẫu HTKK phiên bản 2.8.3:
 *   <HSoThueDTu xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue">
 *     <HSoKhaiThue id="NODETOSIGN">
 *       <TTinChung> ... </TTinChung>
 *       <CTieuTKhaiChinh> ... </CTieuTKhaiChinh>
 *       <PLuc/>
 *     </HSoKhaiThue>
 *     <CKyDTu/>
 *   </HSoThueDTu>
 *
 * Ánh xạ chỉ tiêu DB → XML (TT80/2021):
 *   ct23_deductible_input_vat  → GiaTriVaThueGTGTHHDVMuaVao/ct24
 *   ct25_total_deductible      → ct25
 *   ct30_exempt_revenue        → ct29 (không chịu thuế)
 *   ct32_revenue_5pct + ct33   → HHDVBRaChiuTSuat5/ct30, ct31
 *   ct36_revenue_10pct + ct34  → HHDVBRaChiuTSuat10/ct32, ct33  (8% gộp vào nhóm 10%)
 *   ct37_vat_10pct + ct35      → HHDVBRaChiuTSuat10/ct33
 *   ct40_total_output_revenue  → TongDThuVaThueGTGTHHDVBRa/ct34
 *   ct40a_total_output_vat     → ct35, ct36, ct40a, ct40
 *   ct41_payable_vat           → ct41
 *   ct43_carry_forward_vat     → ct43
 */
export class HtkkXmlGenerator {
  async generate(declaration: TaxDeclaration): Promise<string> {
    // ── 1. Thông tin công ty ─────────────────────────────────────────────────
    const { rows: companyRows } = await pool.query<CompanyInfo>(
      'SELECT name, tax_code, address, phone, email FROM companies WHERE id = $1',
      [declaration.company_id]
    );
    if (!companyRows.length) throw new Error(`Company not found: ${declaration.company_id}`);
    const co = companyRows[0];

    // ── 2. Giá trị hàng mua vào đủ điều kiện khấu trừ (chưa VAT) ────────────
    // HTKK ct23 (GiaTriVaThueGTGTHHDVMuaVao) = tổng subtotal (chưa VAT) của
    // hoá đơn đầu vào hợp lệ/đã xác thực GDT trong kỳ.
    const isQuarterly = declaration.filing_frequency === 'quarterly';
    const inputSubtotal = await _fetchDeductibleInputSubtotal(
      declaration.company_id,
      declaration.period_month,
      declaration.period_year,
      isQuarterly
    );

    // ── 3. Tính toán các chỉ tiêu XML ────────────────────────────────────────
    const d = declaration;

    // Nhóm 10%: gộp hoá đơn 8% (giảm thuế theo NQ) vào nhóm 10%
    const xml_ct32_revenue = d.ct36_revenue_10pct + d.ct34_revenue_8pct;
    const xml_ct33_vat     = d.ct37_vat_10pct + d.ct35_vat_8pct;

    // ct27 = tổng doanh thu chịu thuế (5%+8%+10%), không bao gồm miễn thuế
    const xml_ct27_taxable = d.ct32_revenue_5pct + xml_ct32_revenue;
    // ct28 = tổng VAT đầu ra = ct40a
    const xml_ct28_vat     = d.ct40a_total_output_vat;
    // ct35 (tổng cộng bảng kê bán ra) = ct40a
    const xml_ct35_total   = d.ct40a_total_output_vat;
    // ct36 (thuế GTGT phải kê khai sau điều chỉnh) = ct40a
    // (NQ142 PLuc chưa áp dụng trong generator này — ct36 = ct35)
    const xml_ct36_declared = d.ct40a_total_output_vat;

    // ── 4. Ngày kỳ khai ──────────────────────────────────────────────────────
    const period = buildPeriod(declaration.period_month, declaration.period_year, isQuarterly);

    // ── 5. Ngày lập tờ khai ───────────────────────────────────────────────────
    const now = new Date();
    const ngayLap = fmtDDMMYYYY(now);
    const ngayKy  = fmtISODate(now);

    // ── 6. Tạo XML ────────────────────────────────────────────────────────────
    const xml = `<HSoThueDTu xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <HSoKhaiThue id="NODETOSIGN">
        <TTinChung>
            <TTinDVu>
                <maDVu>TTGQ TTHC</maDVu>
                <tenDVu>TTGQ TTHC</tenDVu>
                <pbanDVu>1.0.0</pbanDVu>
                <ttinNhaCCapDVu>TTGQ TTHC</ttinNhaCCapDVu>
            </TTinDVu>
            <TTinTKhaiThue>
                <TKhaiThue>
                    <maTKhai>842</maTKhai>
                    <tenTKhai>TỜ KHAI THUẾ GIÁ TRỊ GIA TĂNG Mẫu số 01/GTGT (TT80/2021)</tenTKhai>
                    <moTaBMau>01/GTGT</moTaBMau>
                    <pbanTKhaiXML>2.8.3</pbanTKhaiXML>
                    <loaiTKhai>C</loaiTKhai>
                    <soLan>0</soLan>
                    <KyKKhaiThue>
                        <kieuKy>${period.kieuKy}</kieuKy>
                        <kyKKhai>${period.kyKKhai}</kyKKhai>
                        <kyKKhaiTuNgay>${period.tuNgay}</kyKKhaiTuNgay>
                        <kyKKhaiDenNgay>${period.denNgay}</kyKKhaiDenNgay>
                        <kyKKhaiTuThang>${period.tuThang}</kyKKhaiTuThang>
                        <kyKKhaiDenThang>${period.denThang}</kyKKhaiDenThang>
                    </KyKKhaiThue>
                    <maCQTNoiNop/>
                    <tenCQTNoiNop/>
                    <ngayLapTKhai>${ngayLap}</ngayLapTKhai>
                    <nguoiKy/>
                    <ngayKy>${ngayKy}</ngayKy>
                    <nganhNgheKD/>
                </TKhaiThue>
                <NNT>
                    <mst>${escapeXml(co.tax_code)}</mst>
                    <tenNNT>${escapeXml(co.name)}</tenNNT>
                    <dchiNNT>${escapeXml(co.address ?? '')}</dchiNNT>
                    <phuongXa/>
                    <maHuyenNNT/>
                    <tenHuyenNNT/>
                    <maTinhNNT/>
                    <tenTinhNNT/>
                    <dthoaiNNT>${escapeXml(co.phone ?? '')}</dthoaiNNT>
                    <faxNNT/>
                    <emailNNT>${escapeXml(co.email ?? '')}</emailNNT>
                </NNT>
            </TTinTKhaiThue>
        </TTinChung>
        <CTieuTKhaiChinh>
            <ma_NganhNghe>00</ma_NganhNghe>
            <ten_NganhNghe>Hoạt động sản xuất kinh doanh thông thường</ten_NganhNghe>
            <tieuMucHachToan>1701</tieuMucHachToan>
            <Header>
                <ct09/>
                <ct10/>
                <DiaChiHDSXKDKhacTinhNDTSC>
                    <ct11a_phuongXa_ma/>
                    <ct11a_phuongXa_ten/>
                    <ct11b_quanHuyen_ma xsi:nil="true"/>
                    <ct11b_quanHuyen_ten xsi:nil="true"/>
                    <ct11c_tinhTP_ma/>
                    <ct11c_tinhTP_ten/>
                </DiaChiHDSXKDKhacTinhNDTSC>
            </Header>
            <ct21>false</ct21>
            <ct22>0</ct22>
            <GiaTriVaThueGTGTHHDVMuaVao>
                <ct23>${inputSubtotal}</ct23>
                <ct24>${d.ct23_deductible_input_vat}</ct24>
            </GiaTriVaThueGTGTHHDVMuaVao>
            <HangHoaDichVuNhapKhau>
                <ct23a>0</ct23a>
                <ct24a>0</ct24a>
            </HangHoaDichVuNhapKhau>
            <ct25>${d.ct25_total_deductible}</ct25>
            <ct26>0</ct26>
            <HHDVBRaChiuThueGTGT>
                <ct27>${xml_ct27_taxable}</ct27>
                <ct28>${xml_ct28_vat}</ct28>
            </HHDVBRaChiuThueGTGT>
            <ct29>${d.ct30_exempt_revenue}</ct29>
            <HHDVBRaChiuTSuat5>
                <ct30>${d.ct32_revenue_5pct}</ct30>
                <ct31>${d.ct33_vat_5pct}</ct31>
            </HHDVBRaChiuTSuat5>
            <HHDVBRaChiuTSuat10>
                <ct32>${xml_ct32_revenue}</ct32>
                <ct33>${xml_ct33_vat}</ct33>
            </HHDVBRaChiuTSuat10>
            <ct32a>0</ct32a>
            <TongDThuVaThueGTGTHHDVBRa>
                <ct34>${d.ct40_total_output_revenue}</ct34>
                <ct35>${xml_ct35_total}</ct35>
            </TongDThuVaThueGTGTHHDVBRa>
            <ct36>${xml_ct36_declared}</ct36>
            <ct37>0</ct37>
            <ct38>0</ct38>
            <ct39a>0</ct39a>
            <ct40a>${d.ct40a_total_output_vat}</ct40a>
            <ct40b>0</ct40b>
            <ct40>${d.ct40a_total_output_vat}</ct40>
            <ct41>${d.ct41_payable_vat}</ct41>
            <ct42>0</ct42>
            <ct43>${d.ct43_carry_forward_vat}</ct43>
        </CTieuTKhaiChinh>
        <PLuc/>
    </HSoKhaiThue>
    <CKyDTu/>
</HSoThueDTu>`;

    // Lưu XML vào DB
    await pool.query(
      `UPDATE tax_declarations SET xml_content = $1, xml_generated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [xml, declaration.id]
    );

    return xml;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lấy tổng subtotal (chưa VAT) của hoá đơn đầu vào đủ điều kiện khấu trừ trong kỳ. */
async function _fetchDeductibleInputSubtotal(
  companyId: string,
  periodMonth: number,
  periodYear: number,
  quarterly: boolean
): Promise<number> {
  let dateFilter: string;
  let params: unknown[];

  if (quarterly) {
    // period_month = quarter (1-4); months = (Q-1)*3+1 to Q*3
    const firstMonth = (periodMonth - 1) * 3 + 1;
    const lastMonth  = periodMonth * 3;
    dateFilter = `EXTRACT(MONTH FROM invoice_date) BETWEEN $2 AND $3
                  AND EXTRACT(YEAR FROM invoice_date) = $4`;
    params = [companyId, firstMonth, lastMonth, periodYear];
  } else {
    dateFilter = `EXTRACT(MONTH FROM invoice_date) = $2
                  AND EXTRACT(YEAR FROM invoice_date) = $3`;
    params = [companyId, periodMonth, periodYear];
  }

  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(subtotal), 0) AS total
     FROM invoices
     WHERE company_id = $1
       AND direction = 'input'
       AND status = 'valid'
       AND gdt_validated = true
       AND deleted_at IS NULL
       AND (total_amount <= 20000000 OR payment_method IS DISTINCT FROM 'cash')
       AND ${dateFilter}`,
    params
  );
  return Math.round(parseFloat(rows[0]?.total ?? '0'));
}

interface PeriodInfo {
  kieuKy:  string;  // 'T' (monthly) | 'Q' (quarterly)
  kyKKhai: string;  // e.g. '12/2025' or '4/2025'
  tuNgay:  string;  // dd/MM/yyyy
  denNgay: string;  // dd/MM/yyyy
  tuThang: string;  // MM/yyyy
  denThang: string; // MM/yyyy
}

function buildPeriod(periodMonth: number, year: number, quarterly: boolean): PeriodInfo {
  if (quarterly) {
    const q          = periodMonth;              // 1..4
    const firstMonth = (q - 1) * 3 + 1;
    const lastMonth  = q * 3;
    const lastDay    = getLastDayOfMonth(year, lastMonth);
    return {
      kieuKy:   'Q',
      kyKKhai:  `${q}/${year}`,
      tuNgay:   `01/${pad2(firstMonth)}/${year}`,
      denNgay:  `${pad2(lastDay)}/${pad2(lastMonth)}/${year}`,
      tuThang:  `${pad2(firstMonth)}/${year}`,
      denThang: `${pad2(lastMonth)}/${year}`,
    };
  } else {
    const m       = periodMonth;
    const lastDay = getLastDayOfMonth(year, m);
    return {
      kieuKy:   'T',
      kyKKhai:  `${pad2(m)}/${year}`,
      tuNgay:   `01/${pad2(m)}/${year}`,
      denNgay:  `${pad2(lastDay)}/${pad2(m)}/${year}`,
      tuThang:  `${pad2(m)}/${year}`,
      denThang: `${pad2(m)}/${year}`,
    };
  }
}

function getLastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDDMMYYYY(d: Date): string {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function fmtISODate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
