import { TaxDeclaration } from 'shared';
import { pool } from '../db/pool';
import { taxPolicyService, VatReductionPolicy } from './TaxPolicyService';

interface CompanyInfo {
  name: string;
  tax_code: string;
  address: string;
  phone: string | null;
  email: string | null;
  // F9 — thông tin bắt buộc trên header tờ khai
  tax_authority_code: string | null;
  tax_authority_name: string | null;
  signer_name: string | null;
  signer_title: string | null;
  business_line_code: string | null;
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
 * YÊU CẦU ĐỂ KÝ SỐ ĐƯỢC (USB token / HSM) — đối chiếu với tờ khai thật đã ký trên eTax:
 *   1. Có khai báo <?xml version="1.0" encoding="UTF-8"?> ở dòng đầu.
 *   2. Node được ký mang thuộc tính id="NODETOSIGN"; chữ ký tham chiếu URI="#NODETOSIGN".
 *   3. Thẻ <CKyDTu></CKyDTu> mở/đóng rõ ràng để công cụ ký chèn <Signature> vào trong;
 *      KHÔNG dùng thẻ tự đóng <CKyDTu/>.
 *   4. Tên khối phụ lục giảm thuế GTGT là tên kỹ thuật CỐ ĐỊNH của bộ chuẩn XML
 *      (PL_NQ142_GTGT ở phiên bản 2.8.3), không đổi theo từng nghị quyết.
 *      Tên này được HARD-CODE tại PLUC_VAT_REDUCTION_TAG bên dưới, KHÔNG đọc từ DB:
 *      một dòng dữ liệu sai trong vat_reduction_policies từng làm công cụ ký treo
 *      (khối được ghi thành PL_NQ204_GTGT — tên nghị quyết, không có trong bộ chuẩn).
 *   5. Thứ tự các chỉ tiêu phải đúng như XSD (sequence) — đã đối chiếu khớp 100%.
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
 *   ct23_deductible_input_vat  → ct25  ([25] = [24]; [22] KHÔNG cộng vào đây)
 *   ct30_exempt_revenue        → ct26  (HHDV không chịu thuế GTGT)
 *   ct29 = 0                   (xuất khẩu 0% — chưa phân biệt riêng)
 *   ct32_revenue_5pct + ct33   → HHDVBRaChiuTSuat5/ct30, ct31
 *   ct36_revenue_10pct + ct34  → HHDVBRaChiuTSuat10/ct32, ct33  (8% gộp vào nhóm 10%)
 *   ct40_total_output_revenue  → TongDThuVaThueGTGTHHDVBRa/ct34
 *   ct40a_total_output_vat     → ct35  (trước NQ142)
 *   ct35 - ct25                → ct36  (Thuế GTGT phát sinh trong kỳ = net VAT)
 *   plucOutputSumReduction     → ct38  (Điều chỉnh giảm — giảm NQ142/NQ204 2% × DT 8%)
 *   MAX(0, ct36-ct22+ct37-ct38)    → ct40a, ct40  (phải nộp — 0 khi đầu vào > đầu ra)
 *   MAX(0, -(ct36-ct22+ct37-ct38)) → ct41, ct43   (kết chuyển — 0 khi đầu ra > đầu vào)
 *   ct41_payable_vat           → ct41
 *   ct43_carry_forward_vat     → ct43
 */
/**
 * Tên khối phụ lục giảm thuế GTGT trong bộ chuẩn XML 2.8.3 của cơ quan thuế.
 *
 * Đây là TÊN KỸ THUẬT của schema, KHÔNG phải tên nghị quyết đang áp dụng. Hai tờ khai
 * tham chiếu trong repo đều dùng tên này: bản HTKK 5.7.1 và bản đã nộp thành công qua
 * eTax (kỳ Q4/2025). Ghi tên khác (vd PL_NQ204_GTGT) làm công cụ ký / eTax không nhận file.
 * Nghị quyết áp dụng cho từng kỳ nằm ở cột legal_basis của vat_reduction_policies.
 */
const PLUC_VAT_REDUCTION_TAG = 'PL_NQ142_GTGT';

export class HtkkXmlGenerator {
  async generate(declaration: TaxDeclaration): Promise<string> {
    // ── 1. Thông tin công ty ─────────────────────────────────────────────────
    const { rows: companyRows } = await pool.query<CompanyInfo>(
      `SELECT name, tax_code, address, phone, email,
              tax_authority_code, tax_authority_name, signer_name, signer_title,
              business_line_code
         FROM companies WHERE id = $1`,
      [declaration.company_id]
    );
    if (!companyRows.length) throw new Error(`Company not found: ${declaration.company_id}`);
    const co = companyRows[0];

    // ── 2. Giá trị hàng mua vào đủ điều kiện khấu trừ (chưa VAT) ────────────
    // Dùng giá trị đã lưu sẵn trong declaration; fallback về query nếu chưa có (khai báo cũ).
    const isQuarterly = declaration.period_type === 'quarterly';

    // F8: tờ khai bổ sung — loaiTKhai 'B' kèm số lần khai bổ sung
    const declAny     = declaration as unknown as Record<string, unknown>;
    const isAmendment = declAny['declaration_type'] === 'bo_sung';
    const amendmentNo = Number(declAny['amendment_no'] ?? 0) || 1;
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
    // Math.round() bắt buộc: HTKK schema 842 yêu cầu xs:integer, không chấp nhận decimal
    const xml_ct32_revenue = Math.round(n(d.ct36_revenue_10pct) + n(d.ct34_revenue_8pct));
    const xml_ct33_vat     = Math.round(n(d.ct37_vat_10pct) + n(d.ct35_vat_8pct));

    // ct27 = tổng doanh thu chịu thuế (5%+8%+10%), không bao gồm miễn thuế
    const xml_ct27_taxable = Math.round(n(d.ct32_revenue_5pct) + xml_ct32_revenue);
    // ct28 = tổng VAT đầu ra gộp
    const xml_ct28_vat     = Math.round(n(d.ct40a_total_output_vat));
    // ct35 (TongDThuVaThueGTGTHHDVBRa) = tổng VAT đầu ra gộp (trước điều chỉnh NQ142)
    const xml_ct35_total   = Math.round(n(d.ct40a_total_output_vat));

    // ── 3b. Phụ lục NQ142 — chỉ lấy hoá đơn VAT = 8% ──────────────────────
    const [plucInputItems, plucOutputItems] = await Promise.all([
      _fetchPluc8InputItems(d.company_id, d.period_month, d.period_year, isQuarterly),
      _fetchPluc8OutputItems(d.company_id, d.period_month, d.period_year, isQuarterly),
    ]);

    const plucInputSumSubtotal   = plucInputItems.reduce((s, r) => s + r.subtotal,     0);
    const plucInputSumVat        = plucInputItems.reduce((s, r) => s + r.vatAmount,    0);
    // Dùng giá trị đã được Tax Engine tính chính xác từ declaration thay vì tự tổng từ query.
    // Query phụ lục có thể bỏ sót một số hóa đơn 8% (e.g. line items không có vat_rate rõ ràng),
    // dẫn đến tongCongGiaTriHHDV lệch với [32] trên tờ khai.
    // F5-FIX: nghị quyết giảm thuế GTGT tra theo KỲ TÍNH THUẾ (bảng vat_reduction_policies),
    // không gắn cứng NQ142/2024 nữa. Mức giảm = chênh lệch thuế suất theo quy định và sau giảm.
    const reductionPolicy = await taxPolicyService.vatReduction(
      declaration.period_year, declaration.period_month, isQuarterly,
    );
    const reductionRate = reductionPolicy
      ? (reductionPolicy.standardRate - reductionPolicy.reducedRate) / 100
      : 0.02;
    const plucOutputSumSubtotal  = Math.round(n(d.ct34_revenue_8pct));
    const plucOutputSumReduction = Math.round(plucOutputSumSubtotal * reductionRate);

    // ── Chỉ tiêu khấu trừ theo đúng mẫu 01/GTGT (TT80/2021) ─────────────────
    //
    // [24] Thuế GTGT của HHDV mua vào             = thuế đầu vào phát sinh trong kỳ
    // [25] Tổng số thuế GTGT được khấu trừ KỲ NÀY = [24] (chưa gồm [22])
    // [22] Thuế GTGT còn được khấu trừ KỲ TRƯỚC chuyển sang — KHÔNG cộng vào [25],
    //      mà được trừ ở bước [40a]/[41].
    //
    // Đối chiếu tờ khai HTKK 5.7.1 thật (Q2/2026, MST 0319303270):
    //   [22]=1.823.054  [24]=8.005.715  [25]=8.005.715  ⇒ [25] = [24], không cộng [22]
    //   [35]=6.293.492  [36]=-1.712.223 = [35] - [25]
    //   [41]= 3.535.277 = -([36] - [22])                ⇒ [22] trừ ở [40a]/[41]
    //
    // Cách cũ (gộp [22] vào [25]) cho ra [41] bằng nhau nhưng ghi sai [25] và [36];
    // khi eTax/HTKK tự tính lại thì [22] bị trừ HAI LẦN, số kết chuyển kỳ sau sai lệch
    // đúng bằng [22].
    const xml_ct24 = Math.round(n(d.ct23_deductible_input_vat));   // [24]
    const xml_ct25 = xml_ct24;                                     // [25] = [24]
    const xml_ct22 = Math.round(n(d.ct24_carried_over_vat));       // [22]

    // [36] = [35] - [25]
    const xml_ct36 = xml_ct35_total - xml_ct25;

    // [37] = prior-period adjustments that increase output VAT + manual override
    const xml_ct37 = Math.round(n(d.ct37_auto_decrease ?? 0) + n(d.ct37_adjustment_decrease ?? 0));

    // [38] = prior-period adjustments that reduce output VAT / increase deductible + manual override.
    // NQ142 invoices are already issued at 8% rate — their actual VAT is in [35] directly.
    // Do NOT include plucOutputSumReduction here: that would be a double-reduction.
    const xml_ct38 = Math.round(n(d.ct38_auto_increase ?? 0) + n(d.ct38_adjustment_increase ?? 0));

    // [40a] = MAX(0, [36] - [22] + [37] - [38] - [39a]) — [39a] hiện luôn = 0
    const xml_ct40a_raw = xml_ct36 - xml_ct22 + xml_ct37 - xml_ct38;
    // ct40a/ct40: phải nộp — chỉ > 0 khi đầu ra > đầu vào
    const xml_ct40a = Math.max(0, xml_ct40a_raw);
    // ct40b = bù trừ dự án đầu tư (nhập tay)
    const xml_ct40b = Math.round(n(d.ct40b_investment_vat ?? 0));
    const xml_ct40  = Math.max(0, xml_ct40a - xml_ct40b);
    // ct41: còn được khấu trừ chưa hết — chỉ > 0 khi đầu vào > đầu ra
    const xml_ct41  = Math.max(0, -xml_ct40a_raw) + Math.max(0, xml_ct40b - xml_ct40a);
    // ct43: kết chuyển sang kỳ sau = ct41 - ct42 (ct42 = 0)
    const xml_ct43  = xml_ct41;

    // [26] = doanh thu không chịu thuế (KCT). Dùng ct26_kct_revenue nếu có, fallback ct30.
    const xml_ct26  = Math.round(n(d.ct26_kct_revenue ?? d.ct30_exempt_revenue));
    // [29] = doanh thu thuế suất 0% (xuất khẩu)
    const xml_ct29  = Math.round(n(d.ct29_0pct_revenue ?? 0));
    // [32a] = doanh thu KKKNT
    const xml_ct32a = Math.round(n(d.ct32a_kkknt_revenue ?? 0));
    // [21] = không phát sinh (checkbox)
    const xml_ct21  = d.ct21_no_activity ? 'true' : 'false';

    // ── 4. Ngày kỳ khai ──────────────────────────────────────────────────────
    const period = buildPeriod(declaration.period_month, declaration.period_year, isQuarterly);

    // ── 5. Ngày lập tờ khai ───────────────────────────────────────────────────
    const now = new Date();
    const ngayLap = fmtDDMMYYYY(now);
    const ngayKy  = fmtISODate(now);

    // ── 6. Tạo XML ────────────────────────────────────────────────────────────
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HSoThueDTu xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
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
                    <loaiTKhai>${isAmendment ? 'B' : 'C'}</loaiTKhai>
                    <soLan>${isAmendment ? amendmentNo : 0}</soLan>
                    <KyKKhaiThue>
                        <kieuKy>${period.kieuKy}</kieuKy>
                        <kyKKhai>${period.kyKKhai}</kyKKhai>
                        <kyKKhaiTuNgay>${period.tuNgay}</kyKKhaiTuNgay>
                        <kyKKhaiDenNgay>${period.denNgay}</kyKKhaiDenNgay>
                        <kyKKhaiTuThang>${period.tuThang}</kyKKhaiTuThang>
                        <kyKKhaiDenThang>${period.denThang}</kyKKhaiDenThang>
                    </KyKKhaiThue>
                    <maCQTNoiNop>${escapeXml(co.tax_authority_code ?? '')}</maCQTNoiNop>
                    <tenCQTNoiNop>${escapeXml(co.tax_authority_name ?? '')}</tenCQTNoiNop>
                    <ngayLapTKhai>${ngayLap}</ngayLapTKhai>
                    <nguoiKy>${escapeXml(co.signer_name ?? '')}</nguoiKy>
                    <ngayKy>${ngayKy}</ngayKy>
                    <nganhNgheKD>${escapeXml(co.business_line_code ?? '')}</nganhNgheKD>
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
            <ct21>${xml_ct21}</ct21>
            <ct22>${xml_ct22}</ct22>
            <GiaTriVaThueGTGTHHDVMuaVao>
                <ct23>${n(inputSubtotal)}</ct23>
                <ct24>${xml_ct24}</ct24>
            </GiaTriVaThueGTGTHHDVMuaVao>
            <HangHoaDichVuNhapKhau>
                <ct23a>0</ct23a>
                <ct24a>0</ct24a>
            </HangHoaDichVuNhapKhau>
            <ct25>${xml_ct25}</ct25>
            <ct26>${xml_ct26}</ct26>
            <HHDVBRaChiuThueGTGT>
                <ct27>${xml_ct27_taxable}</ct27>
                <ct28>${xml_ct28_vat}</ct28>
            </HHDVBRaChiuThueGTGT>
            <ct29>${xml_ct29}</ct29>
            <HHDVBRaChiuTSuat5>
                <ct30>${Math.round(n(d.ct32_revenue_5pct))}</ct30>
                <ct31>${Math.round(n(d.ct33_vat_5pct))}</ct31>
            </HHDVBRaChiuTSuat5>
            <HHDVBRaChiuTSuat10>
                <ct32>${xml_ct32_revenue}</ct32>
                <ct33>${xml_ct33_vat}</ct33>
            </HHDVBRaChiuTSuat10>
            <ct32a>${xml_ct32a}</ct32a>
            <TongDThuVaThueGTGTHHDVBRa>
                <ct34>${Math.round(n(d.ct40_total_output_revenue))}</ct34>
                <ct35>${xml_ct35_total}</ct35>
            </TongDThuVaThueGTGTHHDVBRa>
            <ct36>${xml_ct36}</ct36>
            <ct37>${xml_ct37}</ct37>
            <ct38>${xml_ct38}</ct38>
            <ct39a>0</ct39a>
            <ct40a>${xml_ct40a}</ct40a>
            <ct40b>${xml_ct40b}</ct40b>
            <ct40>${xml_ct40}</ct40>
            <ct41>${xml_ct41}</ct41>
            <ct42>0</ct42>
            <ct43>${xml_ct43}</ct43>
        </CTieuTKhaiChinh>
        ${_buildPlucXml(plucInputItems, plucOutputItems, plucInputSumSubtotal, plucInputSumVat, plucOutputSumSubtotal, plucOutputSumReduction, reductionPolicy)}
    </HSoKhaiThue>
    <CKyDTu></CKyDTu>
</HSoThueDTu>`;

    // F11: kiểm tra đẳng thức bắt buộc trước khi lưu — không chặn, nhưng ghi log rõ ràng
    const equationErrors = validateVatDeclarationXml(xml);
    if (equationErrors.length > 0) {
      console.error('[HtkkXml] Tờ khai vi phạm đẳng thức mẫu 01/GTGT', {
        declarationId: declaration.id,
        period: `${declaration.period_month}/${declaration.period_year}`,
        errors: equationErrors,
      });
    }

    // Lưu XML vào DB
    await pool.query(
      `UPDATE tax_declarations SET xml_content = $1, xml_generated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [xml, declaration.id]
    );

    return xml;
  }
}


/**
 * F11 — CHỐT CHẶN: kiểm tra các đẳng thức bắt buộc của mẫu 01/GTGT trước khi nộp.
 *
 * Mẫu tờ khai có các quan hệ cố định giữa các chỉ tiêu; HTKK tự tính lại khi nạp file,
 * nên nếu XML không thoả các quan hệ này thì số liệu hiển thị trên HTKK sẽ khác với
 * số liệu người dùng nhìn thấy trong phần mềm. Lỗi chỉ tiêu [36] trước đây thuộc loại này.
 *
 * Trả về danh sách vi phạm (rỗng = hợp lệ).
 */
/**
 * Kiểm tra các trường bắt buộc để eTax NHẬN được file (khác với đẳng thức số học).
 *
 * Thiếu mã cơ quan thuế nơi nộp là lỗi hay gặp nhất: file vẫn ký số được nhưng khi nộp
 * thì eTax không biết định tuyến hồ sơ về đâu, màn hình nộp đứng im. Tờ khai tham chiếu
 * đã nộp thành công đều có maCQTNoiNop (70111 / 70101).
 */
export function validateDeclarationHeader(xml: string): string[] {
  const text = (tag: string): string => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    return (m?.[1] ?? '').trim();
  };

  const errors: string[] = [];
  if (!text('maCQTNoiNop')) {
    errors.push('Thiếu mã cơ quan thuế nơi nộp — khai tại Cài đặt → Hồ sơ thuế trước khi nộp');
  }
  if (!text('mst')) {
    errors.push('Thiếu mã số thuế người nộp thuế');
  }
  return errors;
}

export function validateVatDeclarationXml(xml: string): string[] {
  const num = (tag: string): number => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
    if (!m) return 0;
    const v = parseFloat(String(m[1]).replace(/,/g, ''));
    return isNaN(v) ? 0 : v;
  };

  const ct = {
    c22: num('ct22'), c24: num('ct24'), c25: num('ct25'), c26: num('ct26'),
    c27: num('ct27'), c28: num('ct28'), c29: num('ct29'), c30: num('ct30'),
    c31: num('ct31'), c32: num('ct32'), c33: num('ct33'), c32a: num('ct32a'),
    c34: num('ct34'), c35: num('ct35'), c36: num('ct36'), c37: num('ct37'),
    c38: num('ct38'), c40a: num('ct40a'), c40b: num('ct40b'), c40: num('ct40'),
    c41: num('ct41'), c42: num('ct42'), c43: num('ct43'),
  };

  const errors: string[] = [];
  const check = (ok: boolean, msg: string): void => { if (!ok) errors.push(msg); };
  const eq = (a: number, b: number): boolean => Math.abs(a - b) <= 1;   // sai số làm tròn 1đ

  // [25] là "tổng thuế được khấu trừ KỲ NÀY" = [24]; [22] của kỳ trước được trừ ở [40a]/[41].
  check(eq(ct.c25, ct.c24), `[25] phải = [24] (đang là ${ct.c25} ≠ ${ct.c24})`);
  check(eq(ct.c28, ct.c31 + ct.c33), `[28] phải = [31] + [33] (đang là ${ct.c28} ≠ ${ct.c31 + ct.c33})`);
  check(eq(ct.c27, ct.c29 + ct.c30 + ct.c32), `[27] phải = [29] + [30] + [32]`);
  check(eq(ct.c34, ct.c26 + ct.c27 + ct.c32a), `[34] phải = [26] + [27] + [32a]`);
  check(eq(ct.c35, ct.c28), `[35] phải = [28]`);
  check(eq(ct.c36, ct.c35 - ct.c25), `[36] phải = [35] - [25] (đang là ${ct.c36} ≠ ${ct.c35 - ct.c25})`);
  check(eq(ct.c40a, Math.max(0, ct.c36 - ct.c22 + ct.c37 - ct.c38)),
        `[40a] phải = max(0, [36] - [22] + [37] - [38])`);
  check(eq(ct.c41, Math.max(0, -(ct.c36 - ct.c22 + ct.c37 - ct.c38)) + Math.max(0, ct.c40b - ct.c40a)),
        `[41] phải = max(0, -([36] - [22] + [37] - [38])) (đang là ${ct.c41})`);
  check(eq(ct.c40, Math.max(0, ct.c40a - ct.c40b)), `[40] phải = [40a] - [40b]`);
  check(eq(ct.c43, ct.c41 - ct.c42), `[43] phải = [41] - [42]`);
  check(!(ct.c40 > 0 && ct.c41 > 0), `[40] và [41] không thể cùng dương (vừa phải nộp vừa còn khấu trừ)`);

  return errors;
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
         cash_risk_acknowledged = true
         OR (
           invoice_date < DATE '2025-07-01'
           AND (
             total_amount <= 20000000
             OR (payment_method IS NOT NULL AND LOWER(TRIM(payment_method)) <> 'cash')
           )
         )
         OR (
           invoice_date >= DATE '2025-07-01'
           AND (
             total_amount < 5000000
             OR (payment_method IS NOT NULL AND LOWER(TRIM(payment_method)) <> 'cash')
           )
         )
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

/**
 * Điều kiện NOT EXISTS để loại hóa đơn bị điều chỉnh (tc_hdon=3 của hóa đơn khác trỏ vào).
 * Đảm bảo chỉ giữ lại hóa đơn điều chỉnh (tc_hdon=3), loại hóa đơn gốc đã bị điều chỉnh.
 * Belt-and-suspenders bên cạnh status='adjusted' — xử lý trường hợp status chưa được cập nhật.
 * @param alias tên alias của bảng invoices trong câu query chính
 */
function _notAdjustedClause(alias: string): string {
  return `AND NOT EXISTS (
       SELECT 1 FROM invoices _a
       WHERE _a.tc_hdon = 3
         AND _a.deleted_at IS NULL
         AND _a.company_id = ${alias}.company_id
         AND TRIM(COALESCE(_a.khhd_cl_quan,  '')) = TRIM(COALESCE(${alias}.serial_number,  ''))
         AND TRIM(COALESCE(_a.so_hd_cl_quan, '')) = TRIM(COALESCE(${alias}.invoice_number, ''))
         AND COALESCE(_a.seller_tax_code, '') = COALESCE(${alias}.seller_tax_code, '')
     )`;
}

function _normalizedPercentRateExpr(rateExpr: string): string {
  return `CASE
            WHEN ${rateExpr} IS NULL THEN NULL
            WHEN ABS(${rateExpr}) > 0 AND ABS(${rateExpr}) < 1 THEN ${rateExpr} * 100
            ELSE ${rateExpr}
          END`;
}

function _lineItemEightPercentClause(alias: string): string {
  const normalizedRateExpr = _normalizedPercentRateExpr(`${alias}.vat_rate`);
  return `(
        ROUND((${normalizedRateExpr})::numeric, 2) = 8.00
        OR TRIM(COALESCE(${alias}.vat_rate_label, '')) IN ('8', '8%')
        OR (
          (${alias}.vat_rate IS NULL OR ${alias}.vat_rate = 0)
          AND ${alias}.subtotal > 0
          AND ${alias}.vat_amount IS NOT NULL
          AND ROUND(${alias}.vat_amount * 100.0 / ${alias}.subtotal, 2) = 8.00
        )
      )`;
}

function _invoiceEightPercentClause(alias: string): string {
  const normalizedRateExpr = _normalizedPercentRateExpr(`${alias}.vat_rate`);
  return `(
        ROUND((${normalizedRateExpr})::numeric, 2) = 8.00
        OR COALESCE(${alias}.tax_category, '') IN ('8', '8%')
        OR (
          (${alias}.vat_rate IS NULL OR ${alias}.vat_rate = 0)
          AND ${alias}.subtotal > 0
          AND ${alias}.vat_amount IS NOT NULL
          AND ROUND(${alias}.vat_amount * 100.0 / ${alias}.subtotal, 2) = 8.00
        )
      )`;
}

function _noLineItemsClause(invoiceAlias: string): string {
  return `NOT EXISTS (
       SELECT 1
       FROM invoice_line_items _li
       WHERE _li.invoice_id = ${invoiceAlias}.id
         AND _li.deleted_at IS NULL
     )`;
}

/**
 * Điều kiện NOT EXISTS để tier-2 bắt hóa đơn có line items nhưng không có dòng nào là 8%.
 * Nếu tất cả line items đều không khớp 8%, hóa đơn vẫn cần xuất hiện trong phụ lục
 * dựa trên dữ liệu header (buyer_name / seller_name + subtotal).
 */
function _no8PctLineItemsClause(invoiceAlias: string): string {
  return `NOT EXISTS (
       SELECT 1
       FROM invoice_line_items _li
       WHERE _li.invoice_id = ${invoiceAlias}.id
         AND _li.deleted_at IS NULL
         AND ${_lineItemEightPercentClause('_li')}
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
 *
 * Luôn kết hợp cả hai nguồn (UNION logic):
 *   Tier 1 — invoice_line_items: dòng hàng hóa có tsuat=8% từ hóa đơn ĐÃ có line items
 *   Tier 2 — invoices header:    hóa đơn 8% CHƯA có line items (fallback, dùng seller_name)
 *
 * Bao gồm hóa đơn thay thế (tc_hdon=1) và hóa đơn điều chỉnh (tc_hdon=3).
 * Loại trừ hóa đơn bị thay thế, bị điều chỉnh, và đã hủy qua status + safety clauses.
 */
async function _fetchPluc8InputItems(
  companyId: string,
  periodMonth: number,
  periodYear: number,
  quarterly: boolean,
): Promise<PlucInputRow[]> {
  const pf  = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'i.invoice_date', 2);
  const pf2 = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'invoice_date',   2);
  const normalizedLineRateExpr    = _normalizedPercentRateExpr('ili.vat_rate');
  const normalizedInvoiceRateExpr = _normalizedPercentRateExpr('vat_rate');

  // Tier 1: dòng hàng hóa 8% từ hóa đơn đã có line items.
  // Dùng CTE với window function để fallback về i.subtotal / i.vat_amount khi
  // line item có subtotal = 0 (phổ biến ở hóa đơn thay thế/điều chỉnh).
  const { rows: lineRows } = await pool.query<{ name: string; subtotal: string; vat_amount: string }>(
    `SELECT
       COALESCE(NULLIF(TRIM(ili.item_name), ''), 'Hàng hóa/dịch vụ tổng hợp') AS name,
       COALESCE(ROUND(SUM(ili.subtotal)), 0)::bigint AS subtotal,
       COALESCE(
         ROUND(SUM(
           CASE WHEN ili.vat_amount IS NOT NULL AND ili.vat_amount <> 0
                THEN ili.vat_amount
                ELSE ili.subtotal * (${normalizedLineRateExpr}) / 100.0
           END
         )), 0
       )::bigint AS vat_amount
     FROM invoice_line_items ili
     JOIN invoices i ON i.id = ili.invoice_id
     WHERE i.company_id = $1
       AND i.direction = 'input'
       AND i.status = 'valid'
       AND i.deleted_at IS NULL
       AND ili.deleted_at IS NULL
       AND ${_lineItemEightPercentClause('ili')}
       ${_notReplacedClause('i')}
       ${_notAdjustedClause('i')}
       AND ${pf.clause}
     GROUP BY 1
     ORDER BY SUM(ili.subtotal) DESC`,
    [companyId, ...pf.params],
  );

  // Tier 2: hóa đơn 8% không có line items NÀO khớp 8% (fallback — dùng seller_name làm tên mặt hàng).
  // Dùng _no8PctLineItemsClause thay vì _noLineItemsClause để bắt được hóa đơn có line items
  // nhưng không có dòng nào ở mức 8% (line items lưu ở thuế suất khác hoặc thiếu dữ liệu).
  const { rows: invRows } = await pool.query<{ name: string; subtotal: string; vat_amount: string }>(
    `SELECT
       COALESCE(NULLIF(TRIM(seller_name), ''), 'Hàng hóa/dịch vụ tổng hợp') AS name,
       COALESCE(ROUND(SUM(subtotal)), 0)::bigint AS subtotal,
       COALESCE(
         ROUND(SUM(
           CASE WHEN vat_amount IS NOT NULL AND vat_amount <> 0
                THEN vat_amount
                ELSE subtotal * (${normalizedInvoiceRateExpr}) / 100.0
           END
         )), 0
       )::bigint AS vat_amount
     FROM invoices
     WHERE company_id = $1
       AND direction = 'input'
       AND ${_invoiceEightPercentClause('invoices')}
       AND status = 'valid'
       AND deleted_at IS NULL
       AND ${_no8PctLineItemsClause('invoices')}
       ${_notReplacedClause('invoices')}
       ${_notAdjustedClause('invoices')}
       AND ${pf2.clause}
     GROUP BY 1
     ORDER BY SUM(subtotal) DESC`,
    [companyId, ...pf2.params],
  );

  // Merge cả hai nguồn theo tên mặt hàng
  const map = new Map<string, { subtotal: number; vatAmount: number }>();
  for (const r of [...lineRows, ...invRows]) {
    const prev = map.get(r.name) ?? { subtotal: 0, vatAmount: 0 };
    map.set(r.name, {
      subtotal:  prev.subtotal  + Math.round(n(r.subtotal)),
      vatAmount: prev.vatAmount + Math.round(n(r.vat_amount)),
    });
  }
  return Array.from(map.entries())
    .map(([name, v]) => ({ name, subtotal: v.subtotal, vatAmount: v.vatAmount }))
    .sort((a, b) => b.subtotal - a.subtotal);
}

/**
 * Lấy các mặt hàng BÁN RA với VAT = 8% (NQ142, giảm từ 10%) trong kỳ.
 *
 * Luôn kết hợp cả hai nguồn (UNION logic):
 *   Tier 1 — invoice_line_items: dòng hàng hóa có tsuat=8% từ hóa đơn ĐÃ có line items
 *   Tier 2 — invoices header:    hóa đơn 8% CHƯA có line items (fallback, dùng buyer_name)
 *
 * Bao gồm hóa đơn thay thế (tc_hdon=1) và hóa đơn điều chỉnh (tc_hdon=3).
 * Loại trừ hóa đơn bị thay thế, bị điều chỉnh, và đã hủy qua status + safety clauses.
 */
async function _fetchPluc8OutputItems(
  companyId: string,
  periodMonth: number,
  periodYear: number,
  quarterly: boolean,
): Promise<PlucOutputRow[]> {
  const pf  = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'i.invoice_date', 2);
  const pf2 = _buildPeriodFilter(periodMonth, periodYear, quarterly, 'invoice_date',   2);

  // Tier 1: dòng hàng hóa 8% từ hóa đơn đã có line items.
  // Dùng CTE với window function để fallback về i.subtotal khi line item subtotal = 0.
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
       AND ili.deleted_at IS NULL
       AND ${_lineItemEightPercentClause('ili')}
       ${_notReplacedClause('i')}
       ${_notAdjustedClause('i')}
       AND ${pf.clause}
     GROUP BY 1
     ORDER BY SUM(ili.subtotal) DESC`,
    [companyId, ...pf.params],
  );

  // Tier 2: hóa đơn 8% không có line items NÀO khớp 8% (fallback — dùng buyer_name làm tên mặt hàng).
  const { rows: invRows } = await pool.query<{ name: string; subtotal: string }>(
    `SELECT
       COALESCE(NULLIF(TRIM(buyer_name), ''), 'Hàng hóa/dịch vụ tổng hợp') AS name,
       COALESCE(ROUND(SUM(subtotal)), 0)::bigint AS subtotal
     FROM invoices
     WHERE company_id = $1
       AND direction = 'output'
       AND ${_invoiceEightPercentClause('invoices')}
       AND status = 'valid'
       AND deleted_at IS NULL
       AND ${_no8PctLineItemsClause('invoices')}
       ${_notReplacedClause('invoices')}
       ${_notAdjustedClause('invoices')}
       AND ${pf2.clause}
     GROUP BY 1
     ORDER BY SUM(subtotal) DESC`,
    [companyId, ...pf2.params],
  );

  // giảm 2% = (10% - 8%)
  const toOutputRow = (name: string, subtotal: number): PlucOutputRow => ({
    name,
    subtotal,
    vatReduction: Math.round(subtotal * 0.02),
  });

  // Merge cả hai nguồn theo tên mặt hàng
  const map = new Map<string, number>();
  for (const r of [...lineRows, ...invRows]) {
    map.set(r.name, (map.get(r.name) ?? 0) + Math.round(n(r.subtotal)));
  }
  return Array.from(map.entries())
    .map(([name, subtotal]) => toOutputRow(name, subtotal))
    .sort((a, b) => b.subtotal - a.subtotal);
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
  policy:             VatReductionPolicy | null,
): string {
  // Kỳ không có chính sách giảm thuế → không xuất phụ lục (tránh nộp nhầm căn cứ)
  if (!policy) return '<PLuc/>';
  if (inputItems.length === 0 && outputItems.length === 0) return '<PLuc/>';

  const ct9 = outputSumReduction - inputSumVat;

  // Build sections as line arrays — avoids blank lines when items list is empty,
  // ensuring HTKK XSD validation passes (no stray whitespace-only text nodes).
  // Chỉ hiển thị dòng có giá trị tiền trong danh sách; tổng cộng vẫn tính đủ tất cả mặt hàng.
  const visibleInputItems  = inputItems.filter(item => item.subtotal !== 0 || item.vatAmount !== 0);
  const visibleOutputItems = outputItems.filter(item => item.subtotal !== 0);

  const inputLines = [
    ...visibleInputItems.map((item, i) =>
      `                    <BangKeTenHHDV ID="${i + 1}">\n` +
      `                        <tenHHDVMuaVao>${escapeXml(item.name)}</tenHHDVMuaVao>\n` +
      `                        <giaTriHHDVMuaVao>${item.subtotal}</giaTriHHDVMuaVao>\n` +
      `                        <thueGTGTHHDV>${item.vatAmount}</thueGTGTHHDV>\n` +
      `                    </BangKeTenHHDV>`),
    `                    <tongCongGiaTriHHDVMuaVao>${inputSumSubtotal}</tongCongGiaTriHHDVMuaVao>`,
    `                    <tongCongThueGTGTHHDV>${inputSumVat}</tongCongThueGTGTHHDV>`,
  ];

  const outputLines = [
    ...visibleOutputItems.map((item, i) =>
      `                    <BangKeTenHHDV ID="${i + 1}">\n` +
      `                        <tenHHDV>${escapeXml(item.name)}</tenHHDV>\n` +
      `                        <giaTriHHDV>${item.subtotal}</giaTriHHDV>\n` +
      `                        <thueSuatTheoQuyDinh>${policy.standardRate}</thueSuatTheoQuyDinh>\n` +
      `                        <thueSuatSauGiam>${policy.reducedRate}</thueSuatSauGiam>\n` +
      `                        <thueGTGTDuocGiam>${item.vatReduction}</thueGTGTDuocGiam>\n` +
      `                    </BangKeTenHHDV>`),
    `                    <tongCongGiaTriHHDV>${outputSumSubtotal}</tongCongGiaTriHHDV>`,
    `                    <tongCongThueGTGTDuocGiam>${outputSumReduction}</tongCongThueGTGTDuocGiam>`,
  ];

  // Cảnh báo nếu dữ liệu chính sách trong DB ghi tên khối khác bộ chuẩn — vẫn xuất theo
  // bộ chuẩn để file ký/nộp được, nhưng để lại dấu vết cho người vận hành sửa dữ liệu.
  if (policy.xmlBlockTag && policy.xmlBlockTag !== PLUC_VAT_REDUCTION_TAG) {
    console.warn('[HtkkXml] vat_reduction_policies.xml_block_tag sai bộ chuẩn — đã bỏ qua', {
      inDb: policy.xmlBlockTag, dung: PLUC_VAT_REDUCTION_TAG, hieuLucTu: policy.from,
    });
  }

  return `<PLuc>
            <${PLUC_VAT_REDUCTION_TAG}>
                <HH_DV_MuaVaoTrongKy>
${inputLines.join('\n')}
                </HH_DV_MuaVaoTrongKy>
                <HH_DV_BanRaTrongKy>
${outputLines.join('\n')}
                </HH_DV_BanRaTrongKy>
                <ChenhLech>
                    <ct9>${ct9}</ct9>
                </ChenhLech>
            </${PLUC_VAT_REDUCTION_TAG}>
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
