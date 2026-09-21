/**
 * Chẩn đoán GDT — admin bấm "Chẩn đoán" cho một công ty, bot chạy lại từng mốc
 * của luồng đồng bộ thật và báo mốc nào hỏng, vì sao, sửa thế nào.
 *
 * Queue: gdt-diagnose (backend enqueue, backend đọc progress/returnvalue).
 *
 * Các mốc:
 *   1. Cấu hình bot (is_active, blocked_until, tạm dừng toàn hệ thống)
 *   2. Giải mã tài khoản
 *   3. Khóa 2Captcha + số dư
 *   4. Chọn proxy  →  5. TCP proxy  →  6. TLS tới GDT qua proxy  →  7. IP thoát
 *   8. Tải captcha GDT
 *   9. Lớp chống bot GDT (gửi username giả + captcha sai, có/không header trình duyệt)
 *  10. Giải captcha
 *  11. Đăng nhập bằng tài khoản thật
 *  12. Gọi endpoint kéo hóa đơn (mua vào + bán ra, 1 bản ghi, 30 ngày gần nhất)
 *
 * Chẩn đoán KHÔNG ghi gì vào gdt_bot_configs và KHÔNG bao giờ đi thẳng tới GDT
 * không qua proxy (quy tắc bắt buộc của bot).
 */
import { Worker, type Job } from 'bullmq';
import axios, { type AxiosInstance } from 'axios';
import Redis from 'ioredis';
import { pool } from './db';
import { logger } from './logger';
import { decryptCredentials } from './encryption.service';
import { proxyManager } from './proxy-manager';
import { createTunnelAgent, probeTlsViaProxy } from './proxy-tunnel';
import { CaptchaService } from './captcha.service';
import { attachGdtBrowserHeaders, isGdtWafBlock } from './gdt-request-headers';

const REDIS_URL  = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const GDT_HOST   = 'hoadondientu.gdt.gov.vn';
const GDT_API    = `http://${GDT_HOST}:443/api`; // http:// + tunnel agent làm TLS (giống GdtDirectApiService)
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_LOGIN_CAPTCHA_ATTEMPTS = 3;

export type StepStatus = 'ok' | 'warn' | 'fail' | 'skip' | 'running';

export interface DiagnoseStep {
  key:     string;
  title:   string;
  status:  StepStatus;
  ms?:     number;
  detail?: string;
  data?:   Record<string, unknown>;
}

/** Mã nguyên nhân — frontend ánh xạ sang nút khắc phục. */
export type VerdictCode =
  | 'ALL_OK' | 'CONFIG_MISSING' | 'BOT_INACTIVE' | 'DECRYPT_FAIL'
  | 'CAPTCHA_KEY_MISSING' | 'CAPTCHA_NO_BALANCE' | 'CAPTCHA_SOLVE_FAIL' | 'CAPTCHA_WRONG'
  | 'NO_PROXY' | 'PROXY_TCP_FAIL' | 'PROXY_TLS_FAIL'
  | 'GDT_WAF_BLOCK' | 'GDT_CAPTCHA_API_FAIL' | 'CREDENTIALS_REJECTED'
  | 'GDT_RATE_LIMIT' | 'GDT_SERVER_ERROR' | 'NETWORK_ERROR' | 'FETCH_FAIL';

export interface DiagnoseResult {
  companyId:  string;
  companyName: string | null;
  taxCode:    string | null;
  startedAt:  string;
  finishedAt: string;
  steps:      DiagnoseStep[];
  verdict:    { code: VerdictCode; title: string; detail: string };
  /** Các cảnh báo không chặn luồng (bị auto-block, tạm dừng toàn hệ thống...). */
  warnings:   string[];
  state: {
    isActive: boolean;
    blockedUntil: string | null;
    consecutiveFailures: number;
    globalPaused: boolean;
    lastError: string | null;
  } | null;
}

export interface DiagnoseJobData {
  companyId:    string;
  requestedBy?: string;
  /** daily = lịch tự động hằng ngày, admin = admin bấm ở /admin/gdt-diagnose */
  source?:      'daily' | 'admin';
}

class StopDiagnose extends Error {
  constructor(public code: VerdictCode, public title: string, public detail: string) { super(title); }
}

function maskProxy(url: string): string {
  try { const u = new URL(url); return `${u.hostname}:${u.port}`; } catch { return 'proxy'; }
}

function maskUser(u: string): string {
  return u.length <= 4 ? '****' : `${u.slice(0, 3)}***${u.slice(-2)}`;
}

function gdtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function bodyMessage(data: unknown): string {
  if (typeof data === 'string') return data.slice(0, 300);
  const o = (data ?? {}) as Record<string, unknown>;
  return String(o['message'] ?? o['error'] ?? JSON.stringify(data ?? '')).slice(0, 300);
}

function errText(err: unknown): string {
  if (axios.isAxiosError(err)) return `${err.code ?? ''} ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

function isCaptchaMsg(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('captcha') || m.includes('mã xác nhận') || m.includes('mã xác thực');
}

async function runDiagnose(job: Job<DiagnoseJobData>): Promise<DiagnoseResult> {
  const { companyId } = job.data;
  const steps: DiagnoseStep[] = [];
  const warnings: string[] = [];
  const startedAt = new Date().toISOString();
  let state: DiagnoseResult['state'] = null;
  let companyName: string | null = null;
  let taxCode: string | null = null;

  const publish = () => job.updateProgress({ steps }).catch(() => {});

  /** Chạy một mốc; fn trả về kết quả của mốc, ném StopDiagnose để dừng chẩn đoán. */
  async function step<T>(
    key: string, title: string,
    fn: (s: DiagnoseStep) => Promise<T>,
  ): Promise<T> {
    const s: DiagnoseStep = { key, title, status: 'running' };
    steps.push(s);
    await publish();
    const t0 = Date.now();
    try {
      const r = await fn(s);
      if (s.status === 'running') s.status = 'ok';
      return r;
    } catch (err) {
      s.status = 'fail';
      if (!s.detail) s.detail = err instanceof StopDiagnose ? err.detail : errText(err);
      throw err;
    } finally {
      s.ms = Date.now() - t0;
      await publish();
    }
  }

  const finish = (code: VerdictCode, title: string, detail: string): DiagnoseResult => {
    for (const s of steps) if (s.status === 'running') s.status = 'skip';
    return {
      companyId, companyName, taxCode, startedAt,
      finishedAt: new Date().toISOString(),
      steps, verdict: { code, title, detail }, warnings, state,
    };
  };

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });

  try {
    // ── 1. Cấu hình ──────────────────────────────────────────────────────────
    const cfgRow = await step('config', 'Cấu hình bot của công ty', async (s) => {
      const r = await pool.query<{
        encrypted_credentials: string; is_active: boolean; blocked_until: string | null;
        consecutive_failures: number; last_error: string | null; tax_code: string | null; name: string | null;
      }>(
        `SELECT b.encrypted_credentials, b.is_active, b.blocked_until, b.consecutive_failures,
                b.last_error, COALESCE(b.tax_code, c.tax_code) AS tax_code, c.name
         FROM gdt_bot_configs b JOIN companies c ON c.id = b.company_id
         WHERE b.company_id = $1`,
        [companyId],
      );
      const row = r.rows[0];
      if (!row) throw new StopDiagnose('CONFIG_MISSING', 'Công ty chưa cấu hình bot GDT', 'Không có dòng gdt_bot_configs cho công ty này.');
      companyName = row.name; taxCode = row.tax_code;
      await redis.connect().catch(() => {});
      const globalPaused = (await redis.get('gdt:auto_sync:paused').catch(() => null)) === '1';
      state = {
        isActive: row.is_active,
        blockedUntil: row.blocked_until,
        consecutiveFailures: row.consecutive_failures ?? 0,
        globalPaused,
        lastError: row.last_error,
      };
      const notes: string[] = [];
      if (!row.is_active) { notes.push('Bot đang TẮT (is_active = false)'); warnings.push('BOT_INACTIVE'); }
      if (row.blocked_until && new Date(row.blocked_until) > new Date()) {
        notes.push(`Đang bị tự khoá tới ${new Date(row.blocked_until).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} sau ${row.consecutive_failures} lần lỗi liên tiếp`);
        warnings.push('BLOCKED');
      }
      if (globalPaused) { notes.push('Auto-sync toàn hệ thống đang TẠM DỪNG bởi admin'); warnings.push('GLOBAL_PAUSED'); }
      if (row.last_error) notes.push(`Lỗi gần nhất: ${row.last_error.slice(0, 200)}`);
      s.detail = notes.length ? notes.join(' · ') : 'Bot đang bật, không bị khoá';
      if (warnings.length) s.status = 'warn';
      s.data = { taxCode: row.tax_code };
      return row;
    });

    // ── 2. Tài khoản ─────────────────────────────────────────────────────────
    const creds = await step('credentials', 'Giải mã tài khoản GDT', async (s) => {
      try {
        const c = decryptCredentials(cfgRow.encrypted_credentials);
        if (!c.username || !c.password) throw new Error('thiếu username/password');
        s.detail = `Tài khoản ${maskUser(c.username)}`;
        return c;
      } catch (err) {
        throw new StopDiagnose('DECRYPT_FAIL', 'Không giải mã được tài khoản GDT',
          `${errText(err)} — ENCRYPTION_KEY của bot khác backend, hoặc dữ liệu hỏng. Cần nhập lại tài khoản.`);
      }
    });

    // ── 3. 2Captcha ──────────────────────────────────────────────────────────
    await step('captcha_key', 'Khoá 2Captcha & số dư', async (s) => {
      const key = process.env['TWO_CAPTCHA_API_KEY'] ?? '';
      if (!key) throw new StopDiagnose('CAPTCHA_KEY_MISSING', 'Chưa cấu hình TWO_CAPTCHA_API_KEY', 'Biến môi trường TWO_CAPTCHA_API_KEY của bot đang trống.');
      const r = await axios.get('https://2captcha.com/res.php', {
        params: { key, action: 'getbalance', json: 1 }, timeout: 15_000, validateStatus: () => true,
      });
      const d = r.data as { status?: number; request?: string };
      if (d?.status !== 1) {
        throw new StopDiagnose('CAPTCHA_KEY_MISSING', 'Khoá 2Captcha không hợp lệ', `2Captcha trả: ${d?.request ?? r.status}`);
      }
      const balance = Number(d.request);
      s.data = { balance };
      if (balance <= 0.01) throw new StopDiagnose('CAPTCHA_NO_BALANCE', 'Tài khoản 2Captcha hết tiền', `Số dư: $${balance}`);
      s.detail = `Số dư $${balance.toFixed(3)}`;
      if (balance < 1) s.status = 'warn';
    });

    // ── 4-7. Proxy ───────────────────────────────────────────────────────────
    const proxyUrl = await step('proxy_select', 'Chọn proxy (giống đồng bộ thủ công)', async (s) => {
      const owner = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM user_companies WHERE company_id = $1 AND role = 'OWNER' LIMIT 1`, [companyId]);
      const ownerId = owner.rows[0]?.user_id;
      if (!ownerId) throw new StopDiagnose('NO_PROXY', 'Công ty không có OWNER để gán proxy', 'Không tìm thấy user OWNER trong user_companies.');
      const url = await proxyManager.nextForManualSync(ownerId);
      if (!url) {
        throw new StopDiagnose('NO_PROXY', 'Không có proxy khả dụng',
          'Chủ công ty chưa được gán proxy hoặc mọi proxy được gán đã hết hạn/bị chặn. Bot không bao giờ crawl bằng IP trực tiếp.');
      }
      s.detail = maskProxy(url);
      return url;
    });

    await step('proxy_tcp', 'Kết nối TCP tới proxy', async (s) => {
      const ok = await proxyManager.probe(proxyUrl, 8_000);
      if (!ok) throw new StopDiagnose('PROXY_TCP_FAIL', 'Proxy không phản hồi', `Không mở được TCP tới ${maskProxy(proxyUrl)} trong 8 giây — proxy chết hoặc hết hạn.`);
      s.detail = maskProxy(proxyUrl);
    });

    await step('proxy_tls', 'Bắt tay TLS tới GDT qua proxy', async (s) => {
      const ok = await probeTlsViaProxy(proxyUrl, GDT_HOST, 443, 12_000);
      if (!ok) throw new StopDiagnose('PROXY_TLS_FAIL', 'Proxy không vào được GDT', 'CONNECT/TLS tới hoadondientu.gdt.gov.vn:443 thất bại — IP proxy có thể bị GDT chặn ở tầng mạng, hoặc proxy sai user/pass (407).');
      s.detail = 'TLS OK';
    });

    const agent = () => createTunnelAgent({ proxyUrl });

    await step('egress_ip', 'IP thoát của proxy', async (s) => {
      try {
        const r = await axios.get('http://api.ipify.org:443/', { httpAgent: agent(), timeout: 12_000, responseType: 'text' });
        s.detail = String(r.data).trim().slice(0, 45);
      } catch (err) {
        s.status = 'warn';
        s.detail = `Không lấy được IP thoát (${errText(err)}) — không ảnh hưởng GDT`;
      }
    });

    const makeClient = (withBrowserHeaders: boolean): AxiosInstance => {
      const c = axios.create({
        baseURL: GDT_API, timeout: 30_000, httpAgent: agent(), validateStatus: () => true,
        headers: {
          'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'vi-VN,vi;q=0.9', 'Origin': `https://${GDT_HOST}`, 'Referer': `https://${GDT_HOST}/`,
        },
      });
      if (withBrowserHeaders) attachGdtBrowserHeaders(c);
      return c;
    };
    const http = makeClient(true);

    const classifyHttp = (status: number, data: unknown, where: string): never => {
      const msg = bodyMessage(data);
      if (isGdtWafBlock(status, data)) {
        throw new StopDiagnose('GDT_WAF_BLOCK', `GDT chặn request ${where} (403 chống bot)`, `GDT trả: "${msg}"`);
      }
      if (status === 429) throw new StopDiagnose('GDT_RATE_LIMIT', 'GDT giới hạn tần suất (429)', `Proxy này gọi quá nhiều. ${msg}`);
      if (status >= 500) throw new StopDiagnose('GDT_SERVER_ERROR', `GDT lỗi máy chủ (${status})`, msg);
      throw new StopDiagnose('GDT_CAPTCHA_API_FAIL', `GDT trả HTTP ${status} ở bước ${where}`, msg);
    };

    // ── 8. Captcha GDT ───────────────────────────────────────────────────────
    const getCaptcha = async (): Promise<{ key: string; content: string }> => {
      let r;
      try { r = await http.get('/captcha'); }
      catch (err) { throw new StopDiagnose('NETWORK_ERROR', 'Lỗi mạng khi gọi GDT qua proxy', errText(err)); }
      if (r.status !== 200) classifyHttp(r.status, r.data, 'captcha');
      const d = r.data as { key?: string; content?: string };
      if (!d?.key || typeof d.content !== 'string') {
        throw new StopDiagnose('GDT_CAPTCHA_API_FAIL', 'GDT đổi cấu trúc API captcha',
          `Thiếu key/content. Các trường nhận được: ${Object.keys(d ?? {}).join(', ') || '(rỗng)'}`);
      }
      return { key: d.key, content: d.content };
    };

    const probeCaptcha = await step('gdt_captcha', 'Gọi API captcha của GDT', async (s) => {
      const c = await getCaptcha();
      s.detail = `Nhận captcha SVG (${c.content.length} ký tự)`;
      return c;
    });

    // ── 9. Lớp chống bot ─────────────────────────────────────────────────────
    // Username giả + captcha sai: GDT kiểm captcha trước tài khoản nên không đụng
    // tới bộ đếm đăng nhập sai của tài khoản thật.
    await step('gdt_waf', 'Lớp chống bot của GDT (request thử, không dùng tài khoản thật)', async (s) => {
      const payload = { username: '0000000000', password: 'diagnose', cvalue: 'XXXXXX', ckey: probeCaptcha.key };
      const bare = await makeClient(false).post('/security-taxpayer/authenticate', payload).catch(e => ({ status: 0, data: errText(e) }));
      const full = await http.post('/security-taxpayer/authenticate', payload).catch(e => ({ status: 0, data: errText(e) }));
      const bareBlocked = isGdtWafBlock(bare.status, bare.data);
      const fullBlocked = isGdtWafBlock(full.status, full.data);
      s.data = {
        withoutBrowserHeaders: { status: bare.status, message: bodyMessage(bare.data) },
        withBrowserHeaders:    { status: full.status, message: bodyMessage(full.data) },
      };
      if (fullBlocked) {
        throw new StopDiagnose('GDT_WAF_BLOCK', 'GDT chặn mọi request đăng nhập từ proxy này',
          `Kể cả khi gửi đủ header trình duyệt, GDT vẫn trả 403 "${bodyMessage(full.data)}". IP proxy ${maskProxy(proxyUrl)} nhiều khả năng đã bị GDT gắn cờ — cần đổi proxy.`);
      }
      if (full.status === 0) throw new StopDiagnose('NETWORK_ERROR', 'Lỗi mạng khi thử đăng nhập', String(full.data));
      s.detail = bareBlocked
        ? `GDT yêu cầu header trình duyệt (request-id): thiếu header → 403, có header → ${full.status} "${bodyMessage(full.data)}". Bot đã gửi header này.`
        : `Không bị chặn (HTTP ${full.status} "${bodyMessage(full.data)}")`;
    });

    // ── 10-11. Giải captcha + đăng nhập thật ─────────────────────────────────
    const captchaService = new CaptchaService();
    const { default: sharp } = await import('sharp');
    let token: string | null = null;
    let lastLoginMsg = '';

    for (let attempt = 1; attempt <= MAX_LOGIN_CAPTCHA_ATTEMPTS && !token; attempt++) {
      const suffix = attempt > 1 ? ` (lần ${attempt})` : '';
      const solved = await step(`captcha_solve_${attempt}`, `Tải & giải captcha qua 2Captcha${suffix}`, async (s) => {
        const c = await getCaptcha();
        try {
          const png = await sharp(Buffer.from(c.content)).png().toBuffer();
          const r = await captchaService.solve(png.toString('base64'));
          const text = r.text.trim().toUpperCase();
          s.detail = `Kết quả "${text}"`;
          return { ckey: c.key, cvalue: text, captchaId: r.captchaId };
        } catch (err) {
          throw new StopDiagnose('CAPTCHA_SOLVE_FAIL', '2Captcha không giải được captcha', errText(err));
        }
      });

      token = await step(`login_${attempt}`, `Đăng nhập GDT bằng tài khoản thật${suffix}`, async (s) => {
        let r;
        try {
          r = await http.post('/security-taxpayer/authenticate', {
            username: creds.username, password: creds.password, cvalue: solved.cvalue, ckey: solved.ckey,
          });
        } catch (err) {
          throw new StopDiagnose('NETWORK_ERROR', 'Lỗi mạng khi đăng nhập', errText(err));
        }
        const jwt = (r.data as { token?: string })?.token;
        if (r.status === 200 && jwt) {
          s.detail = 'Đăng nhập thành công, nhận JWT';
          return jwt;
        }
        const msg = bodyMessage(r.data);
        lastLoginMsg = msg;
        if ((r.status === 400 || r.status === 401) && isCaptchaMsg(msg)) {
          await captchaService.reportBad(solved.captchaId).catch(() => {});
          s.status = 'warn';
          s.detail = `GDT báo captcha sai: "${msg}"`;
          return null;
        }
        if (r.status === 400 || r.status === 401) {
          throw new StopDiagnose('CREDENTIALS_REJECTED', 'GDT từ chối tài khoản',
            `GDT trả ${r.status}: "${msg}". Sai mật khẩu, tài khoản bị khoá hoặc đã đổi mật khẩu trên cổng GDT.`);
        }
        return classifyHttp(r.status, r.data, 'đăng nhập');
      });
    }

    if (!token) {
      throw new StopDiagnose('CAPTCHA_WRONG', `Captcha sai ${MAX_LOGIN_CAPTCHA_ATTEMPTS} lần liên tiếp`,
        `GDT: "${lastLoginMsg}". 2Captcha đang giải kém chính xác — thử lại sau hoặc đổi dịch vụ giải.`);
    }

    // ── 12. Kéo hóa đơn ──────────────────────────────────────────────────────
    const to   = new Date();
    const from = new Date(to.getTime() - 30 * 86_400_000);
    const search = `tdlap=ge=${gdtDate(from)};tdlap=le=${gdtDate(to)}`;
    for (const [endpoint, label] of [['purchase', 'mua vào'], ['sold', 'bán ra']] as const) {
      await step(`fetch_${endpoint}`, `Gọi endpoint kéo hóa đơn ${label} (30 ngày gần nhất)`, async (s) => {
        let r;
        try {
          // Chuỗi query tự ghép: FIQL của GDT cần giá trị thô, không encode.
          r = await http.get(`/query/invoices/${endpoint}?sort=tdlap:desc&size=1&page=0&search=${search}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch (err) {
          throw new StopDiagnose('NETWORK_ERROR', `Lỗi mạng khi kéo hóa đơn ${label}`, errText(err));
        }
        if (r.status === 401) {
          throw new StopDiagnose('FETCH_FAIL', `GDT từ chối token khi kéo hóa đơn ${label} (401)`,
            'Token vừa nhận bị từ chối — GDT có thể ràng buộc phiên với IP và proxy đổi IP giữa chừng (proxy xoay).');
        }
        if (r.status !== 200) {
          try { classifyHttp(r.status, r.data, `kéo hóa đơn ${label}`); }
          catch (e) {
            if (e instanceof StopDiagnose && e.code === 'GDT_CAPTCHA_API_FAIL') {
              throw new StopDiagnose('FETCH_FAIL', `Kéo hóa đơn ${label} lỗi HTTP ${r.status}`, e.detail);
            }
            throw e;
          }
        }
        const header = parseInt(String(r.headers['x-total-count'] ?? ''), 10);
        const body = r.data as { total?: number; datas?: unknown[] };
        const total = !isNaN(header) ? header : (typeof body?.total === 'number' ? body.total : null);
        if (total === null && !Array.isArray(body?.datas)) {
          throw new StopDiagnose('FETCH_FAIL', `GDT đổi cấu trúc dữ liệu hóa đơn ${label}`,
            `Không có X-Total-Count/total/datas. Trường nhận được: ${Object.keys(body ?? {}).join(', ')}`);
        }
        s.data = { total };
        s.detail = `HTTP 200 — ${total ?? '?'} hóa đơn ${label} trong 30 ngày`;
      });
    }

    return finish('ALL_OK', 'Mọi mốc đều thông', 'Bot đăng nhập và kéo được hóa đơn qua proxy hiện tại.');
  } catch (err) {
    if (err instanceof StopDiagnose) return finish(err.code, err.title, err.detail);
    logger.error('[GdtDiagnose] Lỗi ngoài dự kiến', { companyId, error: errText(err) });
    return finish('NETWORK_ERROR', 'Lỗi ngoài dự kiến khi chẩn đoán', errText(err));
  } finally {
    redis.disconnect();
  }
}

/** Lưu kết quả mới nhất để dashboard báo tình trạng kết nối GDT cho người dùng. */
async function saveResult(r: DiagnoseResult, source: string): Promise<void> {
  if (r.verdict.code === 'CONFIG_MISSING') return;
  const failed = r.steps.find(s => s.status === 'fail');
  try {
    await pool.query(
      `INSERT INTO gdt_connection_checks
         (company_id, checked_at, ok, verdict_code, verdict_title, verdict_detail, failed_step, source, steps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (company_id) DO UPDATE SET
         checked_at = EXCLUDED.checked_at, ok = EXCLUDED.ok, verdict_code = EXCLUDED.verdict_code,
         verdict_title = EXCLUDED.verdict_title, verdict_detail = EXCLUDED.verdict_detail,
         failed_step = EXCLUDED.failed_step, source = EXCLUDED.source, steps = EXCLUDED.steps`,
      [r.companyId, r.finishedAt, r.verdict.code === 'ALL_OK', r.verdict.code, r.verdict.title,
       r.verdict.detail, failed?.title ?? null, source, JSON.stringify(r.steps)],
    );
  } catch (err) {
    logger.warn('[GdtDiagnose] Không lưu được kết quả chẩn đoán (non-fatal)', { companyId: r.companyId, error: errText(err) });
  }
}

export const diagnoseWorker = new Worker<DiagnoseJobData, DiagnoseResult>(
  'gdt-diagnose',
  async (job) => {
    const result = await runDiagnose(job);
    await saveResult(result, job.data.source ?? 'admin');
    logger.info('[GdtDiagnose] Xong', {
      companyId: result.companyId, source: job.data.source ?? 'admin', verdict: result.verdict.code,
    });
    return result;
  },
  {
    connection:   { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency:  1,
    lockDuration: 5 * 60_000,
  },
);

diagnoseWorker.on('failed', (job, err) => {
  logger.error('[GdtDiagnose] Job failed', { jobId: job?.id, error: err.message });
});
