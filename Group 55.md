GROUP 55 — CUSTOMER FEEDBACK FIXES (v2 — từ review thực tế)

Dựa trên feedback khách hàng sau khi dùng thực tế — 6 prompts theo thứ tự ưu tiên.

FIX-INV-01 — Tái cấu trúc Invoice List: 4-cấp giống GDT portal
[Respond in Vietnamese]
CUSTOMER FEEDBACK: Bố cục tab hóa đơn hiện tại phẳng (Loại 5/6/8) không đúng nghiệp vụ.
Cần tái cấu trúc thành 4 cấp CHÍNH XÁC theo GDT portal (hoadondientu.gdt.gov.vn)
để kế toán quen dùng ngay không cần học lại.

HIERARCHY REFERENCE (từ GDT portal thực tế):
  CẤP 1: Hóa đơn bán ra | Hóa đơn mua vào  (2 tab ngang ngang nhau)
  
  CẤP 2 (dropdown/sub-tab): Kết quả kiểm tra
    - Đã cấp mã hóa đơn
    - Cục Thuế đã nhận không mã
    - Cục Thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền
  
  CẤP 3 (tab trong mỗi kết quả):
    - Hóa đơn điện tử  (ký hiệu T — "Mẫu Thường")
    - Hóa đơn có mã khởi tạo từ máy tính tiền  (ký hiệu M — "Mẫu MTT")
  
  CẤP 4: Danh sách hóa đơn theo dạng GRID (bảng lưới, không phải cards)

TASK 1: Redesign /invoices page filter bar:

Layout mới (thay cho tab bar cũ):

Row 1 — Chiều hóa đơn:
  [Tab: Hóa Đơn Mua Vào] [Tab: Hóa Đơn Bán Ra]  ← same level, toggle

Row 2 — Kết quả kiểm tra (dropdown hoặc 3 pills):
  [Tất cả] [Đã cấp mã] [CQT nhận không mã] [Khởi tạo từ máy tính tiền]

Row 3 — Loại hóa đơn (2 pills):
  [Hóa đơn điện tử (T)] [HĐ máy tính tiền (M)]

Row 4 — Search + Bộ lọc bổ sung:
  [Tìm số HĐ, MST, tên...] [Từ ngày] [Đến ngày] [Thuế suất v] [Đồng Bộ ↻]

NOTE: Period selector di chuyển lên cạnh title (giống GDT portal có ô "Từ ngày / Đến ngày"
và hỗ trợ chọn: Ngày cụ thể | Theo tháng | Theo quý | Theo năm — như sync date picker)

TASK 2: Thay cards bằng GRID TABLE (giống GDT portal):

Headers: STT | Mã số thuế | Ký hiệu mẫu số | Ký hiệu HĐ | Số HĐ | Ngày lập | 
         Thông tin người bán/mua | Tổng tiền chưa thuế | Tổng tiền thuế | Trạng thái | Hành động

Each row:
  - Highlight màu nếu có issue: đỏ (lỗi), vàng (cần chú ý), xanh (OK)
  - Badge "Nhóm 6" / "Nhóm 8" cho K-prefix invoices
  - Badge "Thiếu chi tiết" cho invoices chưa có line items
  - Click row → expand inline detail OR navigate to detail page

Pagination: 15/30/50/100 per page (như GDT) — không infinite scroll

Bulk select (checkbox cột đầu):
  Select all on page | Select all matching filter
  Action bar khi có selected: [Gán mã hàng hàng loạt] [Gán mã KH] [Khai báo TT] [Export Excel]

TASK 3: Sticky summary bar above grid:
  Kỳ: [period] | Tổng: [N] HĐ | Tiền hàng: [amount] | Thuế: [amount] | [Xuất Excel]

API changes:
  GET /api/invoices?companyId=&direction=input|output&ktStatus=da_cap_ma|khong_ma|mtt
    &loai=T|M|all&fromDate=&toDate=&search=&page=&pageSize=
  
  Response: { data: Invoice[], meta: { total, page, pageSize, summary: { count, subtotal, vat } } }

IMPORTANT: Keep existing /invoices route — just redesign the UI components.
Mobile: collapse to simplified 2-tab view (Mua vào / Bán ra), grid becomes scrollable table.
FIX-INV-02 — Invoice Grid Inline Editing + Bulk Category Assignment
[Respond in Vietnamese]
CUSTOMER FEEDBACK: "khách cần cập nhật tạo danh mục mã hàng và danh mục mã khách hàng
— tự động hàng loạt hoặc thủ công từng cái tùy chọn"

After the grid is displayed (FIX-INV-01), user needs to:
  1. Click any row → edit fields inline without leaving the page
  2. Select multiple rows → bulk assign codes

TASK 1: Inline row editing in grid:

When user clicks a row (not checkbox), expand an inline edit panel BELOW the row:
  Panel has 3 sections:
  
  A. Phân loại & Danh mục:
    Mã hàng hóa:  [autocomplete từ product_catalog] [+ Tạo mới]
    Mã khách hàng / NCC: [autocomplete từ customer_catalog / supplier_catalog] [+ Tạo mới]
    Danh mục chi phí / doanh thu: [dropdown: Hàng hóa | Dịch vụ | Nguyên vật liệu | ...]
  
  B. Thanh toán:
    Phương thức TT: [Chuyển khoản ✓] [Tiền mặt ✗] [Thẻ] [Séc]
    Ngày thanh toán: [date picker]  (optional)
    Hạn thanh toán: [date picker]   (optional)
  
  C. Ghi chú:
    Note: [text input]
  
  Buttons: [Lưu] [Hủy]
  
  Auto-save on blur (don't require explicit Save for simple field changes)

TASK 2: Bulk assignment mode:

When 2+ rows are selected (checkbox), show action bar:
  "Đã chọn [N] hóa đơn — [Gán mã hàng] [Gán mã khách] [Khai báo TT] [Xuất Excel selected] [Hủy chọn]"

[Gán mã hàng] bulk modal:
  "Gán mã hàng cho [N] hóa đơn đã chọn"
  Mã hàng: [autocomplete from product_catalog]
  Note: "Chỉ áp dụng cho hóa đơn chưa có mã hàng" toggle (default ON)
  [Áp dụng hàng loạt] → PATCH /api/invoices/bulk-update

[Gán mã khách hàng] bulk modal: same pattern

[Khai báo phương thức TT] bulk modal:
  Choose: [Chuyển khoản] [Tiền mặt] [Thẻ]
  [Áp dụng cho [N] hóa đơn]
  → updates payment_method + is_cash_payment_risk calculation

TASK 3: Quick actions per row (⋮ menu):
  [Xem chi tiết] → full detail page
  [Gán mã hàng]  → opens only section A panel
  [Khai báo TT]  → opens only section B panel
  [Ẩn hóa đơn]  → soft delete with reason
  [Bỏ qua vĩnh viễn] → permanent ignore

APIs:
  PATCH /api/invoices/:id  { itemCode?, customerCode?, paymentMethod?, note? }
  PATCH /api/invoices/bulk-update { ids: string[], updates: Partial<InvoiceFields> }
FIX-INV-03 — Group 6/8 Invoice Warning: Làm rõ hơn, bớt rối
[Respond in Vietnamese]
CUSTOMER FEEDBACK: "Cường để dễ đọc như vậy thì hơi rối" (ảnh 15)
HĐ Nhóm 6/8 (K-prefix, không mã CQT) đang hiện cảnh báo khó hiểu.

CURRENT STATE (confusing):
  "Hóa đơn tiêu thức Header — chưa có tên sản phẩm
   Đây là hóa đơn này xuất hiện trong phụ lục của NQXXX từ XML tờ khai,
   vui lòng nhập tên hàng hóa / dịch vụ, giá trị và thuế để xử lý đúng."

REDESIGN the Group 6/8 invoice detail page:

1. Replace confusing technical text with clear user-friendly message:

  INFO BOX (blue, collapsible):
    Icon: ℹ️
    Title: "Hóa đơn không mã CQT (Nhóm 6)"
    Body:
      "Đây là hóa đơn điện tử chưa được Cơ quan Thuế cấp mã. GDT chỉ lưu thông tin tổng hợp,
      không có chi tiết từng mặt hàng.
      
      Điều này KHÔNG ảnh hưởng đến việc khấu trừ VAT — số thuế đầu vào vẫn hợp lệ.
      Nếu cần quản lý chi tiết hàng hóa, bạn có thể nhập thủ công bên dưới."
    
    [Ẩn thông báo này] toggle (remembers preference in localStorage)

2. Replace missing line items section with cleaner UI:

  Section: "CHI TIẾT HÀNG HÓA"
  
  IF no line items:
    Empty state card (light gray):
      "Không có chi tiết mặt hàng từ GDT"
      "Hóa đơn loại này chỉ có thông tin tổng hợp (tổng tiền + thuế)"
      
      [+ Nhập chi tiết thủ công] button (outline, not primary)
        → Opens inline form to add line items:
           Tên hàng hóa: [text]
           ĐVT: [text]  Số lượng: [number]  Đơn giá: [number]
           Thuế suất: [0% | 5% | 8% | 10%]
           [Thêm dòng] [Lưu chi tiết]
        → Saved to invoice_line_items with source='manual'
  
  IF has manual line items:
    Show line items table with [Sửa] [Xóa] per row
    Badge: "Chi tiết nhập thủ công" (to distinguish from auto-extracted)

3. Payment section for Group 6/8:
  Show "Phương thức thanh toán" dropdown PROMINENTLY (not hidden at bottom)
  With note: "Hóa đơn >5 triệu cần xác nhận không dùng tiền mặt để được khấu trừ VAT"
  Highlight in orange if total_amount >= 5M AND payment_method is null

4. VAT status for Group 6/8 invoices:
  Show green badge: "VAT đầu vào hợp lệ — [vat_amount]"
  Tooltip: "Hóa đơn loại K không cần xác nhận GDT để khấu trừ VAT theo quy định TT78/2021"
FIX-BOT-01 — Fix Proxy 407 Error + Improve Error Messages in Sync Log
[Respond in Vietnamese]
BUG: Sync log shows "Proxy CONNECT failed: HTTP/1.1 407 Proxy" (ảnh 9).
HTTP 407 = Proxy Authentication Required — proxy needs credentials but not being sent.

ROOT CAUSE: When using HTTP CONNECT proxy (for HTTPS tunneling),
the Proxy-Authorization header must be sent in the CONNECT request,
separate from the regular Authorization header for the target site.
Playwright handles this differently from axios.

TASK 1: Fix proxy authentication in GdtBotRunner.ts (Playwright):

// When launching browser with authenticated proxy:
const browser = await chromium.launch({
  headless: true,
  proxy: {
    server: proxyUrl,          // e.g. http://proxy.example.com:8080
    username: proxyUser,       // MUST be provided separately
    password: proxyPassword    // MUST be provided separately
  }
})

// Parse proxy URL to extract auth:
function parseProxyAuth(proxyUrl: string): { server: string; username?: string; password?: string } {
  const url = new URL(proxyUrl)
  return {
    server: `${url.protocol}//${url.host}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined
  }
}

// For axios (GDT API calls without Playwright):
// The proxy config must include auth separately:
const proxyConfig: AxiosProxyConfig = {
  protocol: 'http',
  host: 'proxy.example.com',
  port: 8080,
  auth: {
    username: proxyUser,
    password: proxyPassword   // axios handles Proxy-Authorization header automatically
  }
}

TASK 2: Update parseProxyForAxios() in proxy-manager.ts:

export function parseProxyForAxios(proxyUrl: string | null): AxiosProxyConfig | false {
  if (!proxyUrl) return false
  try {
    const parsed = new URL(proxyUrl)
    const config: AxiosProxyConfig = {
      protocol: parsed.protocol.replace(':', ''),
      host: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
    }
    // CRITICAL: must pass auth separately for 407 fix
    if (parsed.username || parsed.password) {
      config.auth = {
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || '')
      }
    }
    return config
  } catch {
    const masked = proxyUrl.replace(/:([^@:]+)@/, ':****@')
    console.error(`[ProxyManager] Invalid proxy URL: ${masked}`)
    return false
  }
}

TASK 3: Improve error messages in sync log UI (ảnh 9):

Current: "✗ Proxy CONNECT failed: HTTP/1.1 407 Proxy"  → too technical
Redesign error display in /settings/connectors sync history:

Each sync log row:
  ✅ [timestamp] [N] HĐ đầu ra, [M] HĐ đầu vào    (green, success)
  ❌ [timestamp] Lỗi: [user-friendly message]        (red, failure)
  ⏳ [timestamp] Đang chạy...                       (blue, running)

Error message mapping (translate technical → Vietnamese):
  'Proxy CONNECT failed: HTTP/1.1 407' → 'Lỗi kết nối proxy — xác thực proxy thất bại. Kiểm tra lại mật khẩu proxy.'
  'ECONNREFUSED'                        → 'Không thể kết nối proxy — proxy có thể đã offline.'
  'ETIMEDOUT'                           → 'Hết thời gian chờ — proxy hoặc GDT phản hồi chậm.'
  'CAPTCHA_TIMEOUT'                     → 'Captcha timeout — 2Captcha không giải được trong thời gian cho phép.'
  'INVALID_CREDENTIALS'                 → 'Sai tên đăng nhập hoặc mật khẩu cổng thuế GDT.'
  Contains 'socket'                     → 'Mất kết nối mạng trong khi đang đồng bộ.'

Add [Xem lỗi kỹ thuật] toggle per failed row → show raw error for developer debugging.

TASK 4: Add proxy health indicator in /settings/connectors:

Below the GDT Bot status card, add:
  "Proxy: [N] active | [M] failed | [K] suspended"
  If all proxies failed: red banner "⚠️ Tất cả proxy đang lỗi — đồng bộ tự động bị tạm dừng"
  [Kiểm tra proxy] button → test all proxies and show latency
FIX-DECL-01 — Export Tờ Khai: Thêm PDF + Excel ngoài XML HTKK
[Respond in Vietnamese]
CUSTOMER FEEDBACK: "ngoài xuất file Báo cáo chuẩn file .xml Cường có thể xuất thêm
file PDF và Excel nữa thì quá ok"

Currently /declarations page only has [Tải XML HTKK] button.
Add PDF and Excel export options.

TASK 1: Update declaration action buttons (ảnh 6, 7):

Replace single button with export dropdown or 3 separate buttons:
  [📄 XML HTKK] [📊 Excel] [🖨️ PDF]

Or use split button (primary action = XML, dropdown for others):
  [📄 Tải XML HTKK ▾]
    → Tải Excel (.xlsx)
    → In / Lưu PDF

TASK 2: Excel export in /backend/src/services/TaxDeclarationExporter.ts:

async exportToExcel(declarationId: string): Promise<Buffer>

Use ExcelJS (npm install exceljs):
  Sheet 1: "Mẫu 01/GTGT"
    - Company info header (tên, MST, địa chỉ, kỳ khai)
    - All declaration fields in proper format:
      Row: [Mã số] [Tên chỉ tiêu] [Giá trị]
      Bold the section headers (I. THUẾ ĐẦU VÀO, II. DOANH THU, III. KẾT QUẢ)
      Red color for [41] if > 0
      Green color for [43] if > 0
    - Formulas: e.g. [25] = [22] + [24] shown as Excel formulas so user can verify
    - Signature section at bottom (dashed underlines for date and signature)
  
  Sheet 2: "PL01-1 Bán ra" — list of all output invoices
    Columns: STT | Tên khách | MST | Ký hiệu | Số HĐ | Ngày | Hàng hóa | DT | Thuế suất | Thuế GTGT
  
  Sheet 3: "PL01-2 Mua vào" — list of all input invoices  
    Columns: STT | Tên NCC | MST | Ký hiệu | Số HĐ | Ngày | Hàng hóa | Giá trị | Thuế suất | Thuế GTGT
  
  Styling: header row blue background, alternating row colors, borders, VND number format

TASK 3: PDF export using Puppeteer (already have it via Playwright):

async exportToPdf(declarationId: string): Promise<Buffer>

Method: Generate HTML → Puppeteer render → PDF

HTML template for PDF (/backend/src/templates/declaration-pdf.html):
  - Official 01/GTGT form layout matching actual GDT form
  - Page header: "TỜ KHAI THUẾ GIÁ TRỊ GIA TĂNG (01/GTGT)"
  - Company info, period, declaration number
  - All fields in proper two-column layout (code | label | value)
  - Section separators matching official form
  - Validation results section (warnings/notes from pre-submission check)
  - Page footer: "Trang 1/2 — Lập ngày [date]"
  - Signature lines: "Người lập biểu" | "Kế toán trưởng" | "Giám đốc/Người đại diện"
  
  Puppeteer options:
    format: 'A4', printBackground: true, margin: { top: '15mm', ... }

TASK 4: API endpoints:
  GET /api/declarations/:id/export?format=xml → existing XML HTKK download
  GET /api/declarations/:id/export?format=excel → new Excel download
  GET /api/declarations/:id/export?format=pdf → new PDF download
  
  Response headers:
    Excel: Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
    PDF:   Content-Type: application/pdf
    
  Filename format: TK01GTGT_[companyTaxCode]_T[MM]_[YYYY].[ext]

TASK 5: Update the PL01-1/PL01-2 tabs in declaration page (ảnh 7):
  These tabs already exist — ensure they show data in proper grid format
  matching the Excel export layout (same columns, same grouping)
  Add [Xuất Excel sheet này] button per tab for partial export
FIX-PERF-01 — Sync Speed Optimization: Implement Crawl Cache Group 53
[Respond in Vietnamese]
CUSTOMER FEEDBACK: "Kéo dữ liệu còn hơi chậm nhé Cường chưa ổn lắm
— này mình phải suy nghĩ giải pháp ngay bước này"

ROOT CAUSES of slow sync (from analyzing the bot architecture):
  1. No deduplication: downloads XML for ALL invoices even if already in DB
  2. No incremental sync: always fetches full month even when only new invoices needed
  3. No checkpoint: if timeout/crash, restarts from page 1
  4. GDT session not reused: captcha every job even if session still valid
  5. No page list cache: refetches same pages on retry

TASK: Implement the 4 highest-impact cache mechanisms from Group 53 prompts.
Do them in order (each builds on the previous):

STEP 1 — Invoice Deduplicator (biggest win, saves 80-96% requests on re-sync):
  Implement CRAWL-CACHE-01 from Group 53 exactly as specified.
  
  Key integration point in GdtBotRunner.ts:
    START of job: await dedup.warmup(companyId, month, year)
    BEFORE each XML download: if await dedup.exists(...) → skip
    AFTER successful save: await dedup.markSeen(...)
  
  Expected result: 2nd sync of same month = only downloads NEW invoices (< 20 usually)

STEP 2 — GDT Session Reuse (saves 5-10 seconds + captcha cost per job):
  From CRAWL-CACHE-04 in Group 53, implement GdtAuthService.getOrCreateSession():
  
  Key: cache session token in Redis with TTL 50 minutes
  Key format: gdt:session:{companyId}:{proxyHash}
  On cache hit: verify session still valid with quick ping → skip captcha entirely
  
  Expected result: if company syncs within 50 min window → no captcha needed

STEP 3 — Sync Checkpoint (saves full restart cost when job fails):
  From CRAWL-CACHE-03 in Group 53, implement SyncCheckpoint:
  
  Save after every page: Redis key gdt:checkpoint:{jobId}
  On retry: load checkpoint, resume from lastPageDone + 1
  
  IMPORTANT: Set fixed jobId per company+month to enable checkpoint across retries:
  In BullMQ job options: jobId: `sync:${companyId}:${month}:${year}:${direction}`
  
  Expected result: timeout at page 15/20 → retry starts at page 16, not page 1

STEP 4 — Add progress metrics to existing sync UI:
  Update job data during crawl with detailed progress:
  await job.updateData({
    statusMessage:    `Đang tải trang ${page}/${totalPages}...`,
    invoicesFetched:  newCount,
    invoicesSkipped:  skippedCount,  // NEW: show dedup savings
    currentPage:      page,
    totalPages:       totalPages,
    sessionFromCache: !captchaNeeded  // NEW: show if captcha was skipped
  })
  
  Update sync log entry in DB:
  UPDATE gdt_bot_runs SET
    output_count = $1,
    input_count = $2,
    invoices_skipped = $3,  -- NEW column
    duration_ms = $4,
    status = $5
  WHERE id = $6
  
  Show in /settings/connectors sync history:
  "✅ 01:17 05-04 — 16 HĐ mới · 234 HĐ đã có (bỏ qua) · 4.2s"
  This shows user the system is working efficiently, not just "16 HĐ"