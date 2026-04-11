/**
 * HkdHtkkXmlGenerator — tạo XML HTKK chuẩn TT40/2021 cho tờ khai HKD/CNKD (maTKhai=473).
 *
 * ct28..ct31 = nhóm ngành (KHÔNG phải tháng):
 *   ct28 = [28] Phân phối, cung cấp hàng hóa        → GTGT 1%, TNCN 0.5%
 *   ct29 = [29] Dịch vụ, xây dựng không bao thầu NVL → GTGT 5%, TNCN 2%
 *   ct30 = [30] Sản xuất, vận tải, XD có bao thầu NVL→ GTGT 3%, TNCN 1.5%
 *   ct31 = [31] Hoạt động kinh doanh khác            → GTGT 2%, TNCN 1%
 *   ct32 = Tổng cộng
 */
import { pool } from '../db/pool';
import { HkdDeclaration } from './HkdDeclarationEngine';

interface CompanyInfo {
  name: string;
  tax_code: string;
  address: string | null;
  phone: string | null;
  email: string | null;
}

interface SoldItem {
  name: string;         // tên hàng hóa/dịch vụ
  unit: string;         // đơn vị tính
  qty_sold: number;     // số lượng bán ra
  revenue_sold: number; // doanh thu bán ra (ct15)
}

export class HkdHtkkXmlGenerator {
  async generate(declaration: HkdDeclaration): Promise<string> {
    // ── 1. Thông tin công ty ────────────────────────────────────────────────
    const { rows: coRows } = await pool.query<CompanyInfo>(
      `SELECT name, tax_code, address, phone, email FROM companies WHERE id = $1`,
      [declaration.company_id],
    );
    if (!coRows.length) throw new Error(`Company not found: ${declaration.company_id}`);
    const co = coRows[0];

    // ── 2. Bảng kê hàng hóa bán ra từ line items trong quý ─────────────────
    const q = declaration.period_quarter;
    const year = declaration.period_year;
    const m1 = (q - 1) * 3 + 1;
    const m3 = q * 3;

    const { rows: itemRows } = await pool.query<{
      name: string; unit: string; qty: string; revenue: string;
    }>(
      `SELECT
         COALESCE(NULLIF(TRIM(ili.item_name), ''), 'Hàng hóa tổng hợp') AS name,
         COALESCE(NULLIF(TRIM(ili.unit), ''), 'Cái')                     AS unit,
         COALESCE(SUM(ili.quantity), 0)::numeric                         AS qty,
         COALESCE(ROUND(SUM(ili.subtotal)), 0)::bigint                   AS revenue
       FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       WHERE i.company_id = $1
         AND i.direction  = 'output'
         AND i.status     = 'valid'
         AND i.deleted_at IS NULL
         AND EXTRACT(YEAR  FROM i.invoice_date) = $2
         AND EXTRACT(MONTH FROM i.invoice_date) BETWEEN $3 AND $4
         AND NOT EXISTS (
           SELECT 1 FROM invoices _r
           WHERE _r.tc_hdon = 1
             AND _r.deleted_at IS NULL
             AND _r.company_id      = i.company_id
             AND _r.khhd_cl_quan    = i.serial_number
             AND _r.so_hd_cl_quan   = i.invoice_number
             AND COALESCE(_r.seller_tax_code, '') = COALESCE(i.seller_tax_code, '')
         )
       GROUP BY 1, 2
       ORDER BY SUM(ili.subtotal) DESC
       LIMIT 20`,
      [declaration.company_id, year, m1, m3],
    );

    const soldItems: SoldItem[] = itemRows.length > 0
      ? itemRows.map(r => ({
          name:         r.name,
          unit:         r.unit,
          qty_sold:     Math.round(Number(r.qty)),
          revenue_sold: Number(r.revenue),
        }))
      : [{
          name:         'Hàng hóa/dịch vụ kinh doanh',
          unit:         'Cái',
          qty_sold:     0,
          revenue_sold: declaration.revenue_total,
        }];

    // ── 3. Ngày kỳ khai ─────────────────────────────────────────────────────
    const kyKKhai   = `${q}/${year}`;
    const tuNgay    = _fmtDDMMYYYY(new Date(year, m1 - 1, 1));
    const denNgay   = _fmtDDMMYYYY(new Date(year, m3, 0));  // last day of m3
    const tuThang   = `${String(m1).padStart(2, '0')}/${year}`;
    const denThang  = `${String(m3).padStart(2, '0')}/${year}`;

    const now = new Date();
    const ngayLap = _fmtISODate(now);

    // ── 4. Chỉ tiêu XML ─────────────────────────────────────────────────────
    const d = declaration;
    const g = Number(d.industry_group) || 28; // nhóm ngành: 28, 29, 30, 31

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HSoThueDTu xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://kekhaithue.gdt.gov.vn/TKhaiThue">
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
          <maTKhai>473</maTKhai>
          <tenTKhai>Tờ khai thuế đối với hộ kinh doanh, cá nhân kinh doanh</tenTKhai>
          <moTaBMau>(Ban hành kèm theo Thông tư số 40/2021/TT-BTC ngày 01/6/2021 của Bộ trưởng Bộ Tài Chính)</moTaBMau>
          <pbanTKhaiXML>2.8.3</pbanTKhaiXML>
          <loaiTKhai>C</loaiTKhai>
          <soLan>0</soLan>
          <KyKKhaiThue>
            <kieuKy>Q</kieuKy>
            <kyKKhai>${_esc(kyKKhai)}</kyKKhai>
            <kyKKhaiTuNgay>${tuNgay}</kyKKhaiTuNgay>
            <kyKKhaiDenNgay>${denNgay}</kyKKhaiDenNgay>
            <kyKKhaiTuThang>${tuThang}</kyKKhaiTuThang>
            <kyKKhaiDenThang>${denThang}</kyKKhaiDenThang>
          </KyKKhaiThue>
          <maCQTNoiNop/>
          <tenCQTNoiNop/>
          <ngayLapTKhai>${ngayLap}</ngayLapTKhai>
          <GiaHan>
            <maLyDoGiaHan/>
            <lyDoGiaHan/>
          </GiaHan>
          <nguoiKy/>
          <ngayKy>${ngayLap}</ngayKy>
          <nganhNgheKD/>
        </TKhaiThue>
        <NNT>
          <mst>${_esc(co.tax_code)}</mst>
          <tenNNT>${_esc(co.name)}</tenNNT>
          <dchiNNT>${_esc(co.address ?? '')}</dchiNNT>
          <phuongXa/>
          <maHuyenNNT/>
          <tenHuyenNNT/>
          <maTinhNNT/>
          <tenTinhNNT/>
          <dthoaiNNT>${_esc(co.phone ?? '')}</dthoaiNNT>
          <faxNNT/>
          <emailNNT>${_esc(co.email ?? '')}</emailNNT>
        </NNT>
      </TTinTKhaiThue>
    </TTinChung>
    <CTieuTKhaiChinh>
      <mst_cu/>
      <Header>
        <hkdcnkdnopthuekhoan>0</hkdcnkdnopthuekhoan>
        <cnkdnopps>0</cnkdnopps>
        <tccnkhainopthay>0</tccnkhainopthay>
        <hkdcnkdnopkekhai>1</hkdcnkdnopkekhai>
        <hkdcnkdnnxddoanhthu>0</hkdcnkdnnxddoanhthu>
        <hkdchuyendoipptinhthue>0</hkdchuyendoipptinhthue>
        <ct05>${_esc(co.name)}</ct05>
        <ct06/>
        <CT08>
          <NNgheKDoanh id="ID_1">
            <maNNgheKDoanh/>
            <tenNNgheKDoanh/>
          </NNgheKDoanh>
        </CT08>
        <ct08a>0</ct08a>
        <ct09>0</ct09>
        <ct09a>0</ct09a>
        <ct10>0</ct10>
        <CT11>
          <tuGio>8</tuGio>
          <tuPhut>0</tuPhut>
          <denGio>17</denGio>
          <denPhut>0</denPhut>
        </CT11>
        <CT12>
          <ct12a_tdtt>0</ct12a_tdtt>
          <ct12b_soNha>${_esc(co.address ?? '')}</ct12b_soNha>
          <ct12c_maPhuong/>
          <ct12c_tenPhuong/>
          <ct12d_maQuan/>
          <ct12d_tenQuan/>
          <ct12d_maTinh/>
          <ct12d_tenTinh/>
          <ct12e_kdbiengioi>0</ct12e_kdbiengioi>
        </CT12>
        <CT13>
          <ct13a_soNha/>
          <ct13b_maPhuong/>
          <ct13b_tenPhuong/>
          <ct13c_maQuan/>
          <ct13c_tenQuan/>
          <ct13d_maTinh/>
          <ct13d_tenTinh/>
        </CT13>
        <ct17/>
        <ct17_ngay xsi:nil="true"/>
        <CNKDChuaDangKyThue>
          <ct18a_ngaySinh xsi:nil="true"/>
          <ct18b_maQuocTich/>
          <ct18b_tenQuocTich/>
          <ct18c_ma/>
          <ct18c_ten/>
          <ct18c_soCMND_CCCD/>
          <ct18c_1_ngayCap xsi:nil="true"/>
          <ct18c_2_noiCap_loai>01</ct18c_2_noiCap_loai>
          <ct18c_2_noiCap_ten/>
          <ct18c_2_noiCap_ma/>
        </CNKDChuaDangKyThue>
        <ct18k>0</ct18k>
        <ToChucKThay>
          <ct22/>
          <ct23 xsi:nil="true"/>
          <ct24/>
          <ct25/>
          <ct26/>
          <ct27/>
        </ToChucKThay>
      </Header>
      <KKThueGTGT_TNCN>
        <DoanhThuThueGTGT>
          <ct28>${g === 28 ? d.revenue_total : 0}</ct28>
          <ct29>${g === 29 ? d.revenue_total : 0}</ct29>
          <ct30>${g === 30 ? d.revenue_total : 0}</ct30>
          <ct31>${g === 31 ? d.revenue_total : 0}</ct31>
          <ct32>${d.revenue_total}</ct32>
        </DoanhThuThueGTGT>
        <SoThueGTGT>
          <ct28>${g === 28 ? d.vat_total : 0}</ct28>
          <ct29>${g === 29 ? d.vat_total : 0}</ct29>
          <ct30>${g === 30 ? d.vat_total : 0}</ct30>
          <ct31>${g === 31 ? d.vat_total : 0}</ct31>
          <ct32>${d.vat_total}</ct32>
        </SoThueGTGT>
        <DoanhThuThueTNCN>
          <ct28>${g === 28 ? d.revenue_total : 0}</ct28>
          <ct29>${g === 29 ? d.revenue_total : 0}</ct29>
          <ct30>${g === 30 ? d.revenue_total : 0}</ct30>
          <ct31>${g === 31 ? d.revenue_total : 0}</ct31>
          <ct32>${d.revenue_total}</ct32>
        </DoanhThuThueTNCN>
        <SoThueTNCN>
          <ct28>${g === 28 ? d.pit_total : 0}</ct28>
          <ct29>${g === 29 ? d.pit_total : 0}</ct29>
          <ct30>${g === 30 ? d.pit_total : 0}</ct30>
          <ct31>${g === 31 ? d.pit_total : 0}</ct31>
          <ct32>${d.pit_total}</ct32>
        </SoThueTNCN>
      </KKThueGTGT_TNCN>
      <KKhaiThueTTDB>
        <CTietKKhaiThueTTDB id="ID_1">
          <ct2_ma/>
          <ct2_ten/>
          <ct3/>
          <ct4/>
          <ct5>0</ct5>
          <ct6>0</ct6>
          <ct7>0</ct7>
        </CTietKKhaiThueTTDB>
        <tong_ct5>0</tong_ct5>
        <tong_ct7>0</tong_ct7>
      </KKhaiThueTTDB>
      <KKhaiTBVMT_TN>
        <ThueTaiNguyen>
          <CTietThueTaiNguyen id="ID_1">
            <ct2_ma/>
            <ct2_ten/>
            <ct3/>
            <ct4/>
            <ct5>0</ct5>
            <ct6>0</ct6>
            <ct7>0</ct7>
            <ct8>0</ct8>
          </CTietThueTaiNguyen>
          <tongCong>0</tongCong>
        </ThueTaiNguyen>
        <ThueBVMT>
          <CTietThueBVMT id="ID_1">
            <ct2_ma/>
            <ct2_ten/>
            <ct3/>
            <ct4/>
            <ct5>0</ct5>
            <ct6>0</ct6>
            <ct8>0</ct8>
          </CTietThueBVMT>
          <tongCong>0</tongCong>
        </ThueBVMT>
        <PhiBVMT>
          <CTietPhiBVMT id="ID_1">
            <ct2_ma/>
            <ct2_ten/>
            <ct3/>
            <ct4/>
            <ct5>0</ct5>
            <ct6>0</ct6>
            <ct8>0</ct8>
          </CTietPhiBVMT>
          <tongCong>0</tongCong>
        </PhiBVMT>
      </KKhaiTBVMT_TN>
    </CTieuTKhaiChinh>
    <PLuc>
      <PLuc_01_2_BK_HDKD>
        <VlieuDcuSPHH>
          <BKeVLDCSPHH>
            ${soldItems.map((item, idx) => `<CTietHKDCNKD id="ID_${idx + 1}">
              <ct06>${_esc(item.name)}</ct06>
              <ct07>${_esc(item.unit)}</ct07>
              <ct08>0</ct08>
              <ct09>0</ct09>
              <ct10>0</ct10>
              <ct11>0</ct11>
              <ct12>${item.qty_sold}</ct12>
              <ct13>${item.revenue_sold}</ct13>
              <ct14>${item.qty_sold}</ct14>
              <ct15>${item.revenue_sold}</ct15>
            </CTietHKDCNKD>`).join('\n            ')}
            <ct17>0</ct17>
            <ct19>0</ct19>
            <ct21>${soldItems.reduce((s, it) => s + it.revenue_sold, 0)}</ct21>
            <ct23>${soldItems.reduce((s, it) => s + it.revenue_sold, 0)}</ct23>
          </BKeVLDCSPHH>
        </VlieuDcuSPHH>
        <ChiPhiQL>
          <ct24>0</ct24>
          <ct25>0</ct25>
          <ct26>0</ct26>
          <ct27>0</ct27>
          <ct28>0</ct28>
          <ct29>0</ct29>
          <ct30>0</ct30>
          <ct31>0</ct31>
        </ChiPhiQL>
      </PLuc_01_2_BK_HDKD>
    </PLuc>
  </HSoKhaiThue>
</HSoThueDTu>`;

    // Lưu XML vào DB
    await pool.query(
      `UPDATE hkd_declarations SET xml_content = $1, xml_generated_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [xml, declaration.id],
    );

    return xml;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function _fmtDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function _fmtISODate(d: Date): string {
  return d.toISOString().split('T')[0];
}
