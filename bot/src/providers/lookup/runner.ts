/**
 * Runner — nơi DUY NHẤT chạy plugin tra cứu, và là lớp cách ly với phần còn lại của bot.
 *
 * Cam kết với worker gọi nó: HÀM NÀY KHÔNG BAO GIỜ NÉM LỖI VÀ KHÔNG BAO GIỜ TREO.
 * Plugin hỏng, cổng nhà cung cấp chết, cấu hình sai, DB lỗi — tất cả đều trả về
 * { pdf: null, error } để worker ghi nhận rồi đi tiếp.
 *
 * Bốn lớp bảo vệ:
 *   1. Công tắc tổng   — cfg 'provider_lookup.enabled', tắt được tức thì từ trang admin
 *   2. Công tắc từng bên — einvoice_providers.lookup_enabled
 *   3. Timeout cứng    — raceTimeout, plugin treo không kéo theo hàng đợi XML
 *   4. Ngắt mạch + giãn nhịp — cổng lỗi liên tục thì ngừng gọi một lúc, và không bao giờ
 *      bắn hai request liên tiếp vào cùng một cổng trong khoảng tối thiểu
 */
import { cfg } from '../../config/ConfigStore';
import { logger } from '../../logger';
import { createLookupHttp } from './http';
import { buildAdapter, loadLookupConfigs } from './registry';
import { renderHtmlToPdf } from '../../invoice-document.service';
import { LookupDocument, LookupInputError, LookupNotFoundError, LookupRequest } from './types';

export interface LookupOutcome {
  pdf:    Buffer | null;
  source: string | null;
  error:  string | null;
  /** true = kết luận cuối cùng (không có mã / cổng khẳng định không có) → đừng thử lại */
  final:  boolean;
}

// ── Trạng thái theo từng cổng, giữ trong tiến trình ───────────────────────────
interface ProviderState {
  failures:    number;
  openUntil:   number;   // epoch ms; > now nghĩa là đang ngắt mạch
  lastCallAt:  number;
}
const state = new Map<string, ProviderState>();

function getState(key: string): ProviderState {
  let s = state.get(key);
  if (!s) { s = { failures: 0, openUntil: 0, lastCallAt: 0 }; state.set(key, s); }
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} quá ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Lấy PDF bản gốc trên cổng tra cứu công khai của nhà cung cấp.
 * Không ném lỗi trong mọi trường hợp.
 */
export async function fetchPdfFromPublicPortal(req: LookupRequest): Promise<LookupOutcome> {
  try {
    return await runGuarded(req);
  } catch (err) {
    // Lưới cuối: kể cả registry/ConfigStore hỏng cũng không được vỡ ra ngoài
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[ProviderLookup] Lỗi ngoài dự kiến — đã chặn lại', { invoiceId: req.invoiceId, error: msg });
    return { pdf: null, source: null, error: `Lỗi nội bộ khi tra cứu: ${msg}`.slice(0, 300), final: false };
  }
}

async function runGuarded(req: LookupRequest): Promise<LookupOutcome> {
  // ── 1. Công tắc tổng ──────────────────────────────────────────────────────
  if (!cfg.boolean('provider_lookup.enabled', true)) {
    return { pdf: null, source: null, error: 'Tính năng tải bản gốc từ cổng nhà cung cấp đang tắt', final: true };
  }

  const mst = (req.providerTaxCode ?? '').trim();
  if (!mst) {
    return { pdf: null, source: null, error: 'Hoá đơn không có MSTTCGP nên không biết cổng nào để tra', final: true };
  }

  // ── 2. Cấu hình + công tắc từng bên ───────────────────────────────────────
  const configs = await loadLookupConfigs();
  const row = configs.get(mst);
  const adapter = buildAdapter(row);
  if (!adapter) {
    return {
      pdf: null, source: null, final: true,
      error: row
        ? `Chưa bật tải tự động cho ${row.name} — dùng mã tra cứu trên giao diện`
        : 'Chưa hỗ trợ tải tự động từ nhà cung cấp này — dùng mã tra cứu trên giao diện',
    };
  }

  // Thiếu mã tra cứu thì khỏi tốn request
  if (adapter.requiresLookupCode && !(req.lookupCode ?? '').trim()) {
    return { pdf: null, source: null, error: 'Hoá đơn không kèm mã tra cứu trong XML', final: true };
  }

  // Cổng bắt captcha mà chưa cấu hình dịch vụ giải thì dừng sớm, đừng gọi ra ngoài vô ích
  if (adapter.needsCaptcha && !process.env['TWO_CAPTCHA_API_KEY']) {
    return {
      pdf: null, source: null, final: true,
      error: `Cổng ${adapter.name} yêu cầu mã xác thực nhưng chưa cấu hình TWO_CAPTCHA_API_KEY`,
    };
  }

  // ── 3. Ngắt mạch ──────────────────────────────────────────────────────────
  const st = getState(mst);
  const now = Date.now();
  if (st.openUntil > now) {
    const conLai = Math.ceil((st.openUntil - now) / 1000);
    return {
      pdf: null, source: null, final: false,
      error: `Cổng ${adapter.name} đang tạm ngừng gọi thêm ${conLai}s do lỗi liên tiếp`,
    };
  }

  // ── 4. Giãn nhịp: không bắn liên tiếp vào cùng một cổng ────────────────────
  const minGap = cfg.number('provider_lookup.min_interval_ms', 4000);
  const since = now - st.lastCallAt;
  if (st.lastCallAt > 0 && since < minGap) await sleep(minGap - since);
  st.lastCallAt = Date.now();

  // ── 5. Gọi plugin, có timeout cứng ────────────────────────────────────────
  const timeoutMs = cfg.number('provider_lookup.timeout_ms', 45_000);
  const http = createLookupHttp(Math.min(timeoutMs, 30_000));

  try {
    const doc = await raceTimeout(adapter.fetchPdf(req, http), timeoutMs, `Tra cứu ${adapter.name}`);
    const pdf = await toPdf(doc, adapter.name);
    st.failures = 0;
    logger.info('[ProviderLookup] Đã tải bản gốc từ cổng nhà cung cấp', {
      invoiceId: req.invoiceId, provider: adapter.name, bytes: pdf.byteLength,
    });
    return { pdf, source: `portal:${adapter.id}`, error: null, final: true };
  } catch (err) {
    return handleFailure(err, adapter.id, adapter.name, mst, st, req);
  }
}

function handleFailure(
  err: unknown, adapterId: string, adapterName: string,
  mst: string, st: ProviderState, req: LookupRequest,
): LookupOutcome {
  const msg = err instanceof Error ? err.message : String(err);

  // Lỗi do dữ liệu hoá đơn hoặc cổng khẳng định không có → kết luận cuối, KHÔNG tính lỗi cổng
  if (err instanceof LookupInputError || err instanceof LookupNotFoundError) {
    return { pdf: null, source: `portal:${adapterId}`, error: msg.slice(0, 300), final: true };
  }

  st.failures += 1;
  const nguong  = cfg.number('provider_lookup.breaker_failures', 5);
  const nghiMs  = cfg.number('provider_lookup.breaker_cooldown_ms', 15 * 60_000);
  if (st.failures >= nguong) {
    st.openUntil = Date.now() + nghiMs;
    st.failures = 0;
    logger.warn('[ProviderLookup] Ngắt mạch cổng nhà cung cấp', {
      provider: adapterName, mst, nghiPhut: Math.round(nghiMs / 60_000), loiCuoi: msg,
    });
  } else {
    logger.warn('[ProviderLookup] Tra cứu thất bại', {
      invoiceId: req.invoiceId, provider: adapterName, soLanLoi: st.failures, error: msg,
    });
  }
  return { pdf: null, source: `portal:${adapterId}`, error: msg.slice(0, 300), final: false };
}

/**
 * Cổng nào trả HTML bản thể hiện thì render thành PDF bằng Chromium — cùng cơ chế đang
 * dùng cho gói của cổng thuế, nên file đầu ra đồng nhất với phần còn lại của hệ thống.
 * File tạm luôn được dọn, kể cả khi render lỗi.
 */
async function toPdf(doc: LookupDocument, providerName: string): Promise<Buffer> {
  if (doc.kind === 'pdf') return doc.data;

  const fs   = await import('fs');
  const os   = await import('os');
  const path = await import('path');
  const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-'));
  const file = path.join(dir, 'invoice.html');
  try {
    fs.writeFileSync(file, doc.html, 'utf-8');
    const pdf = await renderHtmlToPdf(file);
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error(`Render bản thể hiện của ${providerName} không ra PDF hợp lệ`);
    }
    return pdf;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Dùng cho kiểm thử / công cụ vận hành: xoá trạng thái ngắt mạch */
export function resetLookupState(): void {
  state.clear();
}
