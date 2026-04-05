'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import { useCompany } from '../../../../contexts/CompanyContext';
import { useSyncContext } from '../../../../contexts/SyncContext';
import BackButton from '../../../../components/BackButton';
import SyncDatePicker from '../../../../components/SyncDatePicker';
import type { SyncJob } from '../../../../components/SyncDatePicker';

interface BotConfig {
  id: string;
  tax_code: string;
  has_otp: boolean;
  otp_method: string | null;
  is_active: boolean;
  sync_frequency_hours: number;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_output_count: number | null;
  last_run_input_count: number | null;
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
  invoices_skipped: number | null;
  duration_ms: number | null;
  error_detail: string | null;
}

/** Map kỹ thuật → thông điệp tiếng Việt thân thiện */
function friendlyError(raw: string | null): string {
  if (!raw) return 'Lỗi không xác định';
  const s = raw.toLowerCase();
  if (s.includes('407') || s.includes('proxy authentication')) return 'Lỗi xác thực proxy — kiểm tra lại mật khẩu proxy.';
  if (s.includes('econnrefused'))  return 'Proxy đang offline — không thể kết nối.';
  if (s.includes('etimedout'))     return 'Hết thời gian chờ — proxy hoặc GDT phản hồi chậm.';
  if (s.includes('captcha_timeout') || (s.includes('captcha') && s.includes('timeout'))) return '2Captcha không giải được trong thời gian cho phép.';
  if (s.includes('invalid_credentials') || s.includes('mật khẩu') || s.includes('sai thông tin')) return 'Sai tên đăng nhập hoặc mật khẩu cổng thuế GDT.';
  if (s.includes('socket') || s.includes('stream') || s.includes('aborted')) return 'Mất kết nối mạng trong khi đồng bộ.';
  if (s.includes('proxy') || s.includes('connect failed')) return 'Kết nối proxy thất bại.';
  return raw.slice(0, 80) + (raw.length > 80 ? '...' : '');
}

const INPUT = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white';

const FREQ_OPTIONS = [
  { value: 0, label: 'Tắt tự động' },
  { value: 6, label: 'Mỗi 6 giờ' },
  { value: 12, label: 'Mỗi 12 giờ' },
  { value: 24, label: 'Mỗi 24 giờ' },
];

export default function ConnectorsPage() {
  const toast = useToast();
  const router = useRouter();
  const { activeCompany, activeCompanyId } = useCompany();
  const [loading, setLoading] = useState(true);
  const [botConfig, setBotConfig] = useState<BotConfig | null>(null);
  const [lastRuns, setLastRuns] = useState<BotRun[]>([]);

  // Setup form
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [syncFreq, setSyncFreq] = useState(6);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Change password
  const [changingPassword, setChangingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  // Sync
  const [showSyncPicker, setShowSyncPicker] = useState(false);
  const { isSyncing, startSync } = useSyncContext();
  const [syncing, setSyncing] = useState(false);

  // Delete
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Import stats
  const [importStats, setImportStats] = useState<{ total: number; lastDate: string | null } | null>(null);

  // Per-run raw error toggle
  const [expandedRunError, setExpandedRunError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [botRes, importRes] = await Promise.all([
        apiClient.get<{ data: { config: BotConfig | null; lastRuns: BotRun[] } }>('/bot/status'),
        apiClient.get<{ meta: { total: number } }>('/invoices', { params: { provider: 'manual', pageSize: 1 } }).catch(() => null),
      ]);
      setBotConfig(botRes.data.data.config);
      setLastRuns(botRes.data.data.lastRuns);
      if (importRes) {
        setImportStats({ total: importRes.data.meta?.total ?? 0, lastDate: null });
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleSetup = async () => {
    if (!password.trim() || !tosAccepted) return;
    setSaving(true);
    try {
      await apiClient.post('/bot/setup', {
        password,
        sync_frequency_hours: syncFreq,
      });
      toast.success('Đã cấu hình GDT Bot thành công!');
      setPassword('');
      setTosAccepted(false);
      await load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      toast.error(msg ?? 'Lỗi cấu hình. Vui lòng thử lại.');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword.trim()) return;
    setSaving(true);
    try {
      await apiClient.post('/bot/setup', {
        password: newPassword,
        sync_frequency_hours: botConfig?.sync_frequency_hours ?? 6,
      });
      toast.success('Đã cập nhật mật khẩu');
      setNewPassword('');
      setChangingPassword(false);
      await load();
    } catch {
      toast.error('Lỗi cập nhật mật khẩu.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiClient.delete('/bot/config');
      toast.success('Đã xóa cấu hình GDT Bot. Dữ liệu hóa đơn vẫn được giữ lại.');
      setShowDeleteConfirm(false);
      await load();
    } catch {
      toast.error('Lỗi xóa cấu hình.');
    } finally {
      setDeleting(false);
    }
  };

  const handleSyncConfirm = async (jobs: SyncJob[]) => {
    setShowSyncPicker(false);
    setSyncing(true);
    try {
      const res = await apiClient.post<{ data: { jobIds: string[] } }>('/sync/start', { jobs });
      startSync(res.data.data.jobIds, activeCompanyId ?? '');
      toast.success(`Đã kích hoạt đồng bộ ${jobs.length} kỳ.`);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) toast.error('Đang có đồng bộ đang chạy.');
      else toast.error('Lỗi kích hoạt đồng bộ.');
    } finally {
      setSyncing(false);
    }
  };

  // Reload config when sync finishes (panel closes)
  const prevSyncing = useRef(false);
  useEffect(() => {
    if (prevSyncing.current && !isSyncing) void load();
    prevSyncing.current = isSyncing;
  }, [isSyncing, load]);

  const toggleActive = async () => {
    try {
      await apiClient.patch('/bot/toggle');
      await load();
    } catch {
      toast.error('Lỗi thay đổi trạng thái.');
    }
  };

  const maskedUsername = botConfig?.tax_code
    ? botConfig.tax_code.slice(0, 3) + '***' + botConfig.tax_code.slice(-3)
    : '';

  const nextAutoSync = botConfig?.last_run_at && botConfig.sync_frequency_hours > 0
    ? new Date(new Date(botConfig.last_run_at).getTime() + botConfig.sync_frequency_hours * 3600_000)
    : null;

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto pb-24 space-y-6">
      <BackButton fallbackHref="/dashboard" className="mb-2" />
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Nguồn Dữ Liệu Hóa Đơn</h1>
        <p className="text-sm text-gray-500">Quản lý cách hệ thống thu thập hóa đơn</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : (
        <>
          {/* ── SECTION 1: GDT BOT ── */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-5 border-b border-gray-50">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">🤖</span>
                <div>
                  <h2 className="font-bold text-gray-900">GDT Bot — Đồng bộ tự động từ Cổng Thuế</h2>
                  <p className="text-xs text-gray-500">
                    Bot tự động đăng nhập vào hoadondientu.gdt.gov.vn và tải về toàn bộ hóa đơn.
                  </p>
                </div>
              </div>
            </div>

            {!botConfig ? (
              /* ── Setup form ── */
              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tên đăng nhập cổng thuế</label>
                  <input
                    type="text"
                    disabled
                    value={activeCompany?.tax_code ?? ''}
                    className={INPUT + ' bg-gray-50 text-gray-400 cursor-not-allowed'}
                    placeholder="Thường là MST hoặc email đăng ký"
                  />
                  <p className="text-xs text-gray-400 mt-0.5">Tự động sử dụng MST của công ty</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Mật khẩu cổng thuế điện tử</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Nhập mật khẩu..."
                      className={INPUT + ' pr-16'}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-800 px-1"
                    >
                      {showPassword ? 'Ẩn' : 'Hiện'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    🔒 Mật khẩu được mã hóa AES-256 trước khi lưu. Chúng tôi không lưu mật khẩu dạng văn bản thô.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-2">Tần suất đồng bộ tự động</label>
                  <div className="flex flex-wrap gap-2">
                    {FREQ_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setSyncFreq(opt.value)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          syncFreq === opt.value
                            ? 'bg-primary-600 text-white border-primary-600'
                            : 'border-gray-300 text-gray-600 hover:border-primary-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-start gap-2 text-xs text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tosAccepted}
                    onChange={(e) => setTosAccepted(e.target.checked)}
                    className="w-4 h-4 mt-0.5 rounded border-gray-300 text-primary-600"
                  />
                  <span>
                    Tôi đồng ý với điều khoản sử dụng dịch vụ và xác nhận rằng mật khẩu
                    cổng thuế được cung cấp cho mục đích đồng bộ dữ liệu hóa đơn của doanh nghiệp tôi.
                  </span>
                </label>

                <button
                  onClick={() => void handleSetup()}
                  disabled={!password.trim() || !tosAccepted || saving}
                  className="w-full bg-primary-600 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50"
                >
                  {saving ? 'Đang lưu...' : 'Lưu & Kích hoạt Bot'}
                </button>
              </div>
            ) : (
              /* ── Status display ── */
              <div className="p-5 space-y-4">
                {/* Status badge */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                      botConfig.is_active && botConfig.last_run_status !== 'error' ? 'bg-green-500' :
                      botConfig.last_run_status === 'error' ? 'bg-red-500' : 'bg-gray-400'
                    }`} />
                    <span className="text-sm font-medium text-gray-900">
                      {botConfig.is_active
                        ? botConfig.last_run_status === 'error' ? 'Lỗi' : 'Đang hoạt động'
                        : 'Đã tạm dừng'}
                    </span>
                  </div>
                  <div
                    className={`w-11 h-6 rounded-full cursor-pointer transition-colors ${
                      botConfig.is_active ? 'bg-primary-600' : 'bg-gray-300'
                    }`}
                    onClick={() => void toggleActive()}
                  >
                    <div className={`w-5 h-5 m-0.5 bg-white rounded-full shadow transition-transform ${
                      botConfig.is_active ? 'translate-x-5' : 'translate-x-0'
                    }`} />
                  </div>
                </div>

                {/* Last sync info */}
                {botConfig.last_run_at && (
                  <div className="text-xs text-gray-500 space-y-1">
                    <p>
                      Lần đồng bộ gần nhất: {new Date(botConfig.last_run_at).toLocaleString('vi-VN')}
                      {botConfig.last_run_output_count != null && (
                        <span> — {botConfig.last_run_output_count} HĐ đầu ra, {botConfig.last_run_input_count ?? 0} HĐ đầu vào</span>
                      )}
                    </p>
                    {nextAutoSync && botConfig.is_active && (
                      <p>Đồng bộ tự động tiếp theo: {nextAutoSync.toLocaleString('vi-VN')}</p>
                    )}
                  </div>
                )}

                {/* Error */}
                {botConfig.last_error && (
                  <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    ⚠️ {botConfig.last_error}
                  </div>
                )}

                {/* Blocked */}
                {botConfig.blocked_until && new Date(botConfig.blocked_until) > new Date() && (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    🚫 Bot tạm khóa đến {new Date(botConfig.blocked_until).toLocaleString('vi-VN')} do lỗi liên tiếp.
                  </div>
                )}

                {/* Username */}
                <div className="text-xs text-gray-500">
                  Tài khoản: <span className="font-mono">{maskedUsername}</span>
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={() => { if (isSyncing) { toast.info('Đang có đồng bộ đang chạy. Nhấn Hủy đồng bộ để dừng lại.'); return; } setShowSyncPicker(true); }}
                    disabled={!botConfig.is_active}
                    className="flex-1 bg-primary-600 text-white rounded-xl py-2 text-sm font-medium disabled:opacity-50"
                  >
                    {isSyncing ? '⏳ Đang đồng bộ...' : 'Đồng bộ ngay'}
                  </button>
                  <button
                    onClick={() => setChangingPassword(true)}
                    className="flex-1 border border-gray-300 rounded-xl py-2 text-sm text-gray-700"
                  >
                    Đổi mật khẩu
                  </button>
                </div>

                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="text-xs text-red-500 hover:text-red-700 underline"
                >
                  Xóa cấu hình
                </button>

                {/* Change password form */}
                {changingPassword && (
                  <div className="border border-primary-200 bg-primary-50/30 rounded-xl p-4 space-y-3">
                    <label className="block text-xs font-medium text-gray-600">Mật khẩu mới</label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleChangePassword(); }}
                      className={INPUT}
                      autoFocus
                      autoComplete="off"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => void handleChangePassword()}
                        disabled={!newPassword.trim() || saving}
                        className="flex-1 bg-primary-600 text-white rounded-lg py-2 text-xs font-medium disabled:opacity-50"
                      >
                        {saving ? 'Đang lưu...' : 'Lưu'}
                      </button>
                      <button
                        onClick={() => { setChangingPassword(false); setNewPassword(''); }}
                        className="flex-1 border border-gray-300 rounded-lg py-2 text-xs text-gray-600"
                      >
                        Hủy
                      </button>
                    </div>
                  </div>
                )}

                {/* Recent runs */}
                {lastRuns.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-2">Lịch sử đồng bộ gần đây</p>
                    <div className="space-y-2">
                      {lastRuns.slice(0, 5).map((run) => {
                        const ts = new Date(run.started_at).toLocaleString('vi-VN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                        const durationS = run.duration_ms ? (run.duration_ms / 1000).toFixed(1) + 's' : null;
                        const newCount  = run.output_count + run.input_count;
                        const skipped   = run.invoices_skipped;
                        return (
                          <div key={run.id} className="text-xs">
                            <div className="flex items-center justify-between">
                              <span className="text-gray-400">{ts}</span>
                              <span className={run.status === 'success' ? 'text-green-600' : run.status === 'error' ? 'text-red-600' : 'text-amber-600'}>
                                {run.status === 'success' ? (
                                  <>
                                    ✅ {newCount} HĐ mới
                                    {skipped != null && skipped > 0 && <span className="text-gray-400 ml-1">· {skipped} bỏ qua</span>}
                                    {durationS && <span className="text-gray-400 ml-1">· {durationS}</span>}
                                  </>
                                ) : run.status === 'error' ? (
                                  <button
                                    className="text-red-600 underline"
                                    onClick={() => setExpandedRunError(expandedRunError === run.id ? null : run.id)}
                                  >
                                    ❌ {friendlyError(run.error_detail)}
                                  </button>
                                ) : '⏳ Đang chạy...'}
                              </span>
                            </div>
                            {run.status === 'error' && expandedRunError === run.id && run.error_detail && (
                              <div className="mt-1 bg-red-50 border border-red-100 rounded p-2 text-red-700 font-mono break-all">
                                {run.error_detail}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── SECTION 2: IMPORT THỦ CÔNG ── */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-5">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-2xl">📁</span>
                <div>
                  <h2 className="font-bold text-gray-900">Import Hóa Đơn Thủ Công</h2>
                  <p className="text-xs text-gray-500">
                    Tải file từ hoadondientu.gdt.gov.vn và import vào hệ thống.
                    Hỗ trợ: XML (chi tiết), ZIP (chứa nhiều file XML).
                  </p>
                </div>
              </div>

              {importStats && importStats.total > 0 && (
                <p className="text-xs text-gray-500 mb-3">
                  Đã import {importStats.total.toLocaleString('vi-VN')} hóa đơn qua import thủ công.
                </p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => router.push('/import')}
                  className="flex-1 bg-primary-600 text-white rounded-xl py-2.5 text-sm font-medium"
                >
                  Đi đến trang Import
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Modals ── */}
      {showSyncPicker && (
        <SyncDatePicker
          onConfirm={(jobs) => void handleSyncConfirm(jobs)}
          onCancel={() => setShowSyncPicker(false)}
          syncing={syncing}
        />
      )}


      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
            <h3 className="text-base font-bold text-gray-900 mb-1">Xóa cấu hình GDT Bot?</h3>
            <p className="text-sm text-gray-500 mb-4">
              Sẽ xóa thông tin đăng nhập cổng thuế. Dữ liệu hóa đơn đã đồng bộ vẫn được giữ lại.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium disabled:opacity-50"
              >
                {deleting ? 'Đang xóa...' : 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
