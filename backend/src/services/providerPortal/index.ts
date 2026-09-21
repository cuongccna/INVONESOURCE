/**
 * ProviderPortalService — lấy BẢN GỐC THEO MẪU NHÀ CUNG CẤP theo yêu cầu của người dùng.
 *
 * VÌ SAO CÓ LỚP NÀY (khác plugin chạy nền của bot):
 *   Bot tải trước bản gốc trong nền và giải mã xác thực bằng dịch vụ 2Captcha. Nhưng phần
 *   lớn cổng tra cứu HĐĐT đều bắt nhập mã xác thực, mà người dùng đang ngồi ngay trước màn
 *   hình — đưa thẳng ảnh cho họ nhập vừa nhanh, vừa đúng, vừa không tốn tiền giải captcha,
 *   và không phụ thuộc một dịch vụ bên ngoài. Cổng nào KHÔNG bắt mã xác thực (M-Invoice,
 *   Viet-Invoice, EFY, Viettel) thì chạy thẳng một nhịp, người dùng không phải làm gì.
 *
 * CAM KẾT VỚI PHẦN CÒN LẠI CỦA API: hàm public không bao giờ ném lỗi mạng ra ngoài —
 * cổng chết, cấu hình sai, driver hỏng đều trả về kết quả có `status` để route hiển thị.
 *
 * BẢO VỆ:
 *   1. Công tắc tổng    — cfg 'provider_lookup.enabled'
 *   2. Công tắc từng bên — einvoice_providers.lookup_enabled
 *   3. Timeout cứng     — cổng treo không giữ được request của người dùng
 *   4. Giãn nhịp + ngắt mạch theo từng cổng
 *   5. Phiên captcha hết hạn 5 phút, giới hạn số lần nhập sai
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../../db/pool';
import { cfg } from '../../config/ConfigStore';
import { createPortalHttp } from './http';
import { buildDriver, resolvePortalConfig } from './registry';
import { renderHtmlToPdf } from './render';
import {
  PortalCaptchaError, PortalDocument, PortalDriver, PortalInputError, PortalManualOnlyError,
  PortalNotFoundError, PortalRequest,
} from './types';

/** Thư mục lưu file hoá đơn — phải khớp INVOICE_STORAGE_DIR của bot */
function storageRoot(): string {
  return process.env['INVOICE_STORAGE_DIR'] ?? '/opt/INVONESOURCE/storage/invoices';
}

// ─── Kết quả trả cho route ────────────────────────────────────────────────────

export type PortalOutcome =
  /** Đã có file trong hệ thống, mở xem được ngay */
  | { status: 'ready';    message: string; size: number | null }
  /** Vừa tải xong trong lượt này */
  | { status: 'done';     message: string; size: number; source: string }
  /** Cổng bắt nhập mã xác thực — đẩy ảnh lên cho người dùng */
  | { status: 'captcha';  sessionId: string; imageDataUrl: string; hint: string; message: string; attemptsLeft: number }
  /** Không tự lấy được, nhưng chỉ được đúng chỗ để lấy tay */
  | { status: 'manual';   message: string; portalUrl: string | null }
  /** Cổng khẳng định không có hoá đơn này / hoá đơn thiếu dữ liệu tra cứu */
  | { status: 'notfound'; message: string; portalUrl: string | null }
  /** Cổng lỗi tạm thời — thử lại sau */
  | { status: 'error';    message: string; portalUrl: string | null };

/** Khả năng tra cứu tự động của một hoá đơn — dùng để giao diện vẽ đúng nút */
export interface PortalCapability {
  supported:    boolean;
  driver_id:    string | null;
  provider:     string | null;
  needs_captcha: boolean;
  verified:     boolean;
}

// ─── Phiên nhập mã xác thực ───────────────────────────────────────────────────

interface CaptchaSession {
  companyId: string;
  invoiceId: string;
  userId:    string;
  driverId:  string;
  state:     Record<string, string>;
  cookies:   Record<string, string>;
  attempts:  number;
  expiresAt: number;
}

const SESSION_TTL_MS  = 5 * 60_000;
const MAX_ATTEMPTS    = 5;
const sessions = new Map<string, CaptchaSession>();

function sweepSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
}

// ─── Giãn nhịp và ngắt mạch theo từng cổng ────────────────────────────────────

interface PortalState { failures: number; openUntil: number; lastCallAt: number }
const portalState = new Map<string, PortalState>();

function stateOf(key: string): PortalState {
  let s = portalState.get(key);
  if (!s) { s = { failures: 0, openUntil: 0, lastCallAt: 0 }; portalState.set(key, s); }
  return s;
}

/**
 * Khoá đếm lỗi / giãn nhịp: MỘT MÁY CHỦ THẬT, không phải một nhà cung cấp.
 *
 * VNPT cấp mỗi tài khoản hoá đơn một tên miền riêng, nền tảng xcyber chạy nhiều bản song
 * song. Gộp tất cả vào MST nhà cung cấp thì một cổng của một người bán hỏng sẽ ngắt mạch
 * cho toàn bộ hoá đơn của nhà cung cấp đó — và ngược lại, giãn nhịp 4 giây lại áp oan
 * giữa hai cổng chẳng liên quan gì nhau.
 */
function portalKey(taxCode: string, lookupUrl: string | null): string {
  try {
    if (lookupUrl) return `${taxCode}@${new URL(lookupUrl.trim()).host.toLowerCase()}`;
  } catch { /* link hỏng thì tính chung theo nhà cung cấp */ }
  return taxCode;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} quá ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

// ─── Dữ liệu hoá đơn ──────────────────────────────────────────────────────────

interface InvoiceRow {
  id: string;
  seller_tax_code: string | null;
  serial_number:   string | null;
  invoice_number:  string;
  invoice_date:    Date | null;
  provider_solution_tax_code: string | null;
  gdt_tvandnkntt:  string | null;
  provider_lookup_code: string | null;
  provider_lookup_url:  string | null;
  provider_pdf_path:    string | null;
  provider_pdf_size:    number | null;
}

async function loadInvoice(companyId: string, invoiceId: string): Promise<InvoiceRow | null> {
  const { rows } = await pool.query<InvoiceRow>(
    `SELECT id, seller_tax_code, serial_number, invoice_number, invoice_date,
            provider_solution_tax_code, gdt_tvandnkntt,
            provider_lookup_code, provider_lookup_url,
            provider_pdf_path, provider_pdf_size
       FROM invoices
      WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [invoiceId, companyId],
  );
  return rows[0] ?? null;
}

function toRequest(inv: InvoiceRow, companyId: string): PortalRequest {
  return {
    invoiceId:       inv.id,
    companyId,
    providerTaxCode: inv.provider_solution_tax_code,
    sellerTaxCode:   inv.seller_tax_code,
    lookupCode:      inv.provider_lookup_code,
    lookupUrl:       inv.provider_lookup_url,
    serial:          inv.serial_number ?? '',
    invoiceNumber:   inv.invoice_number,
    invoiceDate:     inv.invoice_date,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

class ProviderPortalService {
  /** Hoá đơn này có tra tự động được không — giao diện dùng để quyết định hiện nút gì */
  async capability(keys: {
    solutionTaxCode: string | null; tvanTaxCode: string | null; lookupUrl: string | null;
    sellerTaxCode?: string | null;
  }): Promise<PortalCapability> {
    const row = await resolvePortalConfig(keys);
    const driver = buildDriver(row);
    return {
      supported:     !!driver,
      driver_id:     driver?.id ?? null,
      provider:      driver?.name ?? row?.name ?? null,
      needs_captcha: driver?.usesCaptcha === true,
      verified:      driver?.status === 'verified',
    };
  }

  /**
   * Bắt đầu tra cứu. Cổng không bắt mã xác thực thì file về luôn trong lượt này;
   * cổng có mã xác thực thì trả ảnh để người dùng nhập rồi gọi tiếp submitCaptcha().
   */
  async start(companyId: string, invoiceId: string, userId: string, force = false): Promise<PortalOutcome> {
    try {
      return await this.startInner(companyId, invoiceId, userId, force);
    } catch (err) {
      // Lưới cuối: hỏng ở đâu cũng không được vỡ ra ngoài route
      return {
        status: 'error',
        message: `Lỗi nội bộ khi tra cứu: ${msgOf(err)}`.slice(0, 300),
        portalUrl: null,
      };
    }
  }

  private async startInner(
    companyId: string, invoiceId: string, userId: string, force: boolean,
  ): Promise<PortalOutcome> {
    const inv = await loadInvoice(companyId, invoiceId);
    if (!inv) return { status: 'error', message: 'Không tìm thấy hoá đơn', portalUrl: null };

    const portalUrl = inv.provider_lookup_url;

    if (!force && inv.provider_pdf_path && resolveStored(inv.provider_pdf_path)) {
      return {
        status: 'ready',
        message: 'Bản gốc của nhà cung cấp đã có sẵn trong hệ thống',
        size: inv.provider_pdf_size,
      };
    }

    if (!cfg.boolean('provider_lookup.enabled', true)) {
      return {
        status: 'manual', portalUrl,
        message: 'Tính năng tải bản gốc từ cổng nhà cung cấp đang tắt. Mở cổng tra cứu để lấy tay.',
      };
    }

    const row = await resolvePortalConfig({
      solutionTaxCode: inv.provider_solution_tax_code,
      tvanTaxCode:     inv.gdt_tvandnkntt,
      lookupUrl:       inv.provider_lookup_url,
      sellerTaxCode:   inv.seller_tax_code,
    });
    const driver = buildDriver(row);
    if (!driver) {
      return {
        status: 'manual', portalUrl: portalUrl ?? row?.portalUrl ?? null,
        message: row
          ? `Chưa hỗ trợ tải tự động từ ${row.name}. Mở cổng tra cứu của họ và nhập mã ở trên.`
          : 'Chưa nhận diện được cổng tra cứu của nhà cung cấp phát hành hoá đơn này.',
      };
    }

    if (driver.requiresLookupCode && !(inv.provider_lookup_code ?? '').trim()) {
      return {
        status: 'notfound', portalUrl: portalUrl ?? row?.portalUrl ?? null,
        message: 'Hoá đơn không kèm mã tra cứu trong XML nên không tra được trên cổng nhà cung cấp',
      };
    }

    const gate = await this.gate(portalKey(row!.taxCode, inv.provider_lookup_url), driver.name);
    if (gate) return { ...gate, portalUrl };

    const http = createPortalHttp(this.timeoutMs());
    try {
      const step = await raceTimeout(
        driver.begin(toRequest(inv, companyId), http),
        this.timeoutMs(), `Tra cứu ${driver.name}`,
      );

      if (step.kind === 'document') {
        stateOf(portalKey(row!.taxCode, inv.provider_lookup_url)).failures = 0;
        return await this.store(inv, driver, step.doc);
      }

      // Cổng bắt mã xác thực — cất phiên rồi đẩy ảnh lên giao diện
      sweepSessions();
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        companyId, invoiceId, userId,
        driverId:  driver.id,
        state:     step.state,
        cookies:   http.exportCookies(),
        attempts:  0,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      stateOf(portalKey(row!.taxCode, inv.provider_lookup_url)).failures = 0;
      return {
        status: 'captcha',
        sessionId,
        imageDataUrl: step.imageDataUrl,
        hint:         step.hint ?? 'Nhập mã xác thực trong ảnh',
        message:      `Cổng ${driver.name} yêu cầu mã xác thực — nhìn ảnh và nhập giúp hệ thống`,
        attemptsLeft: MAX_ATTEMPTS,
      };
    } catch (err) {
      return this.failure(err, portalKey(row!.taxCode, inv.provider_lookup_url), driver.name, portalUrl ?? row!.portalUrl);
    }
  }

  /** Bước 2: người dùng đã nhập mã xác thực */
  async submitCaptcha(companyId: string, sessionId: string, answer: string): Promise<PortalOutcome> {
    try {
      return await this.submitInner(companyId, sessionId, answer);
    } catch (err) {
      return { status: 'error', message: `Lỗi nội bộ khi tra cứu: ${msgOf(err)}`.slice(0, 300), portalUrl: null };
    }
  }

  private async submitInner(companyId: string, sessionId: string, answer: string): Promise<PortalOutcome> {
    sweepSessions();
    const session = sessions.get(sessionId);
    if (!session || session.companyId !== companyId) {
      return {
        status: 'error', portalUrl: null,
        message: 'Phiên tra cứu đã hết hạn — bấm "Lấy bản gốc" để lấy mã xác thực mới',
      };
    }

    const inv = await loadInvoice(companyId, session.invoiceId);
    if (!inv) {
      sessions.delete(sessionId);
      return { status: 'error', message: 'Không tìm thấy hoá đơn', portalUrl: null };
    }

    const row = await resolvePortalConfig({
      solutionTaxCode: inv.provider_solution_tax_code,
      tvanTaxCode:     inv.gdt_tvandnkntt,
      lookupUrl:       inv.provider_lookup_url,
      sellerTaxCode:   inv.seller_tax_code,
    });
    const driver = buildDriver(row);
    if (!driver || driver.id !== session.driverId || !driver.complete) {
      sessions.delete(sessionId);
      return {
        status: 'error', portalUrl: inv.provider_lookup_url,
        message: 'Cấu hình cổng tra cứu vừa thay đổi — bấm "Lấy bản gốc" để bắt đầu lại',
      };
    }

    session.attempts += 1;
    const http = createPortalHttp(this.timeoutMs(), session.cookies);

    try {
      const doc = await raceTimeout(
        driver.complete(toRequest(inv, companyId), http, session.state, answer.trim()),
        this.timeoutMs(), `Tra cứu ${driver.name}`,
      );
      sessions.delete(sessionId);
      stateOf(portalKey(row!.taxCode, inv.provider_lookup_url)).failures = 0;
      return await this.store(inv, driver, doc);
    } catch (err) {
      // Nhập sai mã xác thực là chuyện thường — lấy ảnh mới cho người dùng thử lại,
      // KHÔNG tính vào lỗi cổng.
      if (err instanceof PortalCaptchaError && session.attempts < MAX_ATTEMPTS) {
        sessions.delete(sessionId);
        const retry = await this.start(companyId, session.invoiceId, session.userId, true);
        if (retry.status === 'captcha') {
          const s = sessions.get(retry.sessionId);
          if (s) s.attempts = session.attempts;
          return {
            ...retry,
            message: `${err.message}. Còn ${MAX_ATTEMPTS - session.attempts} lần thử.`,
            attemptsLeft: MAX_ATTEMPTS - session.attempts,
          };
        }
        return retry;
      }
      sessions.delete(sessionId);
      if (err instanceof PortalCaptchaError) {
        return {
          status: 'error', portalUrl: inv.provider_lookup_url,
          message: 'Nhập sai mã xác thực quá số lần cho phép. Bấm "Lấy bản gốc" để thử lại từ đầu.',
        };
      }
      return this.failure(err, portalKey(row!.taxCode, inv.provider_lookup_url), driver.name, inv.provider_lookup_url ?? row!.portalUrl);
    }
  }

  // ── Nội bộ ─────────────────────────────────────────────────────────────────

  private timeoutMs(): number {
    return cfg.number('provider_lookup.timeout_ms', 45_000);
  }

  /** Ngắt mạch + giãn nhịp. Trả về outcome khi phải chặn, null khi được đi tiếp. */
  private async gate(taxCode: string, name: string): Promise<Omit<Extract<PortalOutcome, { status: 'error' }>, 'portalUrl'> | null> {
    const st = stateOf(taxCode);
    const now = Date.now();
    if (st.openUntil > now) {
      const conLai = Math.ceil((st.openUntil - now) / 1000);
      return {
        status: 'error',
        message: `Cổng ${name} đang lỗi liên tiếp, tạm ngừng gọi thêm ${conLai}s. Dùng cổng tra cứu để lấy tay.`,
      };
    }
    const minGap = cfg.number('provider_lookup.min_interval_ms', 4000);
    const since = now - st.lastCallAt;
    if (st.lastCallAt > 0 && since < minGap) await sleep(minGap - since);
    st.lastCallAt = Date.now();
    return null;
  }

  private failure(err: unknown, taxCode: string, name: string, portalUrl: string | null): PortalOutcome {
    const message = msgOf(err).slice(0, 300);

    // Lỗi dữ liệu hoá đơn / cổng khẳng định không có: kết luận cuối, KHÔNG tính lỗi cổng
    if (err instanceof PortalInputError || err instanceof PortalNotFoundError) {
      return { status: 'notfound', message, portalUrl };
    }
    if (err instanceof PortalManualOnlyError) {
      return { status: 'manual', message, portalUrl };
    }

    const st = stateOf(taxCode);
    st.failures += 1;
    const nguong = cfg.number('provider_lookup.breaker_failures', 5);
    const nghiMs = cfg.number('provider_lookup.breaker_cooldown_ms', 15 * 60_000);
    if (st.failures >= nguong) {
      st.openUntil = Date.now() + nghiMs;
      st.failures = 0;
    }
    return {
      status: 'error', portalUrl,
      message: `Cổng ${name} chưa trả được bản gốc: ${message}`,
    };
  }

  /** Lưu file và cập nhật hoá đơn. Cổng trả HTML thì render thành PDF trước. */
  private async store(inv: InvoiceRow, driver: PortalDriver, doc: PortalDocument): Promise<PortalOutcome> {
    const pdf = doc.kind === 'pdf' ? doc.data : await renderHtmlToPdf(doc.html);

    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM invoices WHERE id = $1`, [inv.id],
    );
    const companyId = rows[0]?.company_id;
    if (!companyId) return { status: 'error', message: 'Không tìm thấy hoá đơn', portalUrl: null };

    const relDir = path.join(companyId, inv.id);
    fs.mkdirSync(path.join(storageRoot(), relDir), { recursive: true });
    const rel = path.join(relDir, 'provider.pdf');
    fs.writeFileSync(path.join(storageRoot(), rel), pdf);

    const source = `portal:${driver.id}`;
    await pool.query(
      `UPDATE invoices
          SET provider_pdf_path   = $2,
              provider_pdf_size   = $3,
              provider_pdf_status = 'available',
              provider_pdf_source = $4,
              provider_pdf_at     = NOW(),
              provider_pdf_error  = NULL
        WHERE id = $1`,
      [inv.id, rel.split(path.sep).join('/'), pdf.byteLength, source],
    );

    return {
      status: 'done',
      size: pdf.byteLength,
      source,
      message: `Đã tải bản gốc theo mẫu ${driver.name}`,
    };
  }
}

/** Chống path traversal + kiểm tra file còn trên ổ đĩa */
function resolveStored(relPath: string): boolean {
  const root = path.resolve(storageRoot());
  const abs  = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep)) return false;
  return fs.existsSync(abs);
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const providerPortalService = new ProviderPortalService();
