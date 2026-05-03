import { pool } from '../db/pool';

interface PitDeclaration {
  id: string;
  company_id: string;
  period_quarter: number;
  period_year: number;
  loai_tkhai: string;
  so_lan: number;
  ma_cqt_noi_nop: string | null;
  ten_cqt_noi_nop: string | null;
  mst_cu: string | null;
  nguoi_ky: string | null;
  ct15: number; ct16: number; ct17: number; ct18: number;
  ct19: number; ct20: number; ct21: number; ct22: number;
  ct23: number; ct24: number; ct25: number; ct25_1: number;
  ct26: number; ct27: number; ct28: number; ct29: number;
  ct30: number; ct31: number; ct32: number;
}

interface CompanyInfo {
  tax_code: string;
  name: string;
  address: string | null;
  ward_name: string | null;
  ward_code: string | null;
  province_code: string | null;
  province_name: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
}

function escapeXml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function quarterDateRange(quarter: number, year: number): { kyKKhai: string; tuNgay: string; denNgay: string } {
  const starts = ['01/01', '01/04', '01/07', '01/10'];
  const ends   = ['31/03', '30/06', '30/09', '31/12'];
  const q = quarter - 1;
  return {
    kyKKhai: `${quarter}/${year}`,
    tuNgay: `${starts[q]}/${year}`,
    denNgay: `${ends[q]}/${year}`,
  };
}

function formatDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${y}-${m}-${d}`;
}

export class PitDeclarationXmlGenerator {
  async generate(declaration: PitDeclaration): Promise<string> {
    const { rows } = await pool.query<CompanyInfo>(
      `SELECT
         tax_code,
         name,
         address,
         NULL AS ward_name,
         NULL AS ward_code,
         NULL AS province_code,
         NULL AS province_name,
         phone,
         NULL AS fax,
         email
       FROM companies WHERE id = $1`,
      [declaration.company_id],
    );
    const company = rows[0];
    if (!company) throw new Error('Company not found');

    const today = formatDate(new Date());
    const ngayKy = today;
    const { kyKKhai, tuNgay, denNgay } = quarterDateRange(declaration.period_quarter, declaration.period_year);

    const maCqt   = escapeXml(declaration.ma_cqt_noi_nop ?? '');
    const tenCqt  = escapeXml(declaration.ten_cqt_noi_nop ?? '');
    const nguoiKy = escapeXml(declaration.nguoi_ky ?? '');
    const mst     = escapeXml(company.tax_code);
    const tenNNT  = escapeXml(company.name);
    const dchi    = escapeXml(company.address ?? '');
    const mstCu   = escapeXml(declaration.mst_cu ?? company.tax_code);

    const n = (v: number) => String(Math.round(v ?? 0));

    return `<?xml version="1.0" encoding="UTF-8"?>
<HSoThueDTu xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue">
  <HSoKhaiThue id="ID_1">
    <TTinChung>
      <TTinDVu>
        <maDVu>HTKK</maDVu>
        <tenDVu>HỖ TRỢ KÊ KHAI THUẾ</tenDVu>
        <pbanDVu>5.6.7</pbanDVu>
        <ttinNhaCCapDVu>89D0CFC1799AEB848FD784AF6CF6F202</ttinNhaCCapDVu>
      </TTinDVu>
      <TTinTKhaiThue>
        <TKhaiThue>
          <maTKhai>864</maTKhai>
          <tenTKhai>TK khấu trừ thuế thu nhập cá nhân Mẫu 05/KK-TNCN (TT80/2021)</tenTKhai>
          <moTaBMau>(Ban hành kèm theo Thông tư số 80/2021/TT-BTC ngày 29 tháng 9 năm 2021 của Bộ trưởng Bộ Tài chính)</moTaBMau>
          <pbanTKhaiXML>2.9.3</pbanTKhaiXML>
          <loaiTKhai>${escapeXml(declaration.loai_tkhai)}</loaiTKhai>
          <soLan>${declaration.so_lan}</soLan>
          <KyKKhaiThue>
            <kieuKy>Q</kieuKy>
            <kyKKhai>${kyKKhai}</kyKKhai>
            <kyKKhaiTuNgay>${tuNgay}</kyKKhaiTuNgay>
            <kyKKhaiDenNgay>${denNgay}</kyKKhaiDenNgay>
            <kyKKhaiTuThang />
            <kyKKhaiDenThang />
          </KyKKhaiThue>
          <maCQTNoiNop>${maCqt}</maCQTNoiNop>
          <tenCQTNoiNop>${tenCqt}</tenCQTNoiNop>
          <ngayLapTKhai>${today}</ngayLapTKhai>
          <GiaHan>
            <maLyDoGiaHan />
            <lyDoGiaHan />
          </GiaHan>
          <nguoiKy>${nguoiKy}</nguoiKy>
          <ngayKy>${ngayKy}</ngayKy>
          <nganhNgheKD />
        </TKhaiThue>
        <NNT>
          <mst>${mst}</mst>
          <tenNNT>${tenNNT}</tenNNT>
          <dchiNNT>${dchi}</dchiNNT>
          <tenXaNNT></tenXaNNT>
          <maXaNNT></maXaNNT>
          <maHuyenNNT />
          <tenHuyenNNT />
          <maTinhNNT></maTinhNNT>
          <tenTinhNNT></tenTinhNNT>
          <dthoaiNNT>${escapeXml(company.phone ?? '')}</dthoaiNNT>
          <faxNNT></faxNNT>
          <emailNNT>${escapeXml(company.email ?? '')}</emailNNT>
        </NNT>
      </TTinTKhaiThue>
    </TTinChung>
    <CTieuTKhaiChinh>
      <mst_cu>${mstCu}</mst_cu>
      <ct15>${n(declaration.ct15)}</ct15>
      <ct16>${n(declaration.ct16)}</ct16>
      <ct17>${n(declaration.ct17)}</ct17>
      <ct18>${n(declaration.ct18)}</ct18>
      <ct19>${n(declaration.ct19)}</ct19>
      <ct20>${n(declaration.ct20)}</ct20>
      <ct21>${n(declaration.ct21)}</ct21>
      <ct22>${n(declaration.ct22)}</ct22>
      <ct23>${n(declaration.ct23)}</ct23>
      <ct24>${n(declaration.ct24)}</ct24>
      <ct25>${n(declaration.ct25)}</ct25>
      <ct25_1>${n(declaration.ct25_1)}</ct25_1>
      <ct26>${n(declaration.ct26)}</ct26>
      <ct27>${n(declaration.ct27)}</ct27>
      <ct28>${n(declaration.ct28)}</ct28>
      <ct29>${n(declaration.ct29)}</ct29>
      <ct30>${n(declaration.ct30)}</ct30>
      <ct31>${n(declaration.ct31)}</ct31>
      <ct32>${n(declaration.ct32)}</ct32>
    </CTieuTKhaiChinh>
  </HSoKhaiThue>
</HSoThueDTu>`;
  }
}
