export const DRAWER_SECTIONS = [
  {
    title: '📊 Phân Tích',
    items: [
      { href: '/reports/trends', label: 'Báo cáo xu hướng' },
      { href: '/reports/monthly', label: 'Báo cáo tháng' },
      { href: '/compare', label: 'So sánh công ty' },
      { href: '/reports/revenue-expense', label: 'Doanh thu & chi phí' },
      { href: '/reports/profit-loss', label: 'Kết quả HĐKD (B02-DN)' },
    ],
  },
  {
    title: '📒 Kế Toán',
    items: [
      { href: '/reports/sales-journal', label: 'Bảng kê bán ra / mua vào' },
      { href: '/reports/inventory', label: 'Xuất Nhập Tồn' },
      { href: '/reports/cash-book', label: 'Sổ Quỹ Tiền' },
      { href: '/declarations/hkd', label: 'Hộ kinh doanh (HKD)' },
    ],
  },
  {
    title: '🗂️ Danh Mục',
    items: [
      { href: '/catalogs/products', label: 'Hàng hóa & dịch vụ' },
      { href: '/catalogs/customers', label: 'Khách hàng' },
      { href: '/catalogs/suppliers', label: 'Nhà cung cấp' },
    ],
  },
  {
    title: '👥 Khách Hàng (CRM)',
    items: [
      { href: '/crm/customers', label: 'Danh sách & RFM' },
      { href: '/crm/repurchase', label: 'Dự đoán mua lại' },
      { href: '/crm/aging', label: 'Báo cáo nợ' },
    ],
  },
  {
    title: '🏭 Nhà Cung Cấp',
    items: [
      { href: '/vendors', label: 'Tổng quan NCC' },
      { href: '/vendors/price-alerts', label: 'Cảnh báo giá' },
    ],
  },
  {
    title: '📦 Sản Phẩm',
    items: [
      { href: '/products/profitability', label: 'Lợi nhuận sản phẩm' },
    ],
  },
  {
    title: '💰 Dòng Tiền',
    items: [
      { href: '/cashflow', label: 'Dự báo 90 ngày' },
    ],
  },
  {
    title: '📥 Nhập Dữ Liệu',
    items: [
      { href: '/import', label: 'Import hóa đơn' },
      { href: '/import/history', label: 'Lịch sử import' },
      { href: '/settings/bot', label: 'GDT Bot' },
    ],
  },
  {
    title: '🔍 Kiểm Toán AI',
    items: [
      { href: '/audit/anomalies',      label: 'Phát hiện bất thường' },
      { href: '/audit/ghost-companies', label: 'Đánh giá rủi ro' },
      { href: '/audit/tax-rates',      label: 'Thuế suất bất thường' },
      { href: '/audit/cash-payment',   label: 'Hóa đơn tiền mặt' },
      { href: '/settings/audit-rules', label: 'Cấu hình quy tắc' },
    ],
  },
  {
    title: '⚠️ Rủi Ro Hóa Đơn',
    items: [
      { href: '/invoices/amended', label: 'Hóa đơn điều chỉnh/thay thế' },
      { href: '/invoices/missing', label: 'Hóa đơn đầu vào thiếu' },
    ],
  },
  {
    title: '🧮 Công Cụ Thuế',
    items: [
      { href: '/tools/penalty-calculator', label: 'Tính tiền phạt nộp chậm' },
    ],
  },
  {
    title: '🏢 Đa Công Ty',
    items: [
      { href: '/portfolio', label: 'Danh mục tổng' },
    ],
  },
];

export const DRAWER_HREFS = DRAWER_SECTIONS.flatMap((s) => s.items.map((i) => i.href));

// Only these sections are currently visible in the "Thêm" menu.
// Remaining sections are preserved above for future re-enabling.
export const VISIBLE_DRAWER_SECTIONS = [
  {
    title: '🗂️ Danh Mục',
    items: [
      { href: '/catalogs/products',  label: 'Hàng hóa & dịch vụ' },
      { href: '/catalogs/customers', label: 'Khách hàng' },
      { href: '/catalogs/suppliers', label: 'Nhà cung cấp' },
    ],
  },
  {
    title: '📒 Kế Toán',
    items: [
      { href: '/reports/sales-journal', label: 'Bảng kê bán ra / mua vào' },
    ],
  },
];

export const VISIBLE_DRAWER_HREFS = VISIBLE_DRAWER_SECTIONS.flatMap((s) => s.items.map((i) => i.href));

// ── HKD-only section (shown only when activeCompany is household) ──────────
export const HKD_REPORT_SECTION = {
  title: '🏪 Sổ Sách HKD',
  items: [
    { href: '/reports/hkd/s1a', label: 'S1a – Chi tiết doanh thu' },
    { href: '/reports/hkd/s2a', label: 'S2a – Doanh thu (GTGT+TNCN)' },
    { href: '/reports/hkd/s2b', label: 'S2b – Doanh thu (GTGT)' },
    { href: '/reports/hkd/s2c', label: 'S2c – Doanh thu & Chi phí' },
    { href: '/reports/hkd/s2d', label: 'S2d – Vật liệu, hàng hóa' },
    { href: '/reports/hkd/s2e', label: 'S2e – Chi tiết tiền' },
    { href: '/reports/hkd/s3a', label: 'S3a – Nghĩa vụ thuế khác' },
  ],
};

export const HKD_REPORT_HREFS = HKD_REPORT_SECTION.items.map((i) => i.href);
