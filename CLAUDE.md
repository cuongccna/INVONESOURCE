# INVONE — Nền tảng Quản lý Hóa Đơn Điện Tử & Khai Thuế Tự Động

## Ứng dụng làm gì?

INVONE tự động hóa toàn bộ vòng đời hóa đơn điện tử (HĐĐT) cho doanh nghiệp Việt Nam:

1. **Thu thập** — Bot tự động crawl hóa đơn từ cổng GDT và các nhà cung cấp (MISA, Viettel, BKAV) 24/7
2. **Xác thực** — Pipeline 6 bước kiểm tra tính hợp lệ theo TT78/2021 (hủy, thay thế, chữ ký CQT, tiền mặt >5M VND, nhà cung cấp rủi ro)
3. **Khai thuế** — Tự động tính tờ khai 01/GTGT theo TT80/2021, xuất XML HTKK nộp GDT
4. **Phân tích** — Dashboard KPI, phát hiện công ty ma, bất thường giá bằng AI (Gemini)
5. **Báo cáo** — Sổ nhật ký, lãi lỗ, tồn kho, công nợ, sổ quỹ từ dữ liệu hóa đơn

## Giá trị cốt lõi

| Giá trị | Mô tả |
|---------|-------|
| **Tự động hóa** | Bot thu thập hóa đơn không cần thao tác thủ công |
| **Tuân thủ thuế** | Tính VAT đúng TT80, sinh XML HTKK chuẩn GDT |
| **Phát hiện rủi ro** | AI phát hiện công ty ma, giao dịch bất thường, vi phạm quy định |
| **Đa công ty** | Quản lý portfolio nhiều công ty (single / group / portfolio) |
| **Kế toán tích hợp** | Báo cáo tài chính trực tiếp từ dữ liệu hóa đơn |

---

## Kiến trúc tổng quan

```
┌─────────────────────────────────────────────────┐
│                   FRONTEND                       │
│  Next.js 15 + React 18 + TypeScript + Tailwind  │
│  Port 3000 → API calls → localhost:3001          │
└─────────────────────────┬───────────────────────┘
                          │ REST API
┌─────────────────────────▼───────────────────────┐
│                   BACKEND                        │
│  Express.js + PostgreSQL + Redis + BullMQ        │
│  Port 3001 | JWT auth | 40+ routes               │
│  Gemini AI | AES-256-GCM encryption              │
└──────────┬──────────────────────────┬────────────┘
           │ DB writes                │ Job queue
┌──────────▼──────────┐   ┌──────────▼────────────┐
│       BOT            │   │  Redis (BullMQ)        │
│  Node.js + BullMQ   │   │  Job queues + cache    │
│  Playwright + Axios │   └───────────────────────┘
│  Crawl GDT portal   │
│  2Captcha + Proxy   │
└─────────────────────┘
           │
┌──────────▼──────────────────────────────────────┐
│  External: GDT Portal, MISA, Viettel, BKAV      │
│  hoadondientu.gdt.gov.vn                         │
└─────────────────────────────────────────────────┘
```

---

## Service 1: Frontend (`/frontend`)

**Stack:** Next.js 15.3, React 18, TypeScript 5.7, Tailwind CSS, Recharts, Axios

### Các trang chính
| Section | Routes | Mô tả |
|---------|--------|-------|
| Dashboard | `/dashboard`, `/portfolio`, `/group/[id]` | KPI VAT, CIT, cảnh báo |
| Hóa đơn | `/invoices`, `/invoices/[id]`, `/invoices/amended` | Danh sách, lọc, xem chi tiết |
| Tờ khai | `/declarations`, `/declarations/hkd` | 01/GTGT, TT40 |
| Báo cáo | `/reports/*` | 9+ loại báo cáo kế toán |
| Import | `/import` | Upload XML GDT, Excel, HTKK |
| Audit | `/audit/anomalies`, `/audit/ghost-companies` | Phát hiện rủi ro AI |
| CRM | `/crm/*` | Phân tích khách hàng, RFM |
| Cài đặt | `/settings/connectors`, `/settings/bot` | Cấu hình kết nối |
| Admin | `/admin/*` | Quản lý người dùng, license |

### 3 chế độ xem (ViewContext)
- **single** — Một công ty, header `X-Company-Id`
- **group** — Tổ chức (nhiều chi nhánh), header `X-Organization-Id`
- **portfolio** — Toàn bộ công ty người dùng sở hữu

### Auth
- Access token: in-memory (không lưu localStorage — bảo mật XSS)
- Refresh token: HTTP-only cookie (tự động refresh khi 401)
- Revoke: Redis — đăng nhập mới thu hồi session cũ

### File quan trọng
- [frontend/contexts/AuthContext.tsx](frontend/contexts/AuthContext.tsx) — auth state
- [frontend/contexts/CompanyContext.tsx](frontend/contexts/CompanyContext.tsx) — đa công ty
- [frontend/contexts/ViewContext.tsx](frontend/contexts/ViewContext.tsx) — chế độ xem
- [frontend/lib/apiClient.ts](frontend/lib/apiClient.ts) — Axios config + interceptors
- [frontend/app/(app)/dashboard/page.tsx](frontend/app/(app)/dashboard/page.tsx) — dashboard chính
- [frontend/lib/navSections.ts](frontend/lib/navSections.ts) — cấu trúc navigation

---

## Service 2: Backend (`/backend`)

**Stack:** Express.js, TypeScript, PostgreSQL, Redis, BullMQ, Gemini AI, fast-xml-parser, ExcelJS

### API Routes chính
```
/auth              — Login, JWT, session management
/companies         — CRUD công ty, hierarchy tổ chức
/invoices          — Danh sách, chi tiết, soft-delete
/connectors        — Cấu hình MISA/Viettel/BKAV/GDT
/declarations      — Tờ khai 01/GTGT, tính toán, xuất XML
/reconciliation    — Đối chiếu VAT theo kỳ
/bot               — Điều khiển bot, theo dõi tiến độ sync
/dashboard         — KPI tổng hợp
/hkd               — Tờ khai hộ kinh doanh (TT40)
/audit             — Log hành động người dùng
/reports           — Xuất Excel (nhật ký, tờ khai)
/import            — Import hàng loạt hóa đơn
/ai                — Phát hiện bất thường (Gemini)
```

### Pipeline xác thực hóa đơn (6 plugin)
```
CancelledFilterPlugin      → Loại hóa đơn đã hủy
ReplacedFilterPlugin       → Loại hóa đơn đã thay thế
CqtSignatureFilterPlugin   → Kiểm tra chữ ký CQT
CashPaymentFilterPlugin    → Loại tiền mặt >5M VND (không được khấu trừ)
NonBusinessFilterPlugin    → Loại không phục vụ kinh doanh
VendorRiskFilterPlugin     → Cảnh báo nhà cung cấp rủi ro
```

### Tính toán 01/GTGT (TT80/2021)
```
ct22  — Thuế đầu vào kỳ trước
ct23  — Thuế đầu vào được khấu trừ (chỉ hóa đơn gdt_validated=true)
ct24  — Chuyển kỳ trước
ct25  — Tổng khấu trừ = ct23 + ct24
ct32/ct33 — Doanh thu 5% / thuế 5%
ct34/ct35 — Doanh thu 8% / thuế 8% (NQ142)
ct36/ct37 — Doanh thu 10% / thuế 10%
ct40a — Tổng thuế đầu ra
ct41  — Thuế phải nộp (nếu đầu ra > đầu vào)
ct43  — Chuyển kỳ sau (nếu đầu vào > đầu ra)
```

### Background Jobs (BullMQ)
| Job | Mục đích |
|-----|---------|
| SyncWorker | Poll provider APIs, enqueue hóa đơn mới |
| GdtValidatorWorker | Xác thực hóa đơn qua GDT (rate-limit 1 req/2s) |
| GdtRawCacheSyncWorker | Pre-fetch cache metadata từ GDT |
| TaxDeadlineReminderJob | Nhắc nhở nộp thuế |
| CatalogRebuildJob | Rebuild danh mục hàng hóa/khách hàng |

### Tích hợp nhà cung cấp
| Provider | Auth | Ghi chú |
|----------|------|---------|
| MISA meInvoice | JWT (appid + MST) | Token TTL 1h, per-company appid |
| Viettel VInvoice | OAuth2 | Cần whitelist IP, ngày dạng milliseconds |
| BKAV eInvoice | API key | GDT-validated mặc định |
| GDT Intermediary | OAuth2 client creds | Fallback, latency 24-48h |

### File quan trọng
- [backend/src/index.ts](backend/src/index.ts) — Entry point, job registration
- [backend/src/services/TaxDeclarationEngine.ts](backend/src/services/TaxDeclarationEngine.ts) — Tính 01/GTGT
- [backend/src/services/HtkkXmlGenerator.ts](backend/src/services/HtkkXmlGenerator.ts) — Sinh XML HTKK
- [backend/src/tax/validation/invoice-validation.pipeline.ts](backend/src/tax/validation/invoice-validation.pipeline.ts) — Pipeline xác thực
- [backend/src/connectors/ConnectorRegistry.ts](backend/src/connectors/ConnectorRegistry.ts) — Plugin registry
- [backend/src/services/GhostCompanyDetector.ts](backend/src/services/GhostCompanyDetector.ts) — Phát hiện công ty ma

---

## Service 3: Bot (`/bot`)

**Stack:** Node.js, TypeScript, BullMQ, Playwright, Axios, 2Captcha, IPRoyal/TMProxy, PostgreSQL, Redis

### Luồng hoạt động
```
auto-sync (mỗi 5 phút)
  → kiểm tra gdt_bot_configs (next_auto_sync_at <= NOW())
  → enqueue job vào BullMQ
  → crawl.worker / sync.worker
      1. Giải mã credentials
      2. Xoay proxy (IPRoyal sticky / TMProxy / static)
      3. Authenticate GDT (JWT + CAPTCHA via 2Captcha)
      4. Phân kỳ date range theo tháng
      5. Query /query/invoices/sold + /purchase (paginated 50/page)
      6. Dedup qua Redis set
      7. Upsert vào DB (invoices table)
      8. Enqueue invoice_detail_queue
  → detail.worker (poll mỗi 5s)
      → Fetch chi tiết từng hóa đơn
      → Parse line items
      → Upsert invoice_line_items
```

### Lịch chạy & tối ưu
- **Sleep:** 23:00–06:00 VN time (UTC+7) — không sync
- **Tốc độ theo giờ:** 09:00–17:00 100% | 06:00–09:00 60% | 17:00–22:00 40% | 22:00–23:00 10%
- **Peak period (ngày 18–25):** Timeout 30–90 phút (GDT chậm dịp nộp thuế)
- **Jitter:** Random delay 0–3 phút giữa các job để tránh storm

### Proxy & Anti-detection
- Static proxy pool (DB-managed, per-company IP affinity) — nguồn duy nhất
- User-Agent rotation, human-like read pauses, custom param serialization

### Bảo vệ & resilience
- Circuit breaker: ngừng toàn bộ nếu >20 lỗi trong 1 giờ
- Unrecoverable errors: sai credentials, hết quota, license hết hạn → không retry
- Recoverable: timeout, HTTP 429/5xx → exponential backoff

### File quan trọng
- [bot/src/index.ts](bot/src/index.ts) — Entry point, khởi động workers + scheduler
- [bot/src/crawl.worker.ts](bot/src/crawl.worker.ts) — Worker crawl chính (kiến trúc mới)
- [bot/src/sync.worker.ts](bot/src/sync.worker.ts) — Worker legacy
- [bot/src/detail.worker.ts](bot/src/detail.worker.ts) — Fetch chi tiết hóa đơn
- [bot/src/cron/auto-sync.ts](bot/src/cron/auto-sync.ts) — Scheduler tự động
- [bot/src/gdt-direct-api.service.ts](bot/src/gdt-direct-api.service.ts) — HTTP client GDT
- [bot/src/proxy-manager.ts](bot/src/proxy-manager.ts) — Quản lý proxy

---

## Domain Concepts

| Khái niệm | Giải thích |
|-----------|-----------|
| **GDT** | Tổng cục Thuế — cơ quan thuế Việt Nam |
| **HĐĐT** | Hóa đơn điện tử |
| **01/GTGT** | Mẫu tờ khai thuế VAT hàng tháng/quý |
| **TT80/2021** | Thông tư 80 — quy định khai thuế VAT hiện hành |
| **TT78/2021** | Thông tư 78 — quy định về hóa đơn điện tử |
| **HTKK** | Phần mềm kê khai thuế của GDT (định dạng XML) |
| **MST** | Mã số thuế |
| **HKD** | Hộ kinh doanh — chế độ thuế riêng (TT40) |
| **CQT** | Cơ quan thuế — chữ ký cấp mã của cơ quan thuế |
| **SCO** | Máy tính tiền (Self-Checkout) — hóa đơn nhóm 8 |
| **invoice_group** | 5=có mã CQT, 6=không mã, 8=máy tính tiền |
| **gdt_validated** | Hóa đơn đã xác thực qua API GDT |
| **Công ty ma** | Doanh nghiệp không hoạt động thực — rủi ro khấu trừ VAT |
| **NQ142** | Nghị quyết giảm thuế VAT 8% (thay vì 10%) |
| **T-Van** | Đơn vị trung gian kết nối với GDT |

---

## Cơ sở dữ liệu (PostgreSQL)

### Bảng chính
```
companies              — Thông tin công ty (MST, loại hình, license)
users / user_companies — Auth + phân quyền (OWNER/ADMIN/ACCOUNTANT/VIEWER)
invoices               — Dữ liệu hóa đơn (direction, status, gdt_validated...)
invoice_line_items     — Chi tiết dòng hàng hóa/dịch vụ
company_connectors     — Credentials nhà cung cấp (AES-256-GCM)
tax_declarations       — Tờ khai 01/GTGT (ct22→ct43)
vat_reconciliation     — Đối chiếu VAT theo rate (0%, 5%, 8%, 10%)
sync_logs              — Lịch sử sync
gdt_bot_configs        — Cấu hình bot per-company (schedule, proxy affinity)
gdt_bot_runs           — Lịch sử chạy bot
invoice_detail_queue   — Hàng đợi fetch chi tiết (Phase 2)
gdt_raw_cache          — Cache HTTP responses
notifications          — Thông báo người dùng
audit_logs             — Log hành động
```

---

## Tích hợp bên ngoài

| Service | Mục đích |
|---------|---------|
| `hoadondientu.gdt.gov.vn` | Portal hóa đơn GDT — nguồn dữ liệu chính |
| `tracuunnt.gdt.gov.vn` | Tra cứu thông tin doanh nghiệp |
| MISA meInvoice API | Provider hóa đơn |
| Viettel VInvoice API | Provider hóa đơn |
| BKAV eInvoice API | Provider hóa đơn |
| 2Captcha | Giải CAPTCHA cho GDT login |
| IPRoyal / TMProxy | Residential proxy rotation |
| Google Gemini API | AI phát hiện bất thường, phân tích giá |
| Telegram Bot API | Thông báo (tùy chọn) |
| Web Push (VAPID) | Push notification trình duyệt |

---

## Chạy local

```bash
# Backend (port 3001)
cd backend
cp .env.example .env  # điền DATABASE_URL, REDIS_URL, JWT_SECRET, GEMINI_API_KEY...
npm install
npm run dev

# Frontend (port 3000)
cd frontend
cp .env.example .env.local  # điền NEXT_PUBLIC_API_URL=http://localhost:3001
npm install
npm run dev

# Bot
cd bot
cp .env.example .env  # điền WORKER_DB_URL, REDIS_URL, ENCRYPTION_KEY, TWO_CAPTCHA_API_KEY...
npm install
npm run dev
```

### Biến môi trường quan trọng
```bash
# Backend & Bot (phải khớp nhau)
DATABASE_URL / WORKER_DB_URL   — PostgreSQL connection string
REDIS_URL                       — Redis connection
ENCRYPTION_KEY                  — 64-char hex key (AES-256-GCM cho credentials)
JWT_SECRET / JWT_REFRESH_SECRET — Token signing

# Backend
GEMINI_API_KEY                  — Google AI API key
GEMINI_MODEL                    — gemini-2.0-flash (hoặc tương đương)

# Bot
TWO_CAPTCHA_API_KEY             — 2Captcha API key
PROXY_LIST                      — Static proxy list (HTTP CONNECT), quản lý qua DB
GDT_CANARY_COMPANY_ID           — ID công ty dùng để health check
```

---

## Bảo mật

- **Credentials nhà cung cấp** mã hóa AES-256-GCM trước khi lưu DB
- **Access token** chỉ lưu in-memory (không localStorage — chống XSS)
- **Refresh token** trong HTTP-only cookie (chống JavaScript access)
- **Single-session enforcement** — Redis revoke session cũ khi đăng nhập mới
- **Rate limiting** — GDT validation 1 req/2s (tuân thủ giới hạn GDT)
- **Audit logging** — Toàn bộ hành động người dùng được ghi lại

---

## Quy tắc bắt buộc — Bot crawl GDT

> **CẤM TUYỆT ĐỐI** sử dụng IP trực tiếp (direct connection) để crawl dữ liệu từ GDT portal (`hoadondientu.gdt.gov.vn`). Mọi request đến GDT bắt buộc phải đi qua proxy.

### Proxy + Captcha là điều kiện tiên quyết

| Điều kiện | Hành vi bắt buộc |
|-----------|-----------------|
| **Không có proxy** | Dừng ngay (HARD STOP), ghi log ERROR, gửi chuông thông báo cho user, KHÔNG crawl |
| **Proxy không hoạt động** | Đánh dấu proxy failed, rotate sang proxy khác; nếu hết proxy → HARD STOP + notify |
| **Captcha thiếu key / 2Captcha lỗi** | Bỏ qua cycle hiện tại, retry cycle tiếp theo |
| **Tài khoản GDT bị từ chối (HTTP 400/401 non-captcha)** | Deactivate bot ngay lập tức (không retry), notify user |
| **Tài khoản GDT bị từ chối nhiều lần liên tiếp** | Sau `MAX_CONSECUTIVE_AUTH_FAILURES` lần → deactivate + notify |

### Quy tắc retry và tự bảo vệ tài khoản

- **Sai credentials**: dừng ngay, KHÔNG retry (tránh GDT lock account)
- **Lỗi mạng/proxy transient**: retry theo backoff, tối đa `MAX_CONSECUTIVE_AUTH_FAILURES` lần
- **Timeout (TCP blackhole)**: bọc mọi `processCompany()` và `getToken()` bằng `raceTimeout()` — không để poll loop bị block
- **Circuit breaker**: ngừng company khi có ≥ 5 HTTP 500 trong 10 phút

### File thực thi quy tắc này

- [`bot/src/detail.worker.ts`](bot/src/detail.worker.ts) — `processCompany()`: proxy guard ở đầu hàm
- [`bot/src/sync.worker.ts`](bot/src/sync.worker.ts) — tương tự
- [`bot/src/crawl.worker.ts`](bot/src/crawl.worker.ts) — tương tự
- [`bot/src/proxy-manager.ts`](bot/src/proxy-manager.ts) — quản lý proxy pool
