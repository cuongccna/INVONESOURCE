import { TaxDeclaration } from 'shared';
import { pool } from '../db/pool';

interface CompanyInfo {
  name: string;
  tax_code: string;
  address: string;
  phone: string | null;
  email: string | null;
}

/** Một dòng hàng hóa/dịch vụ trong phụ lục NQ142 — phía MUA VÀO (8%). */
interface PlucInputRow {
  name:      string;
  subtotal:  number;   // giá trị chưa VAT
  vatAmount: number;   // VAT 8%
}

/** Một dòng hàng hóa/dịch vụ trong phụ lục NQ142 — phía BÁN RA (giảm 10%→8%). */
interface PlucOutputRow {
  name:         string;
  subtotal:     number;   // giá trị chưa VAT
  vatReduction: number;   // thueGTGTDuocGiam = subtotal × 2%
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
 *   ct24_carried_over_vat      → ct22  (kết chuyển kỳ trước)
 *   ct23_input_subtotal        → GiaTriVaThueGTGTHHDVMuaVao/ct23  (giá trị mua vào chưa VAT)
 *   ct23_deductible_input_vat  → GiaTriVaThueGTGTHHDVMuaVao/ct24  (thuế mua vào khấu trừ)
 *   ct25_total_deductible      → ct25
 *   ct30_exempt_revenue        → ct26  (HHDV không chịu thuế GTGT)
 *   ct29 = 0                   (xuất khẩu 0% — chưa phân biệt riêng)
 *   ct32_revenue_5pct + ct33   → HHDVBRaChiuTSuat5/ct30, ct31
 *   ct36_revenue_10pct + ct34  → HHDVBRaChiuTSuat10/ct32, ct33  (8% gộp vào nhóm 10%)
 *   ct40_total_output_revenue  → TongDThuVaThueGTGTHHDVBRa/ct34
 *   ct40a_total_output_vat     → ct35  (trước NQ142)
 *   plucOutputSumReduction     → ct36  (giảm theo NQ142/NQ204 = 2% × DT đầu ra 8%)
 *   MAX(0, ct35-ct36-ct25)     → ct40a, ct40  (phải nộp — 0 khi đầu vào > đầu ra)
 *   MAX(0, ct25-(ct35-ct36))   → ct41, ct43   (kết chuyển — 0 khi đầu ra > đầu vào)
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
    // Dùng giá trị đã lưu sẵn trong declaration; fallback về query nếu chưa có (khai báo cũ).
    const isQuarterly = declaration.period_type === 'quarterly';
    const inputSubtotal: number = (declaration.ct23_input_subtotal > 0)
      ? declaration.ct23_input_subtotal
      : await _fetchDeductibleInputSubtotal(
          declaration.company_id,
          declaration.period_month,
          declaration.period_year,
          isQuarterly
        );

    // ── 3. Tính toán các chỉ tiêu XML ────────────────────────────────────────
    const d = declaration;

    // Nhóm 10%: gộp hoá đơn 8% (giảm thuế theo NQ) vào nhóm 10% trong bảng kê
    const xml_ct32_revenue = n(d.ct36_revenue_10pct) + n(d.ct34_revenue_8pct);
    const xml_ct33_vat     = n(d.ct37_vat_10pct) + n(d.ct35_vat_8pct);

    // ct27 = tổng doanh thu chịu thuế (5%+8%+10%), không bao gồm miễn thuế
    const xml_ct27_taxable = n(d.ct32_revenue_5pct) + xml_ct32_revenue;
    // ct28 = tổng VAT đầu ra gộp
    const xml_ct28_vat     = n(d.ct40a_total_output_vat);
    // ct35 (TongDThuVaThueGTGTHHDVBRa) = tổng VAT đầu ra gộp (trước điều chỉnh NQ142)
    const xml_ct35_total   = n(d.ct40a_total_output_vat);

    // ── 3b. Phụ lục NQ142 — chỉ lấy hoá đơn VAT = 8% ──────────────────────
    const [plucInputItems, plucOutputItems] = await Promise.all([
      _fetchPluc8InputItems(d.company_id, d.period_month, d.period_year, isQuarterly),
      _fetchPluc8OutputItems(d.company_id, d.period_month, d.period_year, isQuarterly),
    ]);

    const plucInputSumSubtotal   = plucInputItems.reduce((s, r) => s + r.subtotal,     0);
    const plucInputSumVat        = plucInputItems.reduce((s, r) => s + r.vatAmount,    0);
    const plucOutputSumSubtotal  = plucOutputItems.reduce((s, r) => s + r.subtotal,    0);
    const plucOutputSumReduction = plucOutputItems.reduce((s, r) => s + r.vatReduction, 0);

    // ct36 = giảm thuế GTGT theo NQ142 = 2% × doanh thu bán ra 8% (từ PLuc)
    const xml_ct36_nq142 = plucOutputSumReduction;
    // Tổng thuế đầu ra sau giảm NQ142 (giá trị trung gian)
    const outputVatAfterNQ142 = n(d.ct40a_total_output_vat) - xml_ct36_nq142;
    // Số thuế phải nộp NET = đầu ra sau NQ142 - tổng được khấu trừ [25]
    // (ct25_total_deductible đã bao gồm kết chuyển kỳ trước [22])
    const netPayable = outputVatAfterNQ142 - n(d.ct25_total_deductible);
    // ct40a/ct40: phải nộp — chỉ > 0 khi đầu ra > đầu vào
    const xml_ct40a = Math.max(0, netPayable);
    // ct41: còn được khấu trừ chưa hết — chỉ > 0 khi đầu vào > đầu ra
    const xml_ct41  = Math.max(0, -netPayable);
    // ct43: kết chuyển sang kỳ sau = ct41 - ct42 (ct42 = 0)
    const xml_ct43  = xml_ct41;

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
            <ct22>${n(d.ct24_carried_over_vat)}</ct22>
            <GiaTriVaThueGTGTHHDVMuaVao>
                <ct23>${n(inputSubtotal)}</ct23>
                <ct24>${n(d.ct23_deductible_input_vat)}</ct24>
            </GiaTriVaThueGTGTHHDVMuaVao>
            <HangHoaDichVuNhapKhau>
                <ct23a>0</ct23a>
                <ct24a>0</ct24a>
            </HangHoaDichVuNhapKhau>
            <ct25>${n(d.ct25_total_deductible)}</ct25>
            <ct26>${n(d.ct30_exempt_revenue)}</ct26>
            <HHDVBRaChiuThueGTGT>
                <ct27>${xml_ct27_taxable}</ct27>
                <ct28>${xml_ct28_vat}</ct28>
            </HHDVBRaChiuThueGTGT>
            <ct29>0</ct29>
            <HHDVBRaChiuTSuat5>
                <ct30>${n(d.ct32_revenue_5pct)}</ct30>
                <ct31>${n(d.ct33_vat_5pct)}</ct31>
            </HHDVBRaChiuTSuat5>
            <HHDVBRaChiuTSuat10>
                <ct32>${xml_ct32_revenue}</ct32>
                <ct33>${xml_ct33_vat}</ct33>
            </HHDVBRaChiuTSuat10>
            <ct32a>0</ct32a>
            <TongDThuVaThueGTGTHHDVBRa>
                <ct34>${n(d.ct40_total_output_revenue)}</ct34>
                <ct35>${xml_ct35_total}</ct35>
            </TongDThuVaThueGTGTHHDVBRa>
            <ct36>${xml_ct36_nq142}</ct36>
            <ct37>0</ct37>
            <ct38>0</ct38>
            <ct39a>0</ct39a>
            <ct40a>${xml_ct40a}</ct40a>
            <ct40b>0</ct40b>
            <ct40>${xml_ct40a}</ct40>
            <ct41>${xml_ct41}</ct41>
            <ct42>0</ct42>
            <ct43>${xml_ct43}</ct43>
        </CTieuTKhaiChinh>
        ${_buildPlucXml(plucInputItems, plucOutputItems, plucInputSumSubtotal, plucInputSumVat, plucOutputSumSubtotal, plucOutputSumReduction)}
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
       AND (
         (invoice_group = 5 AND gdt_validated = true)
         OR (invoice_group IN (6, 8))
       )
       AND deleted_at IS NULL
       AND (
         total_amount <= 20000000
         OR (payment_method IS NOT NULL AND LOWER(payment_method) <> 'cash')
       )
       ${_notReplacedClause('invoices')}
       AND ${dateFilter}`,
    params
  );
  return Math.round(parseFloat(rows[0]?.total ?? '0'));
}

// ── Helpers: period date filter ───────────────────────────────────────────────

/**
 * Điều kiện NOT EXISTS để loại hóa đơn bị thay thế logic (tc_hdon=1).
 * Dùng COALESCE cho seller_tax_code để tránh lỗi NULL = NULL → unknown trong SQL.
 * @param alias tên alias của bảng invoices trong câu query chính
 */
function _notReplacedClause(alias: string): string {
  return `AND NOT EXISTS (
       SELECT 1 FROM invoices _r
       WHERE _r.tc_hdon = 1
         AND _r.deleted_at IS NULL
         AND _r.company_id = ${alias}.company_id
         AND TRIM(COALESCE(_r.khhd_cl_quan,  '')) = TRIM(COALESCE(${alias}.serial_number,  ''))
         AND TRIM(COALESCE(_r.so_hd_cl_quan, '')) = TRIM(COALESCE(${alias}.invoice_number, ''))
         AND COALESCE(_r.seller_tax_code, '') = COALESCE(${alias}.seller_tax_code, '')
     )`;
}
/** Trả về điều kiện WHERE + params cho lọc kỳ kê khai theo ngày hoá đơn. */
function _buildPeriodFilter(
  periodMonth: number,
  periodYear: number,
  quarterly: boolean,
  dateCol: string,
  startIdx: number   // $N starting index for the next bind params
): { clause: string; params: unknown[] } {
  if (quarterly) {
    const firstMonth = (periodMonth - 1) * 3 + 1;
    const lastMonth  = periodMonth * 3;
    return {
      clause: `EXTRACT(MONTH FROM ${dateCol}) BETWEEN $${startIdx} AND $${startIdx + 1}
                   AND EXTRACT(YEAR FROM ${dateCol}) = $${startIdx + 2}`,
      params: [firstMonth, lastMonth, periodYear],
    };
  }
  return {
    clause: `EXTRACT(MONTH FROM ${dateCol}) = $${startIdx}
                   AND EXTRACT(YEAR FROM ${dateCol}) = $${startIdx + 1}`,
    params: [periodMonth, periodYear],
  };
}

/**
 * Lấy các mặt hàng MUA VÀO với VAT = 8% (NQ142) trong kỳ.
 * Ưu tiên `invoice_line_items`; fallback về invoice header (seller_name).
 */
async function _fetchPluc8InputItems(
  companyId: string,
  periodMonth: number,
  periodYear: number,
  quarterly: boolean,
): Promise<PlucInputRow[]> {
  const pf = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'i.invoice_date', 3);

  // Thử lấy từ bảng line items trước
  const { rows: lineRows } = await pool.query<{ name: string; subtotal: string; vat_amount: string }>(
    `SELECT
       COALESCE(NULLIF(TRIM(ili.item_name), ''), 'Hàng hóa/dịch vụ tổng hợp') AS name,
       COALESCE(ROUND(SUM(ili.subtotal)), 0)::bigint AS subtotal,
       COALESCE(
         ROUND(SUM(
           CASE WHEN ili.vat_amount IS NOT NULL AND ili.vat_amount <> 0
                THEN ili.vat_amount
                ELSE ili.subtotal * ili.vat_rate / 100.0
           END
         )), 0
       )::bigint AS vat_amount
     FROM invoice_line_items ili
     JOIN invoices i ON i.id = ili.invoice_id
     WHERE i.company_id = $1
       AND i.direction = 'input'
       AND i.status = 'valid'
       AND i.deleted_at IS NULL
       AND ili.vat_rate = $2
       ${_notReplacedClause('i')}
       AND ${pf.clause}
     GROUP BY 1
     ORDER BY SUM(ili.subtotal) DESC`,
    [companyId, 8, ...pf.params],
  );

  if (lineRows.length > 0) {
    return lineRows.map(r => ({
      name:      r.name,
      subtotal:  Math.round(n(r.subtotal)),
      vatAmount: Math.round(n(r.vat_amount)),
    }));
  }

  // Fallback: dùng invoice header, gom theo seller_name
  const pf2 = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'invoice_date', 2);
  const { rows: invRows } = await pool.query<{ name: string; subtotal: string; vat_amount: string }>(
    `SELECT
       COALESCE(NULLIF(TRIM(seller_name), ''), 'Hàng hóa/dịch vụ tổng hợp') AS name,
       COALESCE(ROUND(SUM(subtotal)), 0)::bigint AS subtotal,
       COALESCE(
         ROUND(SUM(
           CASE WHEN vat_amount IS NOT NULL AND vat_amount <> 0
                THEN vat_amount
                ELSE subtotal * vat_rate / 100.0
           END
         )), 0
       )::bigint AS vat_amount
     FROM invoices
     WHERE company_id = $1
       AND direction = 'input'
       AND (
         vat_rate = 8
         OR (
           (vat_rate IS NULL OR vat_rate = 0)
           AND subtotal > 0
           AND ROUND(vat_amount * 100.0 / subtotal) = 8
         )
       )
       AND status = 'valid'
       AND deleted_at IS NULL
       ${_notReplacedClause('invoices')}
       AND ${pf2.clause}
     GROUP BY 1
     ORDER BY SUM(subtotal) DESC`,
    [companyId, ...pf2.params],
  );

  return invRows.map(r => ({
    name:      r.name,
    subtotal:  Math.round(n(r.subtotal)),
    vatAmount: Math.round(n(r.vat_amount)),
  }));
}

/**
 * Lấy các mặt hàng BÁN RA với VAT = 8% (NQ142, giảm từ 10%) trong kỳ.
 * Ưu tiên `invoice_line_items`; fallback về invoice header (buyer_name).
 */
async function _fetchPluc8OutputItems(
  companyId: string,
  periodMonth: number,
  periodYear: number,
  quarterly: boolean,
): Promise<PlucOutputRow[]> {
  const pf = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'i.invoice_date', 3);

  const { rows: lineRows } = await pool.query<{ name: string; subtotal: string }>(
    `SELECT
       COALESCE(NULLIF(TRIM(ili.item_name), ''), 'Hàng hóa/dịch vụ tổng hợp') AS name,
       COALESCE(ROUND(SUM(ili.subtotal)), 0)::bigint AS subtotal
     FROM invoice_line_items ili
     JOIN invoices i ON i.id = ili.invoice_id
     WHERE i.company_id = $1
       AND i.direction = 'output'
       AND i.status = 'valid'
       AND i.deleted_at IS NULL
       AND ili.vat_rate = $2
       ${_notReplacedClause('i')}
       AND ${pf.clause}
     GROUP BY 1
     ORDER BY SUM(ili.subtotal) DESC`,
    [companyId, 8, ...pf.params],
  );

  const toOutputRow = (name: string, subtotal: number): PlucOutputRow => ({
    name,
    subtotal,
    vatReduction: Math.round(subtotal * 0.02),  // giảm 2% = (10% - 8%)
  });

  if (lineRows.length > 0) {
    return lineRows.map(r => toOutputRow(r.name, Math.round(n(r.subtotal))));
  }

  // Fallback: gom theo buyer_name (hoặc tên generic nếu không có)
  const pf2 = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'invoice_date', 2);
  const { rows: invRows } = await pool.query<{ name: string; subtotal: string }>(
    `SELECT
       COALESCE(NULLIF(TRIM(buyer_name), ''), 'Hàng hóa/dịch vụ tổng hợp') AS name,
       COALESCE(ROUND(SUM(subtotal)), 0)::bigint AS subtotal
     FROM invoices
     WHERE company_id = $1
       AND direction = 'output'
       AND (
         vat_rate = 8
         OR (
           (vat_rate IS NULL OR vat_rate = 0)
           AND subtotal > 0
           AND ROUND(vat_amount * 100.0 / subtotal) = 8
         )
       )
       AND status = 'valid'
       AND deleted_at IS NULL
       ${_notReplacedClause('invoices')}
       AND ${pf2.clause}
     GROUP BY 1
     ORDER BY SUM(subtotal) DESC`,
    [companyId, ...pf2.params],
  );

  return invRows.map(r => toOutputRow(r.name, Math.round(n(r.subtotal))));
}

/**
 * Tạo block XML <PLuc> cho phụ lục NQ142.
 * Trả về <PLuc/> nếu không có mặt hàng 8% nào.
 */
function _buildPlucXml(
  inputItems:         PlucInputRow[],
  outputItems:        PlucOutputRow[],
  inputSumSubtotal:   number,
  inputSumVat:        number,
  outputSumSubtotal:  number,
  outputSumReduction: number,
): string {
  if (inputItems.length === 0 && outputItems.length === 0) return '<PLuc/>';

  const ct9 = outputSumReduction - inputSumVat;

  const inputRows = inputItems.map((item, i) => `\
                    <BangKeTenHHDV ID="${i + 1}">
                        <tenHHDVMuaVao>${escapeXml(item.name)}</tenHHDVMuaVao>
                        <giaTriHHDVMuaVao>${item.subtotal}</giaTriHHDVMuaVao>
                        <thueGTGTHHDV>${item.vatAmount}</thueGTGTHHDV>
                    </BangKeTenHHDV>`).join('\n');

  const outputRows = outputItems.map((item, i) => `\
                    <BangKeTenHHDV ID="${i + 1}">
                        <tenHHDV>${escapeXml(item.name)}</tenHHDV>
                        <giaTriHHDV>${item.subtotal}</giaTriHHDV>
                        <thueSuatTheoQuyDinh>10</thueSuatTheoQuyDinh>
                        <thueSuatSauGiam>8</thueSuatSauGiam>
                        <thueGTGTDuocGiam>${item.vatReduction}</thueGTGTDuocGiam>
                    </BangKeTenHHDV>`).join('\n');

  return `<PLuc>
            <PL_NQ142_GTGT>
                <HH_DV_MuaVaoTrongKy>
${inputRows}
                    <tongCongGiaTriHHDVMuaVao>${inputSumSubtotal}</tongCongGiaTriHHDVMuaVao>
                    <tongCongThueGTGTHHDV>${inputSumVat}</tongCongThueGTGTHHDV>
                </HH_DV_MuaVaoTrongKy>
                <HH_DV_BanRaTrongKy>
${outputRows}
                    <tongCongGiaTriHHDV>${outputSumSubtotal}</tongCongGiaTriHHDV>
                    <tongCongThueGTGTDuocGiam>${outputSumReduction}</tongCongThueGTGTDuocGiam>
                </HH_DV_BanRaTrongKy>
                <ChenhLech>
                    <ct9>${ct9}</ct9>
                </ChenhLech>
            </PL_NQ142_GTGT>
        </PLuc>`;
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

/** Chuyển đổi an toàn giá trị null/undefined/NaN từ DB về số (mặc định 0). */
function n(val: unknown): number {
  const x = Number(val);
  return isNaN(x) ? 0 : x;
}
