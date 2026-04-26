'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '../../../../lib/apiClient';
import BackButton from '../../../../components/BackButton';
import SyncProgressPanel from '../../../../components/SyncProgressPanel';
import { useToast } from '../../../../components/ToastProvider';
import { useCompany } from '../../../../contexts/CompanyContext';
import { useSyncContext } from '../../../../contexts/SyncContext';

interface BotConfig {
  id: string;
  company_id: string;
  tax_code: string;
  has_otp: boolean;
  otp_method: string | null;
  is_active: boolean;
  sync_frequency_hours: number;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_output_count: number;
  last_run_input_count: number;
  last_error: string | null;
  blocked_until: string | null;
}

interface BotRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  output_count: number;
  input_count: number;
  duration_ms: number | null;
  error_detail: string | null;
}

interface BotStatus {
  config: BotConfig | null;
  lastRuns: BotRun[];
  manualCooldownSec: number;
  quickSyncCooldownSec: number;
  quotaInfo: { quota_used: number; quota_total: number; quota_reset_at: string | null } | null;
  proxyAssigned: boolean;
}

interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const HISTORY_PAGE_SIZE = 5;
const ACTIVE_RUN_STATUSES = new Set(['pending', 'delayed', 'running']);

const STATUS_META: Record<string, { label: string; dot: string; pill: string }> = {
  idle: {
    label: 'Chưa chạy',
    dot: 'bg-slate-400',
    pill: 'bg-slate-100 text-slate-700',
  },
  success: {
    label: 'Hoạt động ổn định',
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-100 text-emerald-700',
  },
  error: {
    label: 'Cần xử lý',
    dot: 'bg-rose-500',
    pill: 'bg-rose-100 text-rose-700',
  },
  otp_required: {
    label: 'Chờ OTP',
    dot: 'bg-amber-500',
    pill: 'bg-amber-100 text-amber-700',
  },
  blocked: {
    label: 'Tạm khóa',
    dot: 'bg-orange-500',
    pill: 'bg-orange-100 text-orange-700',
  },
  pending: {
    label: 'Đang xếp hàng',
    dot: 'bg-sky-500',
    pill: 'bg-sky-100 text-sky-700',
  },
  delayed: {
    label: 'Đã lên lịch',
    dot: 'bg-indigo-500',
    pill: 'bg-indigo-100 text-indigo-700',
  },
  running: {
    label: 'Đang xử lý',
    dot: 'bg-blue-500',
    pill: 'bg-blue-100 text-blue-700',
  },
  cancelled: {
    label: 'Đã hủy',
    dot: 'bg-slate-500',
    pill: 'bg-slate-100 text-slate-700',
  },
  skipped: {
    label: 'Đã bỏ qua',
    dot: 'bg-slate-400',
    pill: 'bg-slate-100 text-slate-700',
  },
};

function toLocalDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Chưa có';
  return new Date(value).toLocaleString('vi-VN');
}

function humanizeBotError(message: string | null): string {
  if (!message) return 'Không có lỗi hiển thị';
  const normalized = message.toLowerCase();
  if (normalized.includes('worker đang offline') || normalized.includes('worker offline')) {
    return 'BOT worker đang tắt hoặc vừa restart. Phiên treo đã được đóng, bạn có thể chạy lại khi worker sẵn sàng.';
  }
  if (normalized.includes('missing key for job')) {
    return 'Không đọc được tiến trình từ worker gần nhất. Hãy kiểm tra worker BOT rồi chạy lại.';
  }
  if (normalized.includes('already_running') || normalized.includes('already running')) {
    return 'Một phiên đồng bộ khác đang chạy. Chờ BOT hoàn tất rồi thử lại.';
  }
  if (normalized.includes('no_proxy_assigned')) {
    return 'Tài khoản chưa được gán IP tĩnh nên không thể chạy đồng bộ.';
  }
  if (normalized.includes('deadline_exceeded')) {
    return 'BOT vượt quá thời gian xử lý dự kiến và đã tự dừng để bảo toàn hàng đợi.';
  }
  return message;
}

function getCurrentMonthWindow(): { from: string; to: string; month: string } {
  const now = new Date();
  return {
    from: toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: toLocalDateStr(now),
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  };
}

function getTodayWindow(): { from: string; to: string } {
  const now = new Date();
  return {
    from: toLocalDateStr(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    to: toLocalDateStr(now),
  };
}

function MetricTile(props: {
  label: string;
  value: string;
  hint: string;
  tone?: 'neutral' | 'blue' | 'green' | 'amber';
}) {
  const toneClass = {
    neutral: 'border-slate-200 bg-slate-50 text-slate-900',
    blue: 'border-blue-200 bg-blue-50 text-slate-900',
    green: 'border-emerald-200 bg-emerald-50 text-slate-900',
    amber: 'border-amber-200 bg-amber-50 text-slate-900',
  }[props.tone ?? 'neutral'];

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">{props.label}</p>
      <p className="mt-3 text-3xl font-semibold leading-none">{props.value}</p>
      <p className="mt-2 text-sm text-slate-500">{props.hint}</p>
    </div>
  );
}

function NoticeCard(props: { tone: NoticeTone; title: string; body: string }) {
  const toneClass = {
    info: 'border-blue-200 bg-blue-50 text-blue-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-rose-200 bg-rose-50 text-rose-900',
  }[props.tone];

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <p className="text-sm font-semibold">{props.title}</p>
      <p className="mt-1 text-sm leading-6 opacity-90">{props.body}</p>
    </div>
  );
}

export default function BotSettingsPage() {
  const toast = useToast();
  const router = useRouter();
  const { activeCompany } = useCompany();
  const { syncJobIds, syncCompanyId, startSync, clearSync } = useSyncContext();

  const isAdmin = activeCompany?.role === 'OWNER' || activeCompany?.role === 'ADMIN';
  const activeCompanyId = activeCompany?.id ?? '';

  const [status, setStatus] = useState<BotStatus | null>(null);
  const [historyRuns, setHistoryRuns] = useState<BotRun[]>([]);
  const [historyMeta, setHistoryMeta] = useState<PaginationMeta>({
    total: 0,
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
    totalPages: 1,
  });
  const [importTotal, setImportTotal] = useState<number | null>(null);
  const [importSessionCount, setImportSessionCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [showOtp, setShowOtp] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [otp, setOtp] = useState('');
  const [dateError, setDateError] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [runFrom, setRunFrom] = useState('');
  const [runTo, setRunTo] = useState('');
  const [isSubmittingRun, setIsSubmittingRun] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [acceptPasswordStorage, setAcceptPasswordStorage] = useState(false);
  const hydratedRunIdRef = useRef<string | null>(null);
  const [form, setForm] = useState({
    password: '',
    has_otp: false,
    otp_method: 'sms' as 'sms' | 'email' | 'app',
    sync_frequency_hours: 6,
  });

  const load = useCallback(async () => {
    try {
      const [botRes, importRes] = await Promise.all([
        apiClient.get<{ data: BotStatus }>('/bot/status'),
        apiClient
          .get<{ data: { session_count: number; total_invoices: number } }>('/import/stats')
          .catch(() => null),
      ]);

      const botData = botRes.data.data;
      setStatus(botData);
      if (importRes) {
        setImportTotal(importRes.data.data?.total_invoices ?? 0);
        setImportSessionCount(importRes.data.data?.session_count ?? 0);
      }
    } catch {
      // Keep page shell visible even when background status fetch fails.
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (page = 1) => {
    setHistoryLoading(true);
    try {
      const res = await apiClient.get<{ data: BotRun[]; meta: PaginationMeta }>('/bot/runs', {
        params: { page, pageSize: HISTORY_PAGE_SIZE },
      });
      setHistoryRuns(res.data.data ?? []);
      setHistoryMeta(res.data.meta ?? { total: 0, page, pageSize: HISTORY_PAGE_SIZE, totalPages: 1 });
    } catch {
      setHistoryRuns([]);
      setHistoryMeta({ total: 0, page, pageSize: HISTORY_PAGE_SIZE, totalPages: 1 });
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    setStatus(null);
    setHistoryRuns([]);
    setHistoryMeta({ total: 0, page: 1, pageSize: HISTORY_PAGE_SIZE, totalPages: 1 });
    setImportTotal(null);
    setLoading(true);
    setHistoryLoading(true);
    setShowSetup(false);
    setShowOtp(false);
    setShowDatePicker(false);
    hydratedRunIdRef.current = null;
  }, [activeCompanyId]);

  useEffect(() => {
    void load();
    void loadHistory(1);
  }, [load, loadHistory, activeCompanyId]);

  const cfg = status?.config ?? null;
  const latestRun = status?.lastRuns?.[0] ?? null;
  const lastStatus = latestRun?.status ?? cfg?.last_run_status ?? 'idle';
  const statusMeta = STATUS_META[lastStatus] ?? STATUS_META.idle;
  const pageSyncActive = syncJobIds.length > 0 && syncCompanyId === activeCompanyId;
  const isBotBusy = pageSyncActive || ACTIVE_RUN_STATUSES.has(lastStatus) || isSubmittingRun;
  const proxyReady = status?.proxyAssigned ?? true;
  const controlsDisabled = isBotBusy || !proxyReady || isSavingConfig;

  const handleSyncPanelClose = useCallback(() => {
    clearSync();
    void load();
    void loadHistory(historyMeta.page);
  }, [clearSync, historyMeta.page, load, loadHistory]);

  const handleSyncPanelDone = useCallback(() => {
    clearSync();
    void load();
    void loadHistory(1);
  }, [clearSync, load, loadHistory]);

  useEffect(() => {
    if (syncJobIds.length === 0) return;
    hydratedRunIdRef.current = syncJobIds[0] ?? hydratedRunIdRef.current;
  }, [syncJobIds]);

  useEffect(() => {
    if (!activeCompanyId) return;
    if (syncJobIds.length > 0) return;
    if (!latestRun || !ACTIVE_RUN_STATUSES.has(latestRun.status)) return;
    if (hydratedRunIdRef.current === latestRun.id) return;

    hydratedRunIdRef.current = latestRun.id;
    startSync([latestRun.id], activeCompanyId);
  }, [activeCompanyId, latestRun, startSync, syncJobIds.length]);

  useEffect(() => {
    if (!pageSyncActive || syncCompanyId !== activeCompanyId) return;

    const activeJobId = syncJobIds[0];
    if (!activeJobId) return;

    const trackedRun = status?.lastRuns?.find(run => run.id === activeJobId) ?? historyRuns.find(run => run.id === activeJobId);
    if (!trackedRun || ACTIVE_RUN_STATUSES.has(trackedRun.status)) return;

    hydratedRunIdRef.current = activeJobId;
    clearSync();
  }, [activeCompanyId, clearSync, historyRuns, pageSyncActive, status?.lastRuns, syncCompanyId, syncJobIds]);

  useEffect(() => {
    if (!cfg && !pageSyncActive) return;
    if (ACTIVE_RUN_STATUSES.has(lastStatus) || pageSyncActive) {
      const interval = setInterval(() => {
        void load();
        if (historyMeta.page === 1) {
          void loadHistory(1);
        }
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [cfg, historyMeta.page, lastStatus, load, loadHistory, pageSyncActive]);

  const notices = useMemo(() => {
    const items: Array<{ tone: NoticeTone; title: string; body: string }> = [];
    if (!proxyReady) {
      items.push({
        tone: 'danger',
        title: 'Chưa được cấp IP tĩnh',
        body: 'Tài khoản này chưa được Admin gán static proxy nên toàn bộ thao tác đồng bộ GDT sẽ bị khóa.',
      });
    }

    if (cfg?.blocked_until && new Date(cfg.blocked_until) > new Date()) {
      items.push({
        tone: 'warning',
        title: 'BOT đang bị tạm khóa',
        body: `Hệ thống sẽ mở lại sau ${formatDateTime(cfg.blocked_until)}. Trong lúc này chỉ nên kiểm tra log và tránh gửi thêm yêu cầu.`,
      });
    }

    const quota = status?.quotaInfo;
    if (quota && quota.quota_total > 0) {
      const ratio = quota.quota_used / quota.quota_total;
      if (ratio >= 0.8) {
        items.push({
          tone: ratio >= 0.95 ? 'danger' : 'warning',
          title: ratio >= 0.95 ? 'Hạn mức gần cạn' : 'Hạn mức sắp hết',
          body: `Đã dùng ${quota.quota_used.toLocaleString('vi-VN')}/${quota.quota_total.toLocaleString('vi-VN')} hóa đơn.${quota.quota_reset_at ? ` Reset vào ${new Date(quota.quota_reset_at).toLocaleDateString('vi-VN')}.` : ''}`,
        });
      }
    }

    if (cfg?.last_error && lastStatus !== 'running') {
      items.push({
        tone: 'danger',
        title: 'Lỗi gần nhất',
        body: humanizeBotError(cfg.last_error),
      });
    }

    if (pageSyncActive) {
      items.push({
        tone: 'info',
        title: 'BOT đang xử lý',
        body: 'Process board đang theo dõi tiến độ theo thời gian thực. Trong lúc này toàn bộ nút thao tác sẽ bị khóa để tránh chồng job.',
      });
    } else if (lastStatus === 'delayed') {
      items.push({
        tone: 'info',
        title: 'Phiên này đang lên lịch',
        body: 'Công ty này đang chờ một phiên manual sync khác của cùng tài khoản hoàn tất. Khi phiên trước xong, BOT sẽ tự bắt đầu ngay.',
      });
    }

    return items;
  }, [cfg, lastStatus, pageSyncActive, proxyReady, status?.quotaInfo]);

  const openSetupModal = () => {
    setAcceptPasswordStorage(false);
    setShowSetup(true);
  };

  const saveConfig = async () => {
    if (!acceptPasswordStorage || !form.password || isBotBusy) return;
    setIsSavingConfig(true);
    try {
      await apiClient.post('/bot/setup', form);
      toast.success('Đã lưu cấu hình GDT. BOT sẵn sàng đồng bộ.');
      setShowSetup(false);
      setAcceptPasswordStorage(false);
      setForm(prev => ({ ...prev, password: '' }));
      await load();
    } catch (err: unknown) {
      const apiErr = (err as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error;
      toast.error(apiErr?.message ?? 'Không thể lưu cấu hình GDT');
    } finally {
      setIsSavingConfig(false);
    }
  };

  const queueSync = async (params: {
    fromDate?: string;
    toDate?: string;
    successMessage: string;
  }) => {
    if (!cfg || !isAdmin || controlsDisabled) return;

    const quota = status?.quotaInfo;
    if (quota && quota.quota_total > 0) {
      const ratio = quota.quota_used / quota.quota_total;
      if (ratio >= 0.8) {
        const remaining = quota.quota_total - quota.quota_used;
        const confirmed = confirm(
          `Bạn đã dùng ${quota.quota_used.toLocaleString('vi-VN')}/${quota.quota_total.toLocaleString('vi-VN')} hóa đơn.\nCòn lại ${remaining.toLocaleString('vi-VN')} hóa đơn.\n\nTiếp tục đồng bộ?`,
        );
        if (!confirmed) return;
      }
    }

    setIsSubmittingRun(true);
    try {
      const body: Record<string, string> = {};
      if (params.fromDate) body['from_date'] = params.fromDate;
      if (params.toDate) body['to_date'] = params.toDate;

      const res = await apiClient.post<{
        data: { jobId?: string; delayed_sec?: number; estimated_start?: string | null; runStatus?: string };
      }>('/bot/run-now', body);

      const jobId = res.data.data.jobId;
      const runStatus = res.data.data.runStatus;
      const shouldTrackHere = runStatus !== 'delayed' || syncJobIds.length === 0 || syncCompanyId === activeCompanyId;
      if (jobId && activeCompanyId && shouldTrackHere) {
        hydratedRunIdRef.current = jobId;
        startSync([jobId], activeCompanyId);
      }
      setShowDatePicker(false);
      setHistoryMeta(prev => ({ ...prev, page: 1 }));

      if (runStatus === 'delayed') {
        toast.success('Đã lên lịch phiên đồng bộ này sau công ty đang chạy trước đó.');
      } else {
        toast.success(params.successMessage);
      }
      await load();
      await loadHistory(1);
    } catch (err: unknown) {
      const apiErr = (err as { response?: { data?: { error?: { code?: string; message?: string; waitMinutes?: number } } } }).response?.data?.error;
      if (apiErr?.code === 'ALREADY_RUNNING') {
        toast.error('BOT đang chạy một phiên đồng bộ khác.');
        void load();
      } else if (apiErr?.code === 'NO_PROXY_ASSIGNED') {
        toast.error(apiErr.message ?? 'Tài khoản chưa được cấp IP tĩnh.');
      } else {
        toast.error(apiErr?.message ?? 'Không thể khởi chạy đồng bộ GDT');
      }
    } finally {
      setIsSubmittingRun(false);
    }
  };

  const runCurrentMonthSync = () => {
    const currentMonth = getCurrentMonthWindow();
    void queueSync({
      fromDate: currentMonth.from,
      toDate: currentMonth.to,
      successMessage: 'Đã bắt đầu đồng bộ tháng hiện tại.',
    });
  };

  const runTodaySync = () => {
    const today = getTodayWindow();
    void queueSync({
      fromDate: today.from,
      toDate: today.to,
      successMessage: 'Đã bắt đầu đồng bộ dữ liệu mới nhất.',
    });
  };

  const openDateRangePicker = () => {
    const currentMonth = getCurrentMonthWindow();
    setSelectedMonth(currentMonth.month);
    setRunFrom(currentMonth.from);
    setRunTo(currentMonth.to);
    setDateError('');
    setShowDatePicker(true);
  };

  const handleMonthSelect = (value: string) => {
    setSelectedMonth(value);
    setDateError('');
    if (!value) return;
    const [year, month] = value.split('-').map(Number);
    const firstDay = toLocalDateStr(new Date(year, month - 1, 1));
    const lastDay = toLocalDateStr(new Date(year, month, 0));
    const today = toLocalDateStr(new Date());
    setRunFrom(firstDay);
    setRunTo(lastDay > today ? today : lastDay);
  };

  const validateAndSetFrom = (value: string) => {
    setRunFrom(value);
    setSelectedMonth('');
    setDateError('');
    if (!value) return;
    const date = new Date(`${value}T00:00:00`);
    const endOfMonth = toLocalDateStr(new Date(date.getFullYear(), date.getMonth() + 1, 0));
    const today = toLocalDateStr(new Date());
    setRunTo(endOfMonth > today ? today : endOfMonth);
  };

  const validateAndSetTo = (value: string) => {
    setRunTo(value);
    setDateError('');
    if (!value || !runFrom) return;
    const diffMs = new Date(`${value}T00:00:00`).getTime() - new Date(`${runFrom}T00:00:00`).getTime();
    if (diffMs < 0) {
      setDateError('Đến ngày phải lớn hơn hoặc bằng Từ ngày.');
      return;
    }
    if (diffMs > 31 * 24 * 60 * 60 * 1000) {
      const capped = new Date(new Date(`${value}T00:00:00`).getTime() - 31 * 24 * 60 * 60 * 1000);
      setRunFrom(toLocalDateStr(capped));
    }
  };

  const submitOtp = async () => {
    if (otp.length < 6) return;
    try {
      await apiClient.post('/bot/submit-otp', { otp });
      toast.success('Đã gửi OTP. BOT sẽ tiếp tục phiên đang chờ.');
      setShowOtp(false);
      setOtp('');
      await load();
    } catch {
      toast.error('OTP không hợp lệ hoặc đã hết hạn.');
    }
  };

  const deleteConfig = async () => {
    if (!cfg || isBotBusy) return;
    const confirmed = confirm('Xóa cấu hình GDT BOT? Dữ liệu hóa đơn đã đồng bộ sẽ không bị xóa.');
    if (!confirmed) return;

    try {
      await apiClient.delete('/bot/config');
      clearSync();
      toast.success('Đã xóa cấu hình GDT.');
      await load();
    } catch {
      toast.error('Không thể xóa cấu hình GDT.');
    }
  };

  const configSummary = useMemo(() => {
    if (!cfg) return [];
    return [
      { label: 'MST', value: cfg.tax_code },
      { label: 'Tần suất', value: cfg.sync_frequency_hours > 0 ? `${cfg.sync_frequency_hours} giờ/lần` : 'Thủ công' },
      { label: 'OTP', value: cfg.has_otp ? `Có (${cfg.otp_method ?? 'OTP'})` : 'Không' },
      { label: 'Proxy', value: proxyReady ? 'Sẵn sàng' : 'Chưa có' },
    ];
  }, [cfg, proxyReady]);

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 pb-24">
      <BackButton fallbackHref="/settings/connectors" />

      <section className="overflow-hidden rounded-[28px] border border-gray-200 bg-white shadow-sm">
        <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-blue-950 px-6 py-6 text-white">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <span className="inline-flex w-fit rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-white/80">
                Settings / GDT Crawl
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Điều khiển GDT Crawl</h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-sm font-medium text-white">
                <span className={`h-2.5 w-2.5 rounded-full ${statusMeta.dot}`} />
                {statusMeta.label}
              </span>
              {cfg && (
                <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/85">
                  MST {cfg.tax_code}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6 p-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              label="HĐ đầu ra"
              value={(cfg?.last_run_output_count ?? 0).toLocaleString('vi-VN')}
              hint="Kết quả lần chạy gần nhất"
              tone="blue"
            />
            <MetricTile
              label="HĐ đầu vào"
              value={(cfg?.last_run_input_count ?? 0).toLocaleString('vi-VN')}
              hint="Kết quả lần chạy gần nhất"
              tone="green"
            />
            <MetricTile
              label="Tần suất"
              value={cfg ? (cfg.sync_frequency_hours > 0 ? `${cfg.sync_frequency_hours}h` : 'Manual') : '--'}
              hint={cfg ? 'Chu kỳ đang áp dụng' : 'Chưa cấu hình'}
              tone="amber"
            />
            <MetricTile
              label="Lần chạy cuối"
              value={cfg?.last_run_at ? new Date(cfg.last_run_at).toLocaleDateString('vi-VN') : '--'}
              hint={cfg?.last_run_at ? formatDateTime(cfg.last_run_at) : 'Chưa có lịch sử'}
            />
          </div>

          {pageSyncActive && activeCompanyId && (
            <div className="rounded-3xl border border-blue-200 bg-blue-50/80 p-4">
              <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Process Board</p>
                  <p className="text-sm text-slate-500">
                    Tiến trình đang hiển thị theo thời gian thực. Khi BOT chạy, toàn bộ thao tác trên trang sẽ bị khóa.
                  </p>
                </div>
                <span className="inline-flex w-fit rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-blue-700">
                  Live
                </span>
              </div>
              <SyncProgressPanel jobIds={syncJobIds} companyId={activeCompanyId} onClose={handleSyncPanelClose} onDone={handleSyncPanelDone} />
            </div>
          )}

          {notices.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {notices.map(notice => (
                <NoticeCard key={`${notice.title}-${notice.body}`} tone={notice.tone} title={notice.title} body={notice.body} />
              ))}
            </div>
          )}

          <div className="grid gap-6 xl:grid-cols-[1.25fr_0.85fr]">
            <div className="rounded-3xl border border-slate-200 bg-slate-50/70 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">GDT Crawl</p>
                  <h2 className="mt-2 text-xl font-semibold text-slate-950">Điều khiển đồng bộ</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                    Tách riêng khối lấy dữ liệu GDT để thao tác chạy, sửa cấu hình, OTP và kiểm soát lỗi gọn hơn.
                  </p>
                </div>

                {cfg && (
                  <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
                    {configSummary.map(item => (
                      <div key={item.label} className="rounded-2xl border border-white bg-white px-3 py-2">
                        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">{item.label}</p>
                        <p className="mt-1 font-medium text-slate-800">{item.value}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {!cfg ? (
                <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-white p-6 text-center">
                  <p className="text-sm font-semibold text-slate-900">Chưa có cấu hình GDT cho công ty này</p>
                  <p className="mt-2 text-sm text-slate-500">
                    Lưu mật khẩu GDT đã mã hóa để BOT có thể tự kết nối và đồng bộ hóa đơn.
                  </p>
                  {isAdmin ? (
                    <button
                      onClick={openSetupModal}
                      className="mt-4 inline-flex items-center justify-center rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
                    >
                      Thiết lập GDT
                    </button>
                  ) : (
                    <p className="mt-4 text-xs text-slate-400">Chỉ OWNER/ADMIN mới có thể thiết lập BOT.</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="mt-6 flex flex-wrap gap-2">
                    <button
                      onClick={runCurrentMonthSync}
                      disabled={!isAdmin || controlsDisabled}
                      className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      Lấy từ GDT
                    </button>
                    <button
                      onClick={runTodaySync}
                      disabled={!isAdmin || controlsDisabled}
                      className="inline-flex items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Hôm nay
                    </button>
                    <button
                      onClick={openDateRangePicker}
                      disabled={!isAdmin || controlsDisabled}
                      className="inline-flex items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Chọn kỳ
                    </button>
                    <button
                      onClick={openSetupModal}
                      disabled={!isAdmin || isBotBusy}
                      className="inline-flex items-center justify-center rounded-2xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Sửa
                    </button>
                    <button
                      onClick={deleteConfig}
                      disabled={!isAdmin || isBotBusy}
                      className="inline-flex items-center justify-center rounded-2xl border border-rose-200 bg-white px-4 py-2.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Xóa
                    </button>
                    {lastStatus === 'otp_required' && (
                      <button
                        onClick={() => setShowOtp(true)}
                        disabled={!isAdmin}
                        className="inline-flex items-center justify-center rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Nhập OTP
                      </button>
                    )}
                  </div>

                  <div className="mt-4 rounded-2xl border border-white bg-white px-4 py-3 text-sm text-slate-600">
                    {isBotBusy
                      ? 'BOT đang chạy. Tất cả thao tác cấu hình sẽ được mở lại ngay khi phiên đồng bộ kết thúc.'
                      : proxyReady
                          ? 'Sẵn sàng nhận lệnh đồng bộ. Bạn có thể chạy tháng hiện tại, dữ liệu mới nhất hoặc tự chọn kỳ.'
                          : 'Đồng bộ đang bị khóa do chưa có static proxy.'}
                  </div>
                </>
              )}
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Lịch sử</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">Phiên gần đây</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Tập trung lỗi, thời gian chạy và thống kê đầu ra/đầu vào để nhìn trạng thái BOT nhanh hơn.
              </p>

              {historyLoading ? (
                <div className="mt-5 rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  Đang tải lịch sử đồng bộ...
                </div>
              ) : historyRuns.length > 0 ? (
                <div className="mt-5 space-y-3">
                  {historyRuns.map(run => {
                    const runMeta = STATUS_META[run.status] ?? STATUS_META.idle;
                    return (
                      <div key={run.id} className="rounded-2xl border border-slate-200 p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className={`h-2.5 w-2.5 rounded-full ${runMeta.dot}`} />
                              <p className="text-sm font-semibold text-slate-900">{runMeta.label}</p>
                            </div>
                            <p className="mt-2 text-sm text-slate-500">{formatDateTime(run.started_at)}</p>
                          </div>
                          <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${runMeta.pill}`}>
                            {run.output_count + run.input_count} HĐ
                          </span>
                        </div>

                        <div className="mt-4 grid grid-cols-3 gap-2 text-sm text-slate-600">
                          <div className="rounded-2xl bg-slate-50 px-3 py-2">
                            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Đầu ra</p>
                            <p className="mt-1 font-semibold text-slate-900">{run.output_count}</p>
                          </div>
                          <div className="rounded-2xl bg-slate-50 px-3 py-2">
                            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Đầu vào</p>
                            <p className="mt-1 font-semibold text-slate-900">{run.input_count}</p>
                          </div>
                          <div className="rounded-2xl bg-slate-50 px-3 py-2">
                            <p className="text-[11px] uppercase tracking-[0.12em] text-slate-400">Thời lượng</p>
                            <p className="mt-1 font-semibold text-slate-900">
                              {run.duration_ms ? `${Math.max(1, Math.round(run.duration_ms / 1000))}s` : '--'}
                            </p>
                          </div>
                        </div>

                        {run.error_detail && (
                          <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                            {humanizeBotError(run.error_detail)}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {historyMeta.totalPages > 1 && (
                    <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                      <button
                        onClick={() => void loadHistory(historyMeta.page - 1)}
                        disabled={historyMeta.page <= 1 || historyLoading}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Trang trước
                      </button>
                      <span>
                        Trang {historyMeta.page}/{historyMeta.totalPages} · {historyMeta.total} phiên
                      </span>
                      <button
                        onClick={() => void loadHistory(historyMeta.page + 1)}
                        disabled={historyMeta.page >= historyMeta.totalPages || historyLoading}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Trang sau
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-5 rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                  Chưa có lịch sử đồng bộ để hiển thị.
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-amber-100 bg-white shadow-sm">
        <div className="grid gap-6 p-6 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-600">Import thủ công</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">Tách riêng luồng nhập file</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
              Tải lên file XML/ZIP xuất từ cổng hoadondientu.gdt.gov.vn để nhập hóa đơn ngay lập tức, không cần chờ lịch đồng bộ tự động.
            </p>
          </div>

          <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5">
            <div className="grid gap-4 md:grid-cols-[0.8fr_1.2fr] md:items-center">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">Tổng import</p>
                <p className="mt-3 text-4xl font-semibold text-slate-950">
                  {(importTotal ?? 0).toLocaleString('vi-VN')}
                </p>
                <p className="mt-2 text-sm text-amber-900/70">{importSessionCount !== null ? `${importSessionCount.toLocaleString('vi-VN')} phiên import` : 'Đang tải...'}</p>
              </div>

              <div className="space-y-4 rounded-2xl border border-white/70 bg-white/70 p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Tệp hỗ trợ</p>
                  <p className="mt-1 text-sm text-slate-500">XML chi tiết hoặc ZIP chứa nhiều XML từ hoadondientu.gdt.gov.vn.</p>
                </div>
                <button
                  onClick={() => router.push('/import')}
                  className="inline-flex w-full items-center justify-center rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
                >
                  Mở trang Import
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {showSetup && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="w-full max-w-lg rounded-3xl bg-white shadow-2xl">
            <div className="space-y-5 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Bảo mật GDT</p>
                  <h2 className="mt-2 text-xl font-semibold text-slate-950">Cấu hình kết nối BOT</h2>
                </div>
                <button onClick={() => setShowSetup(false)} className="text-xl text-slate-400 transition hover:text-slate-700">
                  ×
                </button>
              </div>

              {isBotBusy && (
                <NoticeCard
                  tone="warning"
                  title="BOT đang bận"
                  body="Phiên đồng bộ hiện tại chưa kết thúc nên cấu hình đang tạm khóa để tránh thay đổi giữa chừng."
                />
              )}

              <div className="grid gap-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Mật khẩu cổng thuế</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={event => setForm(prev => ({ ...prev, password: event.target.value }))}
                    placeholder="Mật khẩu hoadondientu.gdt.gov.vn"
                    autoComplete="new-password"
                    className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Tần suất tự động</label>
                  <select
                    value={form.sync_frequency_hours}
                    onChange={event => setForm(prev => ({ ...prev, sync_frequency_hours: Number(event.target.value) }))}
                    className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900"
                  >
                    <option value={1}>Mỗi 1 giờ</option>
                    <option value={3}>Mỗi 3 giờ</option>
                    <option value={6}>Mỗi 6 giờ</option>
                    <option value={12}>Mỗi 12 giờ</option>
                    <option value={24}>Mỗi 24 giờ</option>
                    <option value={0}>Chỉ chạy thủ công</option>
                  </select>
                </div>

                <label className="flex items-start gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.has_otp}
                    onChange={event => setForm(prev => ({ ...prev, has_otp: event.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  />
                  <span>
                    Tài khoản GDT có OTP hai lớp.
                    <span className="mt-1 block text-xs text-slate-400">Khi BOT yêu cầu OTP, nút nhập OTP sẽ xuất hiện tại khối GDT Crawl.</span>
                  </span>
                </label>

                {form.has_otp && (
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">Nguồn OTP</label>
                    <select
                      value={form.otp_method}
                      onChange={event => setForm(prev => ({ ...prev, otp_method: event.target.value as 'sms' | 'email' | 'app' }))}
                      className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900"
                    >
                      <option value="sms">SMS</option>
                      <option value="email">Email</option>
                      <option value="app">Authenticator App</option>
                    </select>
                  </div>
                )}

                <label className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={acceptPasswordStorage}
                    onChange={event => setAcceptPasswordStorage(event.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300"
                  />
                  <span>
                    Tôi đồng ý lưu mật khẩu GDT đã mã hóa để BOT tự động kết nối cổng thuế.
                    <span className="mt-1 block text-xs text-slate-500">Mật khẩu chỉ phục vụ kết nối BOT và không hiển thị lại dưới dạng văn bản thô.</span>
                  </span>
                </label>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowSetup(false)}
                  className="flex-1 rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Hủy
                </button>
                <button
                  onClick={saveConfig}
                  disabled={!form.password || !acceptPasswordStorage || isBotBusy || isSavingConfig}
                  className="flex-1 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {isSavingConfig ? 'Đang lưu...' : 'Lưu cấu hình'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showDatePicker && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl">
            <div className="space-y-5 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Phạm vi dữ liệu</p>
                  <h2 className="mt-2 text-xl font-semibold text-slate-950">Chọn kỳ đồng bộ</h2>
                </div>
                <button onClick={() => setShowDatePicker(false)} className="text-xl text-slate-400 transition hover:text-slate-700">
                  ×
                </button>
              </div>

              <NoticeCard
                tone="warning"
                title="Giới hạn GDT"
                body="Mỗi lần lấy dữ liệu chỉ được tra cứu tối đa 31 ngày. Nếu chọn dài hơn, hệ thống sẽ tự co lại theo giới hạn này."
              />

              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-700">Chọn nhanh theo tháng</label>
                  <input
                    type="month"
                    value={selectedMonth}
                    onChange={event => handleMonthSelect(event.target.value)}
                    max={`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`}
                    className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">Từ ngày</label>
                    <input
                      type="date"
                      value={runFrom}
                      max={runTo || toLocalDateStr(new Date())}
                      onChange={event => validateAndSetFrom(event.target.value)}
                      className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-slate-700">Đến ngày</label>
                    <input
                      type="date"
                      value={runTo}
                      min={runFrom}
                      max={toLocalDateStr(new Date())}
                      onChange={event => validateAndSetTo(event.target.value)}
                      className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-900"
                    />
                  </div>
                </div>

                {dateError && <p className="text-sm text-rose-600">{dateError}</p>}
                {runFrom && runTo && !dateError && (
                  <p className="text-sm text-emerald-600">
                    Khoảng đồng bộ: {Math.round((new Date(`${runTo}T00:00:00`).getTime() - new Date(`${runFrom}T00:00:00`).getTime()) / 86400000)} ngày.
                  </p>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowDatePicker(false)}
                  className="flex-1 rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Hủy
                </button>
                <button
                  onClick={() => void queueSync({ fromDate: runFrom, toDate: runTo, successMessage: 'Đã bắt đầu đồng bộ theo kỳ đã chọn.' })}
                  disabled={!runFrom || !runTo || !!dateError || controlsDisabled}
                  className="flex-1 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Đồng bộ kỳ này
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showOtp && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="w-full max-w-sm rounded-3xl bg-white shadow-2xl">
            <div className="space-y-5 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">OTP</p>
                  <h2 className="mt-2 text-xl font-semibold text-slate-950">Xác thực phiên chờ</h2>
                </div>
                <button onClick={() => setShowOtp(false)} className="text-xl text-slate-400 transition hover:text-slate-700">
                  ×
                </button>
              </div>

              <p className="text-sm leading-6 text-slate-500">
                Nhập mã OTP từ {cfg?.otp_method === 'sms' ? 'SMS' : cfg?.otp_method === 'email' ? 'email' : 'ứng dụng xác thực'} để BOT tiếp tục phiên đang chờ.
              </p>

              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={event => setOtp(event.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="w-full rounded-2xl border border-slate-300 px-4 py-4 text-center font-mono text-2xl tracking-[0.3em] text-slate-900 outline-none transition focus:border-slate-900"
              />

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowOtp(false);
                    setOtp('');
                  }}
                  className="flex-1 rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  Hủy
                </button>
                <button
                  onClick={submitOtp}
                  disabled={otp.length < 6}
                  className="flex-1 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Gửi OTP
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}