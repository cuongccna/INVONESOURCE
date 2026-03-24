# Copilot Instructions — HĐĐT Unified Platform

## Project
Vietnamese e-invoice aggregation platform. Sync invoices from MISA / Viettel / BKAV → VAT reconciliation → realtime financial dashboard.
Type: **Web App + PWA** (mobile push notifications via VAPID).

---

## Stack — Hard Constraints
```
Backend:   Node.js + TypeScript + Express.js
Frontend:  Next.js 14 App Router + TypeScript + Tailwind CSS
DB:        PostgreSQL LOCAL (no Docker, no cloud DB)
Cache:     Redis LOCAL + BullMQ (job queue)
AI:        Google Gemini 1.5 Flash only
Auth:      JWT + HTTP-only cookie refresh token
Push:      web-push npm (VAPID)
```
**NEVER suggest:** Docker · MongoDB/MySQL · OpenAI/Claude API · Firebase/Supabase · TypeORM · cloud DB.

---

## Plugin Connector Architecture ⚡ Critical

Every provider = **isolated plugin**. One plugin crashing must NEVER affect others.

```typescript
// /backend/src/connectors/types.ts
interface ConnectorPlugin {
  readonly id: string           // 'misa' | 'viettel' | 'bkav' | future providers
  readonly name: string
  readonly version: string
  isEnabled(): boolean
  authenticate(creds: EncryptedCredentials): Promise<void>
  pullOutputInvoices(params: SyncParams): Promise<RawInvoice[]>
  pullInputInvoices(params: SyncParams): Promise<RawInvoice[]>
  downloadPDF(externalId: string): Promise<Buffer>
  healthCheck(): Promise<boolean>
}

// /backend/src/connectors/ConnectorRegistry.ts
class ConnectorRegistry {
  private plugins = new Map<string, ConnectorPlugin>()
  register(plugin: ConnectorPlugin): void      // add new provider
  unregister(id: string): void                 // remove provider
  get(id: string): ConnectorPlugin | undefined // never throws
  getAll(): ConnectorPlugin[]
}
```

**Circuit Breaker per plugin:**
- 3 consecutive fails → state: `OPEN` → skip all calls, push alert to user
- After 60s cooldown → state: `HALF_OPEN` → try 1 request
- Success → `CLOSED` | Fail → back to `OPEN`

**Sync Worker isolation pattern:**
```typescript
for (const plugin of registry.getAll()) {
  try {
    await syncPlugin(plugin, job)  // each plugin fully isolated
  } catch (err) {
    logger.error(`[${plugin.id}] sync failed`, err)
    await markPluginError(plugin.id, err)
    // continue to next plugin — never rethrow
  }
}
```

**To add a new provider:** create `/connectors/NewProviderConnector.ts` implementing `ConnectorPlugin`, register in startup. Zero changes to core sync engine.  
**To remove a provider:** call `registry.unregister('id')` or set `enabled: false` in DB config.

---

## Connector API Reference

### MISA meInvoice
- Base: `https://api.meinvoice.vn` | Auth: `Bearer {token}` + header `CompanyTaxCode`
- Token TTL ~1h → auto-refresh 5min before expiry
- Output: `GET /api/invoice/list?fromDate&toDate&page&size=50`
- Input: `GET /api/purchaseinvoice/list` (**paid add-on — confirm with client**)
- Skip `DuplicateInvoiceRefID` silently | No webhook → 15min polling

### Viettel SInvoice
- Base: `https://sinvoice.viettel.vn:8443/InvoiceAPI` | Auth: HTTP Basic
- ⚠️ **IP Whitelist required** — register static server IP with Viettel before go-live
- ⚠️ **Datetime = milliseconds**: `toMs(d: Date) => d.getTime()`; timeout = 90000ms
- Output list: `POST /InvoiceUtilsWS/getListInvoiceDataControl`
- `transactionUuid`: UUID v4 per request for idempotency
- Demo env: `demo-sinvoice.viettel.vn:8443` / `0100109106-215` / `111111a@A`

### BKAV eInvoice
- Base: `https://api.bkav.com.vn/einvoice` | Auth: headers `PartnerGUID` + `PartnerToken`
- Output: `GET /api/invoices?from={date}&to={date}&page={n}`
- Input: `GET /api/purchase-invoices?from={date}&to={date}`
- Files: `GET /api/invoices/{id}/pdf` | `/xml`
- GDT validation built-in on BKAV side
- Credentials: client gets `PartnerGUID` + `PartnerToken` from BKAV account

### BKAV eInvoice
- Base: `https://api.bkav.com.vn/einvoice` | Auth: headers `PartnerGUID` + `PartnerToken`
- Output: `GET /api/invoices?from={ISO}&to={ISO}&page={n}`
- Input: `GET /api/purchase-invoices?from={ISO}&to={ISO}&page={n}`
- Files: `GET /api/invoices/{id}/pdf` | `/xml`
- GDT validation built-in on BKAV side
- Credentials: client gets `PartnerGUID` + `PartnerToken` from BKAV account

### GDT Intermediary (Direct Tax Authority Source)
- Auth: OAuth2 `client_credentials` (clientId + clientSecret → access_token)
- Pulls ALL invoices regardless of which nhà mạng issued them
- Covers both input and output invoices in one call
- Data latency: 24–48h vs realtime from nhà mạng
- ⚠️ Placeholder: base URL + scopes TBD after partner negotiation
- Use as: cross-validation source + fallback when nhà mạng connectors fail
- Plugin id: `'gdt_intermediary'` | Circuit breaker applies same as others

### GDT Validation
- URL: `https://hoadondientu.gdt.gov.vn` — validate only, no bulk pull
- Rate: 1 req/2s via BullMQ rate-limited queue

---

## Domain Rules (Vietnam Tax Law)
```
VAT payable  = SUM(vat_amount, direction=output, status=valid) - SUM(deductible_input_vat)
Deductible   = valid + gdt_validated + (total≤20M OR non-cash payment)
Carry-fwd    = if payable < 0 → move to [24] next period
Deadline     : 20th of following month
VAT rates    : 0% | 5% | 8% | 10%
Tax code     : /^\d{10}(-\d{3})?$/
Status flow  : valid → cancelled | replaced | adjusted
Direction    : output (sales) | input (purchase)

Form 01/GTGT key line items:
  [22] Total input VAT collected
  [23] Deductible input VAT (after eligibility check)
  [24] Carry-forward from previous period
  [25] = [23] + [24]  (total deductible)
  [40a] Total output VAT
  [41] = MAX(0, [40a]-[25])  → must pay
  [43] = MAX(0, [25]-[40a])  → carry to next period [24]

XML format: HTKK standard (TT80/2021) — only format GDT accepts
Submission:  Tier1=manual upload | Tier2=T-VAN API | Tier3=GDT intermediary
```

---

## Code Standards
- TypeScript strict mode — no `any`, use `unknown`
- No SQL string interpolation — parameterized only
- Credentials: AES-256-GCM encrypt before DB, decrypt on use
- UUID v4 primary keys | `TIMESTAMPTZ DEFAULT NOW()`
- API response: `{ success: boolean, data?: T, error?: { code, message } }`
- Never log credentials, tokens, raw invoice PII
- RBAC middleware: OWNER > ADMIN > ACCOUNTANT > VIEWER

---

## Directory Map
```
backend/src/connectors/
  types.ts                       ← ConnectorPlugin interface
  ConnectorRegistry.ts           ← Registry + circuit breaker
  MisaConnector.ts
  ViettelConnector.ts
  BkavConnector.ts
  GdtIntermediaryConnector.ts    ← OAuth2, placeholder base URL
backend/src/jobs/                ← BullMQ workers
backend/src/services/
  VatReconciliationService.ts
  TaxDeclarationEngine.ts        ← Tính chỉ tiêu 01/GTGT
  HtkkXmlGenerator.ts            ← Generate XML HTKK chuẩn TT80/2021
  TVanSubmissionService.ts       ← Nộp tờ khai qua T-VAN (optional)
frontend/app/
  invoices/
  dashboard/
  declarations/                  ← Tờ khai: tính số, preview, download XML
shared/types/
scripts/                         ← 001_init.sql, 002_tax_declarations.sql...
PRD.md | prompts.md
```

## Pre-Accept Checklist
- [ ] No Docker / cloud DB / OpenAI?
- [ ] Plugin error caught locally, not propagated?
- [ ] Viettel datetime in milliseconds?
- [ ] Credentials AES-encrypted before DB write?
- [ ] New provider = new plugin file only?
- [ ] Tax calc uses exact 01/GTGT formula (see PRD §7)?
- [ ] GDT Intermediary base URL from env var (not hardcoded)?
