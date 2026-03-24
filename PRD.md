# PRD — Nền tảng Tổng hợp Hóa đơn Điện tử (HĐĐT Unified Platform)

> **Phiên bản:** 1.1 | **Ngày:** 2026-03-23
> **Stack:** Node.js/TypeScript · Next.js 14 · PostgreSQL local · Redis · Gemini AI
> **Nhà mạng:** MISA meInvoice · Viettel SInvoice · BKAV eInvoice · Cục thuế GDT

---

## 1. Tầm nhìn sản phẩm

Nền tảng web duy nhất tổng hợp hóa đơn điện tử đầu vào + đầu ra từ nhiều nhà mạng, đối chiếu VAT tự động, phát hiện rủi ro và cung cấp bức tranh tài chính realtime — giúp kế toán tiết kiệm 70% thời gian và ban lãnh đạo ra quyết định kịp thời.

---

## 2. User Personas

| Persona | Mục tiêu | Nỗi đau lớn nhất |
|---------|----------|------------------|
| Kế toán viên | Xử lý nhanh, không sai | Đăng nhập 3+ cổng mỗi ngày |
| Kế toán trưởng | Báo cáo chuẩn, đúng hạn | Không có báo cáo tổng hợp |
| CFO | Dòng tiền, công nợ thực tế | Số liệu chậm 10–15 ngày |
| CEO | Phát hiện rủi ro sớm | Không thấy cảnh báo kịp thời |

---

## 3. Nghiên cứu API Nhà mạng & Điểm nghẽn

### 3.1 MISA meInvoice
**Base:** `https://api.meinvoice.vn` | **Auth:** Bearer JWT + header `CompanyTaxCode`  
**Docs:** `https://doc.meinvoice.vn`

| API | Endpoint | Ghi chú |
|-----|----------|---------|
| Login | `POST /auth/login` | Trả về JWT, TTL ~1h |
| Danh sách HĐ bán ra | `GET /api/invoice/list` | Params: fromDate, toDate, page, size=50 |
| Danh sách HĐ mua vào | `GET /api/purchaseinvoice/list` | ⚠️ Dịch vụ trả phí riêng |
| Chi tiết HĐ | `GET /api/invoice/detail/{id}` | |
| Tải PDF | `GET /api/invoice/pdf/{id}` | |
| Tải XML | `GET /api/invoice/xml/{id}` | |

**Điểm nghẽn:**
- Token expire ~1h → cần auto-refresh
- **API đầu vào là dịch vụ trả phí riêng** → confirm với client trước khi dev
- Không có webhook → polling định kỳ
- `DuplicateInvoiceRefID` → skip, không throw error

---

### 3.2 Viettel SInvoice
**Base:** `https://sinvoice.viettel.vn:8443/InvoiceAPI` | **Auth:** HTTP Basic  
**Demo:** `demo-sinvoice.viettel.vn:8443` / `0100109106-215` / `111111a@A`

| API | Endpoint | Ghi chú |
|-----|----------|---------|
| Lấy danh sách HĐ | `POST /InvoiceUtilsWS/getListInvoiceDataControl` | Datetime = milliseconds |
| Tải file HĐ | `POST /InvoiceUtilsWS/getInvoiceRepresentationFile` | |
| Hủy HĐ | `POST /InvoiceWS/cancelTransactionInvoice` | |

**Điểm nghẽn:**
- **IP Whitelist bắt buộc** — phải đăng ký IP server tĩnh với Viettel trước go-live
- **Datetime = milliseconds** (không phải ISO string) — cần wrapper helper
- Timeout 90 giây per request
- Không phân biệt lỗi 500 do sai pass hay IP sai → debug khó

---

### 3.3 BKAV eInvoice *(thay thế VNPT)*
**Base:** `https://api.bkav.com.vn/einvoice` | **Auth:** Headers `PartnerGUID` + `PartnerToken`  
**Lý do chọn BKAV thay VNPT:** API ổn định, auth đơn giản (stateless token), được tích hợp bởi hầu hết phần mềm kế toán VN (MISA Accounting, Fast, Bravo...), tài liệu rõ ràng hơn VNPT.

| API | Endpoint | Ghi chú |
|-----|----------|---------|
| Danh sách HĐ bán ra | `GET /api/invoices` | Params: from, to, page |
| Danh sách HĐ mua vào | `GET /api/purchase-invoices` | Params: from, to, page |
| Tải PDF | `GET /api/invoices/{id}/pdf` | |
| Tải XML | `GET /api/invoices/{id}/xml` | |
| Health check | `GET /api/health` | |

**Điểm nghẽn:**
- `PartnerGUID` và `PartnerToken` cấp qua tài khoản doanh nghiệp trên portal BKAV
- GDT validation được BKAV xử lý nội bộ — không cần gọi GDT riêng cho HĐ BKAV
- Không có rate limit công bố → implement retry với backoff tự bảo vệ

---

### 3.4 GDT Validation
**URL:** `https://hoadondientu.gdt.gov.vn`  
**Vai trò:** Chỉ xác thực — không có API bulk export toàn bộ HĐ của DN.  
**Rate limit thực tế:** ~1 req/2s → dùng BullMQ rate-limited queue.  
**Quan trọng:** Theo luật thuế VN, HĐ đầu vào chỉ được khấu trừ VAT khi GDT confirmed valid.

---

### 3.5 Đơn vị Trung gian → GDT (Nguồn dữ liệu trực tiếp từ Cục thuế)

> **Bối cảnh:** Đây là nguồn dữ liệu đặc biệt — thay vì pull từng nhà mạng riêng lẻ, hệ thống truy cập **toàn bộ hóa đơn** của doanh nghiệp trực tiếp từ kho dữ liệu Tổng cục Thuế thông qua đơn vị trung gian được cấp phép (partner sẽ cung cấp thông tin kết nối sau khi đàm phán xong).

**Mô hình luồng dữ liệu:**
```
Hệ thống ──► Intermediary API ──► GDT Data Warehouse
                                        │
                              ┌─────────┴──────────┐
                              ▼                    ▼
                        HĐ đầu ra            HĐ đầu vào
                      (tất cả nhà mạng)    (tất cả nhà mạng)
```

**Đặc điểm khác biệt so với connector nhà mạng:**
- Dữ liệu từ **mọi** nhà mạng (MISA, Viettel, BKAV, VNPT...) trong 1 API call
- Là nguồn dữ liệu **chính thức** nhất — đây là những gì GDT đang thấy
- Thường có độ trễ 24–48h so với realtime nhà mạng
- Cần `clientId` + `clientSecret` + `accessToken` do đơn vị trung gian cấp
- Cần đăng ký `taxCode` của từng doanh nghiệp với intermediary trước khi pull

**Thông tin kết nối (placeholder — cập nhật sau khi đàm phán):**
```typescript
// /backend/src/connectors/GdtIntermediaryConnector.ts
interface GdtIntermediaryConfig {
  baseUrl: string          // Cập nhật từ đơn vị trung gian
  clientId: string         // Cấp bởi intermediary
  clientSecret: string     // Cấp bởi intermediary
  scope: string            // e.g. 'invoice:read'
  tokenEndpoint: string    // OAuth2 token endpoint
}
```

**Chiến lược tích hợp:**
- **Ưu tiên 1:** Dùng GDT Intermediary làm nguồn đối chiếu độc lập (cross-check với nhà mạng)
- **Ưu tiên 2:** Nếu connector nhà mạng fail → fallback sang GDT Intermediary
- **Ưu tiên 3:** Dùng làm nguồn dữ liệu đầu vào chính cho doanh nghiệp không có MISA/Viettel/BKAV

**Điểm nghẽn dự kiến:**
- Rate limit chặt hơn (dữ liệu toàn bộ DN → nhiều volume hơn)
- Cần whitelist IP phía intermediary
- Thời hạn token OAuth2 cần quản lý cẩn thận
- SLA của intermediary ảnh hưởng trực tiếp đến hệ thống

---

## 4. Kiến trúc Plugin Connector

### Nguyên tắc thiết kế
Mỗi nhà mạng là một **plugin độc lập**. Một plugin lỗi không được làm gãy các plugin khác hoặc ứng dụng.

```
ConnectorRegistry
├── MisaConnector          (plugin: id='misa')
├── ViettelConnector       (plugin: id='viettel')
├── BkavConnector          (plugin: id='bkav')
├── GdtIntermediaryConnector (plugin: id='gdt_intermediary') ← nguồn trực tiếp từ cục thuế
└── [future plugins]       (thêm mới không cần sửa core)
```

**Circuit Breaker per plugin:**
```
CLOSED ──(3 consecutive fails)──► OPEN ──(60s)──► HALF_OPEN
  ▲                                                    │
  └──────────────(success)────────────────────────────┘
```

**Thêm nhà mạng mới:** Tạo file mới implement `ConnectorPlugin`, gọi `registry.register()` khi startup. Không sửa bất kỳ file nào khác.  
**Tắt nhà mạng:** `registry.unregister('id')` hoặc set `enabled=false` trong DB. Không xóa code.

---

## 5. Feature List

### Module 1: Connector Hub

| ID | Tính năng | P |
|----|-----------|---|
| F1.1 | Multi-company: nhiều MST trong 1 tài khoản | P0 |
| F1.2 | Plugin MISA: connect + auto-refresh token | P0 |
| F1.3 | Plugin Viettel: Basic Auth + IP whitelist config | P0 |
| F1.4 | Plugin BKAV: PartnerGUID/Token auth | P0 |
| F1.5 | Plugin GDT Intermediary: OAuth2, nguồn trực tiếp cục thuế | P1 |
| F1.6 | Sync scheduler: cron 15 phút per company × provider | P0 |
| F1.7 | Circuit breaker: tự động dừng plugin lỗi, alert user | P0 |
| F1.8 | Cross-check: đối chiếu dữ liệu nhà mạng vs GDT intermediary | P2 |
| F1.9 | Manual sync: nút đồng bộ ngay per provider | P1 |
| F1.10 | GDT validator queue: rate-limited 1 req/2s | P1 |
| F1.11 | Sync log: lịch sử, trạng thái, retry | P1 |

### Module 2: Normalization Engine

| ID | Tính năng | P |
|----|-----------|---|
| F2.1 | XML/JSON parser theo NĐ123/2020 từ 3 nhà mạng | P0 |
| F2.2 | Chuẩn hóa schema thống nhất | P0 |
| F2.3 | Phát hiện HĐ trùng (số + MST + ngày) | P0 |
| F2.4 | Flag HĐ không hợp lệ (hủy/thay thế/điều chỉnh) | P0 |
| F2.5 | Lưu file PDF/XML gốc (local disk) | P1 |
| F2.6 | Gemini OCR: đọc HĐ scan PDF khi không có XML | P2 |

### Module 3: VAT Reconciliation

| ID | Tính năng | P |
|----|-----------|---|
| F3.1 | Đối chiếu đầu vào/ra tự động theo kỳ | P0 |
| F3.2 | Tính VAT phải nộp = VAT đầu ra - VAT đầu vào | P0 |
| F3.3 | Sinh bảng kê PL01-1 (bán ra) | P0 |
| F3.4 | Sinh bảng kê PL01-2 (mua vào) | P0 |
| F3.5 | Export XML tờ khai 01/GTGT cho eTax | P1 |
| F3.6 | Cảnh báo VAT bất thường | P1 |

### Module 4: Analytics Dashboard

| ID | Tính năng | P |
|----|-----------|---|
| F4.1 | KPI cards: doanh thu, chi phí, VAT, HĐ bất thường | P0 |
| F4.2 | Chart doanh thu vs chi phí 6 tháng (Recharts) | P0 |
| F4.3 | Chart VAT đầu ra vs đầu vào theo tháng | P1 |
| F4.4 | Top 5 khách hàng / nhà cung cấp | P1 |
| F4.5 | Gemini AI insights: phân tích bất thường | P2 |
| F4.6 | AI chat: hỏi đáp về dữ liệu HĐ bằng tiếng Việt | P2 |

### Module 5: Alerts & Notifications

| ID | Tính năng | P |
|----|-----------|---|
| F5.1 | Web Push PWA (VAPID) — hoạt động trên mobile | P0 |
| F5.2 | Nhắc deadline thuế (trước 7 ngày và 2 ngày) | P0 |
| F5.3 | Alert khi HĐ không hợp lệ | P0 |
| F5.4 | Alert khi connector lỗi / circuit open | P0 |
| F5.5 | Email fallback | P2 |

### Module 6: Export

| ID | Tính năng | P |
|----|-----------|---|
| F6.1 | Export Excel bảng kê chuẩn | P0 |
| F6.2 | Tải hàng loạt PDF theo kỳ | P1 |
| F6.3 | Export XML tờ khai thuế | P1 |

### Module 7: Kê khai & Nộp thuế tự động ⭐ NEW

> **Thực trạng (2025):** GDT **chưa mở public API** nộp tờ khai trực tiếp cho phần mềm bên thứ 3.  
> Con đường chính thức là **T-VAN** (Trusted Value Added Network) — các đơn vị được TGT cấp phép theo Thông tư 180/2010/TT-BTC, đóng vai trò trung gian truyền tờ khai vào GDT.  
> File định dạng: **XML chuẩn HTKK** — đây là định dạng duy nhất GDT chấp nhận qua cổng `thuedientu.gdt.gov.vn`.

**3 giải pháp nộp tờ khai — triển khai theo thứ tự ưu tiên:**

```
Tier 1 (P0): Tính số + Generate XML HTKK → User tự upload lên thuedientu.gdt.gov.vn
Tier 2 (P1): Tích hợp T-VAN API → Nộp tự động (liên hệ ThaisonSoft/TS24/MISA T-VAN)
Tier 3 (P2): Tích hợp GDT Intermediary → Nộp trực tiếp (nếu partner hỗ trợ)
```

| ID | Tính năng | P |
|----|-----------|---|
| F7.1 | Engine tính chỉ tiêu 01/GTGT đầy đủ từ dữ liệu HĐ | P0 |
| F7.2 | Generate XML chuẩn HTKK (TT80/2021) | P0 |
| F7.3 | Preview tờ khai: hiển thị đúng mẫu biểu trước khi nộp | P0 |
| F7.4 | Validation trước khi nộp: cảnh báo số liệu bất thường | P0 |
| F7.5 | Download XML để user tự nộp lên thuedientu.gdt.gov.vn | P0 |
| F7.6 | Lưu lịch sử tờ khai đã nộp, trạng thái xác nhận | P1 |
| F7.7 | Tích hợp T-VAN: nộp tự động qua partner được cấp phép | P1 |
| F7.8 | Hướng dẫn từng bước upload XML lên eTax (nếu nộp thủ công) | P0 |
| F7.9 | Sinh tờ khai bổ sung khi phát hiện sai sót kỳ trước | P2 |

---

## 6. Database Schema (PostgreSQL)

```sql
-- Core tables
companies (id UUID PK, name, tax_code, address, created_at)

users (id UUID PK, email, password_hash, full_name, created_at)

user_companies (user_id, company_id, role ENUM('OWNER','ADMIN','ACCOUNTANT','VIEWER'))

company_connectors (
  id UUID PK,
  company_id UUID FK,
  provider ENUM('misa','viettel','bkav'),
  credentials_encrypted TEXT,     -- AES-256-GCM encrypted JSON
  enabled BOOLEAN DEFAULT true,
  circuit_state ENUM('CLOSED','OPEN','HALF_OPEN') DEFAULT 'CLOSED',
  consecutive_failures INT DEFAULT 0,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
)

invoices (
  id UUID PK,
  company_id UUID FK,
  provider ENUM('misa','viettel','bkav','manual'),
  direction ENUM('output','input'),
  invoice_number VARCHAR(50),
  serial_number VARCHAR(20),
  invoice_date DATE,
  seller_tax_code VARCHAR(20),
  seller_name VARCHAR(255),
  buyer_tax_code VARCHAR(20),
  buyer_name VARCHAR(255),
  subtotal NUMERIC(18,2),
  vat_rate NUMERIC(5,2),         -- 0, 5, 8, 10
  vat_amount NUMERIC(18,2),
  total_amount NUMERIC(18,2),
  currency CHAR(3) DEFAULT 'VND',
  status ENUM('valid','cancelled','replaced','adjusted','invalid') DEFAULT 'valid',
  gdt_validated BOOLEAN DEFAULT false,
  gdt_validated_at TIMESTAMPTZ,
  raw_xml TEXT,
  pdf_path VARCHAR(500),
  external_id VARCHAR(100),
  sync_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,         -- soft delete
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, provider, invoice_number, seller_tax_code, invoice_date)
)

vat_reconciliations (
  id UUID PK, company_id UUID FK,
  period_month SMALLINT, period_year SMALLINT,
  output_vat NUMERIC(18,2), input_vat NUMERIC(18,2), payable_vat NUMERIC(18,2),
  breakdown JSONB,   -- {by_rate: {0: {...}, 5: {...}, 8: {...}, 10: {...}}}
  generated_at TIMESTAMPTZ,
  UNIQUE(company_id, period_month, period_year)
)

notifications (id UUID PK, company_id UUID FK, user_id UUID FK,
  type VARCHAR(50), title VARCHAR(255), body TEXT,
  is_read BOOLEAN DEFAULT false, push_sent BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())

sync_logs (id UUID PK, company_id UUID FK, provider VARCHAR(20),
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  records_fetched INT DEFAULT 0, errors_count INT DEFAULT 0, error_detail TEXT)

push_subscriptions (id UUID PK, user_id UUID FK,
  endpoint TEXT, p256dh TEXT, auth TEXT, created_at TIMESTAMPTZ DEFAULT NOW())

tax_declarations (
  id UUID PK,
  company_id UUID FK,
  period_month SMALLINT,
  period_year SMALLINT,
  form_type VARCHAR(20) DEFAULT '01/GTGT',         -- Mẫu tờ khai
  declaration_method ENUM('deduction','direct'),    -- khấu trừ / trực tiếp
  filing_frequency ENUM('monthly','quarterly'),
  -- Các chỉ tiêu tờ khai 01/GTGT (TT80/2021)
  ct22_total_input_vat NUMERIC(18,0),       -- [22] Tổng thuế GTGT đầu vào
  ct23_deductible_input_vat NUMERIC(18,0),  -- [23] Thuế GTGT đầu vào đủ điều kiện khấu trừ
  ct24_carried_over_vat NUMERIC(18,0),      -- [24] Thuế khấu trừ kỳ trước chuyển sang
  ct25_total_deductible NUMERIC(18,0),      -- [25] Tổng được khấu trừ (23+24)
  ct29_total_revenue NUMERIC(18,0),         -- [29] Tổng doanh thu HHDV bán ra
  ct30_exempt_revenue NUMERIC(18,0),        -- [30] Không chịu thuế
  ct32_revenue_5pct NUMERIC(18,0),          -- [32] Doanh thu chịu thuế 5%
  ct33_vat_5pct NUMERIC(18,0),              -- [33] Thuế GTGT 5%
  ct34_revenue_8pct NUMERIC(18,0),          -- [34] Doanh thu chịu thuế 8% (tạm thời)
  ct35_vat_8pct NUMERIC(18,0),              -- [35] Thuế GTGT 8%
  ct36_revenue_10pct NUMERIC(18,0),         -- [36] Doanh thu chịu thuế 10%
  ct37_vat_10pct NUMERIC(18,0),             -- [37] Thuế GTGT 10%
  ct40_total_output_revenue NUMERIC(18,0),  -- [40] Tổng doanh thu (=29)
  ct40a_total_output_vat NUMERIC(18,0),     -- [40a] Tổng VAT đầu ra
  ct41_payable_vat NUMERIC(18,0),           -- [41] VAT phải nộp SXKD = 40a - 25 (nếu >0)
  ct43_carry_forward_vat NUMERIC(18,0),     -- [43] VAT được khấu trừ kỳ sau (nếu 41<0)
  -- Metadata
  xml_content TEXT,                          -- XML HTKK đã generate
  xml_generated_at TIMESTAMPTZ,
  submission_method ENUM('manual','tvan','gdt_api') DEFAULT 'manual',
  submission_status ENUM('draft','ready','submitted','accepted','rejected') DEFAULT 'draft',
  submission_at TIMESTAMPTZ,
  tvan_transaction_id VARCHAR(100),          -- ID giao dịch từ T-VAN (nếu dùng)
  gdt_reference_number VARCHAR(50),          -- Số tiếp nhận từ GDT
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_month, period_year, form_type)
)

declaration_attachments (
  id UUID PK,
  declaration_id UUID FK,
  attachment_type ENUM('PL01-1','PL01-2','PL01-3','PL01-4a','PL01-4b','OTHER'),
  file_path VARCHAR(500),
  generated_at TIMESTAMPTZ
)
CREATE INDEX idx_invoices_direction_status ON invoices(direction, status);
CREATE INDEX idx_invoices_seller_tax ON invoices(seller_tax_code);
CREATE INDEX idx_invoices_buyer_tax ON invoices(buyer_tax_code);
```

---

## 7. Engine Tính Chỉ Tiêu Tờ Khai 01/GTGT (TT80/2021)

### Logic tính từng chỉ tiêu từ dữ liệu hóa đơn

```
Dữ liệu đầu vào: invoices WHERE company_id = X AND period = (month, year)

[22] Tổng thuế GTGT đầu vào
   = SUM(vat_amount) WHERE direction='input' AND status != 'cancelled'

[23] Thuế GTGT đầu vào đủ điều kiện khấu trừ
   = SUM(vat_amount) WHERE direction='input'
     AND status = 'valid'
     AND gdt_validated = true
     AND (total_amount <= 20_000_000 OR payment_method != 'cash')

[24] Thuế GTGT kỳ trước chuyển sang
   = carry_forward_vat kỳ (month-1, year) | 0 nếu kỳ đầu

[25] = [23] + [24]

[29] = SUM(subtotal) WHERE direction='output' AND status='valid'
[30] = SUM(subtotal) WHERE direction='output' AND vat_rate = 0
[32] = SUM(subtotal) WHERE direction='output' AND vat_rate = 5
[33] = SUM(vat_amount) WHERE direction='output' AND vat_rate = 5
[34] = SUM(subtotal) WHERE direction='output' AND vat_rate = 8
[35] = SUM(vat_amount) WHERE direction='output' AND vat_rate = 8
[36] = SUM(subtotal) WHERE direction='output' AND vat_rate = 10
[37] = SUM(vat_amount) WHERE direction='output' AND vat_rate = 10

[40]  = [30] + [32] + [34] + [36]   (= [29])
[40a] = [33] + [35] + [37]

[41] = MAX(0, [40a] - [25])    → DN phải nộp tiền vào NSNN
[43] = MAX(0, [25] - [40a])    → Được khấu trừ kỳ sau (→ [24] kỳ sau)
```

### Điều kiện khấu trừ đầu vào (bắt buộc implement đúng)
```
✅ Khấu trừ được:
  - HĐ hợp pháp, có mã CQT, GDT validated = true
  - Phục vụ SXKD chịu thuế
  - Tổng tiền ≤ 20 triệu: mọi hình thức thanh toán
  - Tổng tiền > 20 triệu: thanh toán không tiền mặt (payment_method != 'cash')

❌ Không khấu trừ:
  - HĐ bị hủy/thay thế (status != 'valid')
  - GDT validated = false (MST người bán bị thu hồi)
  - Thanh toán tiền mặt > 20 triệu
```

### XML Schema HTKK (chuẩn TT80/2021) — trích yếu
```xml
<?xml version="1.0" encoding="UTF-8"?>
<GDT>
  <HSoKKhaiThue>
    <TTinChung>
      <KKhaiThue>
        <maTCThue>{MST}</maTCThue>
        <tenNNT>{Tên DN}</tenNNT>
        <maHSo>01/GTGT</maHSo>
        <kyKKhai>M01-2025</kyKKhai>   <!-- hoặc Q01-2025 -->
        <ngayLapTKhai>2025-02-15</ngayLapTKhai>
      </KKhaiThue>
    </TTinChung>
    <ChiTietHSo>
      <ChiTieu ma="22">{ct22}</ChiTieu>
      <ChiTieu ma="23">{ct23}</ChiTieu>
      <ChiTieu ma="24">{ct24}</ChiTieu>
      <ChiTieu ma="25">{ct25}</ChiTieu>
      <ChiTieu ma="29">{ct29}</ChiTieu>
      <ChiTieu ma="40a">{ct40a}</ChiTieu>
      <ChiTieu ma="41">{ct41}</ChiTieu>
      <ChiTieu ma="43">{ct43}</ChiTieu>
    </ChiTietHSo>
    <!-- Phụ lục 01-1/GTGT: Bảng kê bán ra -->
    <!-- Phụ lục 01-2/GTGT: Bảng kê mua vào -->
  </HSoKKhaiThue>
</GDT>
```

### Quy trình nộp tờ khai — 3 tầng triển khai

```
TIER 1 — Manual (P0, deploy ngay):
  Tính số → Generate XML HTKK → User download
  → User upload lên thuedientu.gdt.gov.vn + Ký USB Token/SIM CA

TIER 2 — T-VAN semi-auto (P1):
  Tính số → Generate XML → Gọi T-VAN API → T-VAN nộp vào GDT
  → Nhận GDT Reference Number → Lưu vào tax_declarations
  Partner khuyến nghị: ThaisonSoft eTax (07/GCN-TCT) hoặc TS24 TaxOnline

TIER 3 — GDT Intermediary (P2):
  Nếu đơn vị trung gian hỗ trợ nộp khai → dùng 1 partner cho cả 2 luồng
```

---

## 8. System Architecture

```
Browser (PWA)              Backend (Express API)          Infra
──────────────             ───────────────────────        ─────
Next.js 14          ←→     /api/auth                      PostgreSQL (local)
Service Worker              /api/invoices                  Redis (local)
Web Push VAPID              /api/connectors                File storage (local)
Recharts                    /api/reconciliation
                            /api/dashboard
                                    ↓
                           ConnectorRegistry
                           ├── MisaConnector    ←→  MISA API
                           ├── ViettelConnector ←→  Viettel API
                           └── BkavConnector    ←→  BKAV API
                                    ↓
                           BullMQ Workers (Redis)
                           ├── SyncWorker (cron 15min)
                           └── GdtValidatorWorker (rate-limited)
                                    ↓
                           Gemini 1.5 Flash (AI features)
```

---

## 8. Security

- Credentials nhà mạng: **AES-256-GCM encrypted** trước khi lưu DB
- JWT access token: 1h expiry, in-memory (frontend)
- Refresh token: 7 ngày, HTTP-only cookie
- RBAC: OWNER > ADMIN > ACCOUNTANT > VIEWER — enforce ở middleware layer
- Audit log mọi thao tác trên HĐ
- Không log credentials, token, raw invoice data
- Input validation tất cả endpoint (zod schemas)
- Rate limiting: 60 req/min per IP

---

## 9. Non-Functional Requirements

| | Target |
|--|--------|
| Sync 1000 HĐ | < 3 phút |
| Dashboard load (cached) | < 500ms |
| PWA load (3G mobile) | < 4s |
| Push delivery | < 5s sau trigger |
| Concurrent users | 50 (local server) |
| DB query 1000 HĐ | < 200ms (with index) |

---

## 10. Development Phases

### Phase 1 — Core (4 tuần)
- Project setup, DB migrations, Auth (JWT + RBAC)
- ConnectorRegistry + circuit breaker
- MISA Connector + Viettel Connector
- Sync scheduler (BullMQ), Normalization engine
- Invoice list UI cơ bản

### Phase 2 — BKAV + Reconciliation (3 tuần)
- BKAV Connector
- GDT Validator queue
- VAT Reconciliation engine
- Sinh bảng kê PL01-1, PL01-2 (Excel)
- Dashboard UI cơ bản

### Phase 3 — PWA + Polish (3 tuần)
- Service Worker + Web Push VAPID
- Notification triggers
- Analytics charts (Recharts)
- Export Excel, XML tờ khai
- Mobile UI responsive polish

### Phase 4 — AI (2 tuần)
- Gemini OCR (HĐ scan)
- Anomaly detection + AI explanation
- AI chat assistant
- Performance optimization

---

## 11. Rủi ro & Giảm thiểu

| Rủi ro | Xác suất | Tác động | Giảm thiểu |
|--------|----------|----------|------------|
| Viettel IP Whitelist thay đổi | Trung bình | Cao | Document rõ, static IP requirement |
| MISA API đầu vào không có (chưa mua) | Cao | Trung bình | Confirm với client ngay Phase 1 |
| BKAV thay đổi endpoint | Thấp | Cao | Plugin adapter pattern, version-pin |
| GDT rate limit tăng nghiêm | Trung bình | Trung bình | Queue + throttle 1req/2s |
| Connector lỗi làm app gãy | Thấp | Cao | Circuit breaker + plugin isolation |
| HĐ > 10k/tháng làm chậm sync | Trung bình | Trung bình | Incremental sync, pagination |
