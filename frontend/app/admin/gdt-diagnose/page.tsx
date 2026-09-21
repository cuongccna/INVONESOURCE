'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../../lib/apiClient';

/* ── Types (khớp bot/src/gdt-diagnose.worker.ts) ─────────────────────────────── */

type StepStatus = 'ok' | 'warn' | 'fail' | 'skip' | 'running';

interface DiagnoseStep {
  key:     string;
  title:   string;
  status:  StepStatus;
  ms?:     number;
  detail?: string;
  data?:   Record<string, unknown>;
}

interface DiagnoseResult {
  companyId:   string;
  companyName: string | null;
  taxCode:     string | null;
  startedAt:   string;
  finishedAt:  string;
  steps:       DiagnoseStep[];
  verdict:     { code: string; title: string; detail: string };
  warnings:    string[];
  state: {
    isActive: boolean;
    blockedUntil: string | null;
    consecutiveFailures: number;
    globalPaused: boolean;
    lastError: string | null;
  } | null;
}

interface RunStatus {
  jobId:        string;
  state:        string;
  steps:        DiagnoseStep[];
  result:       DiagnoseResult | null;
  failedReason: string | null;
}

interface CompanyRow {
  company_id:           string;
  name:                 string;
  tax_code:             string | null;
  is_active:            boolean;
  blocked_until:        string | null;
  consecutive_failures: number;
  last_run_at:          string | null;
  last_run_status:      string | null;
  last_error:           string | null;
  owner_email:          string | null;
  check_at:             string | null;
  check_ok:             boolean | null;
  check_code:           string | null;
  check_title:          string | null;
  check_source:         string | null;
}

type FixAction = 'clear_block' | 'reactivate_bot' | 'reset_proxy_session' | 'resume_auto_sync' | 'run_sync';

interface Remedy {
  text:     string;
  action?:  FixAction;
  label?:   string;
  href?:    string;
  rerun?:   boolean;
}

/* ── Hướng khắc phục theo nguyên nhân ────────────────────────────────────────── */

const FIX_LABEL: Record<FixAction, string> = {
  clear_block:         'Gỡ tự khoá',
  reactivate_bot:      'Bật lại bot',
  reset_proxy_session: 'Đặt lại phiên proxy',
  resume_auto_sync:    'Bật lại auto-sync',
  run_sync:            'Chạy đồng bộ ngay',
};

function remediesFor(code: string): Remedy[] {
  switch (code) {
    case 'ALL_OK':
      return [{ text: 'Đường đi tới GDT đã thông. Có thể cho bot đồng bộ lại ngay.', action: 'run_sync' }];
    case 'CONFIG_MISSING':
      return [{ text: 'Chủ công ty cần khai báo tài khoản GDT trong Cài đặt → GDT Bot.', href: '/settings/bot', label: 'Mở cài đặt bot' }];
    case 'DECRYPT_FAIL':
      return [
        { text: 'Kiểm tra ENCRYPTION_KEY trong bot/.env và backend/.env phải giống hệt nhau, sau đó pm2 restart invone-bot.' },
        { text: 'Nếu key đúng, dữ liệu mã hoá đã hỏng — chủ công ty cần nhập lại tài khoản GDT.', href: '/settings/bot', label: 'Mở cài đặt bot' },
      ];
    case 'CAPTCHA_KEY_MISSING':
      return [{ text: 'Đặt TWO_CAPTCHA_API_KEY hợp lệ trong bot/.env rồi pm2 restart invone-bot --update-env.' }];
    case 'CAPTCHA_NO_BALANCE':
      return [{ text: 'Nạp tiền vào tài khoản 2Captcha (2captcha.com → Balance), sau đó chẩn đoán lại.', rerun: true }];
    case 'CAPTCHA_SOLVE_FAIL':
    case 'CAPTCHA_WRONG':
      return [{ text: '2Captcha tạm thời giải sai/chậm. Đợi vài phút rồi chẩn đoán lại; nếu lặp lại nhiều lần, cân nhắc đổi dịch vụ giải captcha.', rerun: true }];
    case 'NO_PROXY':
      return [{ text: 'Gán một proxy còn hạn cho chủ công ty (Proxy Pool → gán user). Bot không bao giờ chạy bằng IP trực tiếp.', href: '/admin/proxies', label: 'Mở Proxy Pool' }];
    case 'PROXY_TCP_FAIL':
      return [
        { text: 'Proxy đang chết hoặc hết hạn — kiểm tra/gia hạn với nhà cung cấp, hoặc gán proxy khác.', href: '/admin/proxies', label: 'Mở Proxy Pool' },
        { text: 'Sau khi đổi proxy, đặt lại phiên để bot chọn proxy mới.', action: 'reset_proxy_session' },
      ];
    case 'PROXY_TLS_FAIL':
      return [
        { text: 'Proxy không mở được kết nối tới GDT (IP bị chặn ở tầng mạng hoặc sai user/pass proxy). Chạy "Kiểm tra GDT" trong Proxy Pool và thay proxy lỗi.', href: '/admin/proxies', label: 'Mở Proxy Pool' },
        { text: 'Đặt lại phiên proxy sau khi thay.', action: 'reset_proxy_session' },
      ];
    case 'GDT_WAF_BLOCK':
      return [
        { text: 'GDT vẫn chặn dù bot gửi đủ header như trình duyệt → IP proxy đã bị gắn cờ. Gán proxy khác (khác dải IP) cho chủ công ty.', href: '/admin/proxies', label: 'Mở Proxy Pool' },
        { text: 'Đặt lại phiên proxy và xoá token cũ.', action: 'reset_proxy_session' },
        { text: 'Nếu mọi proxy đều bị chặn: GDT có thể vừa đổi cơ chế chống bot — xem chi tiết mốc "Lớp chống bot" và báo đội phát triển.' },
      ];
    case 'CREDENTIALS_REJECTED':
      return [
        { text: 'Chủ công ty cần cập nhật đúng mật khẩu GDT (thử đăng nhập tay trên hoadondientu.gdt.gov.vn trước).', href: '/settings/bot', label: 'Mở cài đặt bot' },
        { text: 'Sau khi cập nhật mật khẩu, bật lại bot.', action: 'reactivate_bot' },
      ];
    case 'GDT_RATE_LIMIT':
      return [
        { text: 'Proxy này đang bị GDT giới hạn tần suất. Đợi 15–30 phút hoặc chuyển sang proxy khác.', action: 'reset_proxy_session' },
      ];
    case 'GDT_SERVER_ERROR':
      return [{ text: 'Cổng GDT đang lỗi/quá tải (thường vào ngày 18–25). Không cần sửa gì phía hệ thống — chẩn đoán lại sau.', rerun: true }];
    case 'GDT_CAPTCHA_API_FAIL':
      return [{ text: 'API của GDT trả dữ liệu khác thường — có thể GDT vừa đổi giao diện/API. Chuyển chi tiết các mốc cho đội phát triển.' }];
    case 'FETCH_FAIL':
      return [
        { text: 'Đăng nhập được nhưng không kéo được hoá đơn. Nếu lỗi 401: proxy đang xoay IP giữa các request — dùng proxy IP tĩnh.', href: '/admin/proxies', label: 'Mở Proxy Pool' },
        { text: 'Nếu GDT đổi cấu trúc dữ liệu: chuyển chi tiết cho đội phát triển.' },
      ];
    case 'NETWORK_ERROR':
    default:
      return [{ text: 'Lỗi mạng tạm thời giữa proxy và GDT. Chẩn đoán lại; nếu lặp lại, đổi proxy.', rerun: true }];
  }
}

function warningRemedies(r: DiagnoseResult): Remedy[] {
  const out: Remedy[] = [];
  if (r.warnings.includes('BOT_INACTIVE') && r.verdict.code === 'ALL_OK') {
    out.push({ text: 'Bot của công ty đang tắt (thường do trước đó GDT báo sai tài khoản). Tài khoản hiện đăng nhập được.', action: 'reactivate_bot' });
  }
  if (r.warnings.includes('BLOCKED')) {
    out.push({ text: `Công ty đang bị tự khoá sau ${r.state?.consecutiveFailures ?? '?'} lần lỗi liên tiếp — auto-sync bỏ qua tới khi hết hạn.`, action: 'clear_block' });
  }
  if (r.warnings.includes('GLOBAL_PAUSED')) {
    out.push({ text: 'Auto-sync toàn hệ thống đang tạm dừng — không công ty nào tự đồng bộ.', action: 'resume_auto_sync' });
  }
  return out;
}

/* ── UI helpers ──────────────────────────────────────────────────────────────── */

const STATUS_STYLE: Record<StepStatus, { dot: string; text: string; label: string }> = {
  ok:      { dot: 'bg-green-500',              text: 'text-green-700', label: 'OK' },
  warn:    { dot: 'bg-amber-500',              text: 'text-amber-700', label: 'Cảnh báo' },
  fail:    { dot: 'bg-red-500',                text: 'text-red-700',   label: 'Lỗi' },
  skip:    { dot: 'bg-gray-300',               text: 'text-gray-500',  label: 'Bỏ qua' },
  running: { dot: 'bg-indigo-500 animate-pulse', text: 'text-indigo-700', label: 'Đang chạy' },
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function errorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
  return e.response?.data?.error?.message ?? e.message ?? 'Lỗi không xác định';
}

/* ── Page ────────────────────────────────────────────────────────────────────── */

export default function GdtDiagnosePage() {
  const [companies, setCompanies]       = useState<CompanyRow[]>([]);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [loadingList, setLoadingList]   = useState(true);
  const [query, setQuery]               = useState('');
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [run, setRun]                   = useState<RunStatus | null>(null);
  const [starting, setStarting]         = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [fixBusy, setFixBusy]           = useState<FixAction | null>(null);
  const [fixMsg, setFixMsg]             = useState<string | null>(null);
  const [expanded, setExpanded]         = useState<Record<string, boolean>>({});
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadCompanies = useCallback(() => {
    setLoadingList(true);
    apiClient.get<{ data: { globalPaused: boolean; companies: CompanyRow[] } }>('/admin/gdt-diagnose/companies')
      .then(r => { setCompanies(r.data.data.companies); setGlobalPaused(r.data.data.globalPaused); })
      .catch(e => setError(errorMessage(e)))
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => { loadCompanies(); }, [loadCompanies]);
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(c =>
      c.name?.toLowerCase().includes(q) || c.tax_code?.includes(q) || c.owner_email?.toLowerCase().includes(q));
  }, [companies, query]);

  const selected = companies.find(c => c.company_id === selectedId) ?? null;

  const poll = useCallback((jobId: string) => {
    apiClient.get<{ data: RunStatus }>(`/admin/gdt-diagnose/run/${jobId}`)
      .then(r => {
        const s = r.data.data;
        setRun(s);
        if (s.state !== 'completed' && s.state !== 'failed') {
          pollRef.current = setTimeout(() => poll(jobId), 1500);
        } else {
          loadCompanies();
        }
      })
      .catch(e => setError(errorMessage(e)));
  }, [loadCompanies]);

  const startDiagnose = async () => {
    if (!selectedId) return;
    if (pollRef.current) clearTimeout(pollRef.current);
    setError(null); setFixMsg(null); setRun(null); setExpanded({});
    setStarting(true);
    try {
      const r = await apiClient.post<{ data: { jobId: string } }>('/admin/gdt-diagnose/run', { companyId: selectedId });
      poll(r.data.data.jobId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const applyFix = async (action: FixAction) => {
    setFixBusy(action); setFixMsg(null); setError(null);
    try {
      const r = await apiClient.post<{ data: { message: string } }>('/admin/gdt-diagnose/fix', {
        action, ...(action === 'resume_auto_sync' ? {} : { companyId: selectedId }),
      });
      setFixMsg(r.data.data.message);
      loadCompanies();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setFixBusy(null);
    }
  };

  const running = !!run && run.state !== 'completed' && run.state !== 'failed';
  const steps   = run?.result?.steps ?? run?.steps ?? [];
  const result  = run?.result ?? null;
  const remedies = result ? [...remediesFor(result.verdict.code), ...warningRemedies(result)] : [];

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Chẩn đoán GDT</h1>
        <p className="text-sm text-gray-500 mt-1">
          Chạy lại từng mốc của luồng đồng bộ thật (cấu hình → proxy → captcha → đăng nhập → kéo hoá đơn) để tìm đúng chỗ hỏng.
          Mọi request tới GDT đều đi qua proxy của chủ công ty. Hệ thống tự chẩn đoán mỗi ngày một lần trong giờ hành chính
          (từ 9h) và báo lỗi cho người dùng ngay trên trang chủ.
        </p>
      </div>

      {globalPaused && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm text-amber-800">Auto-sync toàn hệ thống đang <b>tạm dừng</b> — bot chỉ chạy khi người dùng bấm đồng bộ tay.</p>
          <button
            onClick={() => applyFix('resume_auto_sync')}
            disabled={fixBusy !== null}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {fixBusy === 'resume_auto_sync' ? 'Đang bật…' : 'Bật lại auto-sync'}
          </button>
        </div>
      )}

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {fixMsg && <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{fixMsg}</div>}

      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ── Chọn công ty ─────────────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 p-3">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Tìm theo tên, MST, email chủ…"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <ul className="max-h-[520px] overflow-auto divide-y divide-gray-100">
            {loadingList && <li className="p-4 text-sm text-gray-500">Đang tải…</li>}
            {!loadingList && filtered.length === 0 && <li className="p-4 text-sm text-gray-500">Không có công ty nào cấu hình bot.</li>}
            {filtered.map(c => {
              const blocked = c.blocked_until && new Date(c.blocked_until) > new Date();
              return (
                <li key={c.company_id}>
                  <button
                    onClick={() => { setSelectedId(c.company_id); setRun(null); setFixMsg(null); }}
                    className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 ${selectedId === c.company_id ? 'bg-indigo-50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-gray-900">{c.name}</span>
                      {!c.is_active
                        ? <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">Tắt</span>
                        : blocked
                          ? <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">Tự khoá</span>
                          : c.last_run_status === 'error'
                            ? <span className="shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[11px] text-red-700">Lỗi</span>
                            : c.last_run_status === 'success'
                              ? <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700">OK</span>
                              : null}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-gray-500">
                      {c.tax_code ?? '—'} · {c.owner_email ?? 'không có chủ'}
                    </div>
                    {c.last_error && <div className="mt-0.5 truncate text-xs text-red-600" title={c.last_error}>{c.last_error}</div>}
                    {c.check_at && (
                      <div className={`mt-0.5 truncate text-xs ${c.check_ok ? 'text-green-700' : 'text-red-600'}`} title={c.check_title ?? ''}>
                        {c.check_ok ? '✓' : '✗'} Chẩn đoán {c.check_source === 'daily' ? 'hằng ngày' : 'tay'} {fmtTime(c.check_at)}
                        {!c.check_ok && c.check_code ? ` · ${c.check_code}` : ''}
                      </div>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* ── Kết quả ──────────────────────────────────────────────────── */}
        <section className="space-y-4 min-w-0">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            {selected ? (
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-gray-900">{selected.name}</h2>
                  <p className="text-xs text-gray-500">
                    MST {selected.tax_code ?? '—'} · Lần chạy cuối {fmtTime(selected.last_run_at)} ({selected.last_run_status ?? '—'})
                    {selected.consecutive_failures > 0 && ` · ${selected.consecutive_failures} lỗi liên tiếp`}
                  </p>
                </div>
                <button
                  onClick={startDiagnose}
                  disabled={starting || running}
                  className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {starting || running ? 'Đang chẩn đoán…' : run ? 'Chẩn đoán lại' : 'Chẩn đoán'}
                </button>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Chọn một công ty bên trái để bắt đầu chẩn đoán.</p>
            )}
            {run?.state === 'waiting' && (
              <p className="mt-3 text-xs text-gray-500">Đang chờ bot nhận việc… Nếu chờ quá 30 giây, kiểm tra process invone-bot có đang chạy.</p>
            )}
            {run?.state === 'failed' && (
              <p className="mt-3 text-sm text-red-600">Bot lỗi khi chẩn đoán: {run.failedReason}</p>
            )}
          </div>

          {result && (
            <div className={`rounded-xl border p-4 ${result.verdict.code === 'ALL_OK' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
              <p className={`text-xs font-semibold uppercase tracking-wide ${result.verdict.code === 'ALL_OK' ? 'text-green-700' : 'text-red-700'}`}>
                {result.verdict.code === 'ALL_OK' ? 'Kết luận' : 'Nguyên nhân'} · {result.verdict.code}
              </p>
              <p className="mt-1 text-base font-semibold text-gray-900">{result.verdict.title}</p>
              {result.verdict.detail && <p className="mt-1 text-sm text-gray-700 break-words">{result.verdict.detail}</p>}

              {remedies.length > 0 && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">Hướng khắc phục</p>
                  {remedies.map((r, i) => (
                    <div key={i} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2.5 border border-gray-200">
                      <p className="min-w-0 flex-1 text-sm text-gray-700">{r.text}</p>
                      <div className="flex shrink-0 gap-2">
                        {r.action && (
                          <button
                            onClick={() => applyFix(r.action!)}
                            disabled={fixBusy !== null}
                            className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                          >
                            {fixBusy === r.action ? 'Đang xử lý…' : (r.label ?? FIX_LABEL[r.action])}
                          </button>
                        )}
                        {r.href && (
                          <Link href={r.href} className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                            {r.label ?? 'Mở'}
                          </Link>
                        )}
                        {r.rerun && (
                          <button
                            onClick={startDiagnose}
                            disabled={running}
                            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Chẩn đoán lại
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {steps.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-gray-900">Các mốc kiểm tra</h3>
                {result && (
                  <span className="text-xs text-gray-500">
                    {Math.round((new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()) / 1000)} giây
                  </span>
                )}
              </div>
              <ol className="divide-y divide-gray-100">
                {steps.map((s, i) => {
                  const st = STATUS_STYLE[s.status] ?? STATUS_STYLE.skip;
                  const open = expanded[s.key];
                  return (
                    <li key={s.key} className="px-4 py-3">
                      <div className="flex items-start gap-3">
                        <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                            <p className="text-sm font-medium text-gray-900">{i + 1}. {s.title}</p>
                            <p className={`text-xs ${st.text}`}>
                              {st.label}{typeof s.ms === 'number' && s.status !== 'running' ? ` · ${(s.ms / 1000).toFixed(1)}s` : ''}
                            </p>
                          </div>
                          {s.detail && <p className="mt-0.5 text-sm text-gray-600 break-words">{s.detail}</p>}
                          {s.data && (
                            <button
                              onClick={() => setExpanded(x => ({ ...x, [s.key]: !x[s.key] }))}
                              className="mt-1 text-xs text-indigo-600 hover:underline"
                            >
                              {open ? 'Ẩn dữ liệu thô' : 'Xem dữ liệu thô'}
                            </button>
                          )}
                          {open && s.data && (
                            <pre className="mt-2 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-700">{JSON.stringify(s.data, null, 2)}</pre>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
