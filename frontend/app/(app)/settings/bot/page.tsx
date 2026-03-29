'use client';

import { useCallback, useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import BackButton from '../../../../components/BackButton';
import { useToast } from '../../../../components/ToastProvider';

interface BotConfig {
  id:                    string;
  company_id:            string;
  tax_code:              string;
  has_otp:               boolean;
  otp_method:            string | null;
  is_active:             boolean;
  sync_frequency_hours:  number;
  last_run_at:           string | null;
  last_run_status:       string | null;
  last_run_output_count: number;
  last_run_input_count:  number;
  last_error:            string | null;
  blocked_until:         string | null;
}

interface BotStatus {
  config:    BotConfig | null;
  lastRuns:  BotRun[];
}

interface BotRun {
  id:            string;
  started_at:    string;
  finished_at:   string | null;
  status:        string;
  output_count:  number;
  input_count:   number;
  duration_ms:   number | null;
  error_detail:  string | null;
}

const STATUS_DOT: Record<string, string> = {
  success:      'bg-green-500',
  error:        'bg-red-500',
  otp_required: 'bg-amber-500',
  blocked:      'bg-orange-600',
  running:      'bg-blue-500 animate-pulse',
};

const STATUS_LABEL: Record<string, string> = {
  success:      '✅ Đang hoạt động',
  error:        '❌ Lỗi',
  otp_required: '🔐 Cần xác thực OTP',
  blocked:      '🚫 Bị tạm khóa',
  running:      '⏳ Đang chạy...',
};

export default function BotSettingsPage() {
  const toast = useToast();
  const [status, setStatus]       = useState<BotStatus | null>(null);
  const [loading, setLoading]     = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [otp, setOtp]             = useState('');
  const [showOtp, setShowOtp]     = useState(false);
  const [running, setRunning]         = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [runFrom, setRunFrom]         = useState('');
  const [runTo, setRunTo]             = useState('');
  const [dateError, setDateError]     = useState('');

  /** Khi người dùng chọn Từ ngày, tự động điền Đến ngày = cuối tháng đó (giới hạn hôm nay). */
  const validateAndSetFrom = (val: string) => {
    setRunFrom(val);
    setDateError('');
    if (!val) return;
    const today = new Date().toISOString().slice(0, 10);
    // Auto-fill to end of the selected month, capped at today
    const d = new Date(val + 'T00:00:00');
    const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    const autoTo = endOfMonth > today ? today : endOfMonth;
    setRunTo(autoTo);
  };
  const validateAndSetTo = (val: string) => {
    setRunTo(val);
    setDateError('');
    if (!val || !runFrom) return;
    const diffMs = new Date(val).getTime() - new Date(runFrom).getTime();
    if (diffMs < 0) { setDateError('Đến ngày phải lớn hơn Từ ngày'); return; }
    if (diffMs > 31 * 24 * 60 * 60 * 1000) {
      // Cap fromDate = toDate - 31 days
      const capped = new Date(new Date(val).getTime() - 31 * 24 * 60 * 60 * 1000);
      setRunFrom(capped.toISOString().slice(0, 10));
      setDateError('');
    }
  };

  // Setup form
  const [form, setForm] = useState({
    password:            '',
    has_otp:             false,
    otp_method:          'sms' as 'sms' | 'email' | 'app',
    sync_frequency_hours: 6,
  });

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: BotStatus }>('/bot/status');
      setStatus(res.data.data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Auto-poll every 5 s while the bot is actively running
  const isRunning = status?.config?.last_run_status === 'running';
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => void load(), 5000);
    return () => clearInterval(interval);
  }, [isRunning, load]);

  const saveConfig = async () => {
    try {
      await apiClient.post('/bot/setup', form);
      toast.success('✅ Đã lưu cấu hình GDT Bot. Đang chạy lần đầu...');
      setShowSetup(false);
      setForm(p => ({ ...p, password: '' }));
      await load();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: { message?: string } } } };
      toast.error(e?.response?.data?.error?.message ?? 'Lỗi lưu cấu hình');
    }
  };

  const runNow = async (fromDate?: string, toDate?: string) => {
    setRunning(true);
    try {
      const body: Record<string, string> = {};
      if (fromDate) body['from_date'] = fromDate;
      if (toDate)   body['to_date']   = toDate;
      await apiClient.post('/bot/run-now', body);
      toast.success(fromDate ? `Đã xếp hàng lấy dữ liệu từ ${fromDate}` : 'Đã thêm vào hàng đợi đồng bộ');
      setTimeout(() => void load(), 2000);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: { code?: string; waitMinutes?: number; message?: string } } } };
      const apiErr = e?.response?.data?.error;
      if (apiErr?.code === 'COOLDOWN') {
        toast.error(`⏳ Bot đang trong thời gian nghỉ. Vui lòng chờ thêm ${apiErr.waitMinutes} phút.`);
      } else {
        toast.error(apiErr?.message ?? 'Lỗi kích hoạt đồng bộ');
      }
    } finally {
      setRunning(false);
    }
  };

  const submitOtp = async () => {
    if (otp.length < 6) return;
    try {
      await apiClient.post('/bot/submit-otp', { otp });
      toast.success('Đã gửi OTP — tiếp tục đồng bộ');
      setShowOtp(false);
      setOtp('');
      await load();
    } catch {
      toast.error('OTP không hợp lệ hoặc đã hết hạn');
    }
  };

  const deleteConfig = async () => {
    if (!confirm('Xóa cấu hình GDT Bot? Dữ liệu hóa đơn đã nhập sẽ không bị xóa.')) return;
    try {
      await apiClient.delete('/bot/config');
      toast.success('Đã xóa cấu hình');
      await load();
    } catch {
      toast.error('Lỗi xóa cấu hình');
    }
  };

  const cfg = status?.config;
  const lastStatus = cfg?.last_run_status ?? null;

  if (loading) return (
    <div className="flex justify-center py-24">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
    </div>
  );

  return (
    <div className="p-4 max-w-2xl mx-auto pb-24 space-y-5">
      {/* ── Running progress indicator ── */}
      {lastStatus === 'running' && (
        <div className="sticky top-14 -mx-4 px-4 py-2.5 bg-blue-600 text-white z-30 flex items-center gap-3 shadow-sm">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold">⚙️ Bot đang đồng bộ hóa đơn</span>
            <span className="text-xs text-blue-100 ml-2 hidden sm:inline">· tự động cập nhật sau 5 giây</span>
          </div>
        </div>
      )}
      <BackButton fallbackHref="/settings/connectors" />
      <div>
        <h1 className="text-2xl font-bold text-gray-900">GDT Crawler Bot</h1>
        <p className="text-sm text-gray-500">Tự động thu thập HĐ đầu vào &amp; đầu ra từ hoadondientu.gdt.gov.vn</p>
      </div>

      {/* ── Explain banner ── */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-800 space-y-1.5">
        <p className="font-semibold">🏦 Tại sao cần GDT Bot?</p>
        <p>GDT là nơi DUY NHẤT nhận toàn bộ HĐ từ mọi nhà mạng — cả hai chiều.
        Bot tự đăng nhập cổng thuế, tải file XML theo lịch và cập nhật vào hệ thống.</p>
        <p className="text-blue-700">🔒 Thông tin đăng nhập được mã hóa AES-256-GCM và chỉ dùng để kết nối cổng thuế.</p>
      </div>

      {/* ── Status card — Not configured ── */}
      {!cfg && (
        <div className="bg-white rounded-xl border border-gray-100 p-6 text-center space-y-3">
          <p className="text-4xl">🤖</p>
          <p className="font-semibold text-gray-900">Chưa thiết lập GDT Bot</p>
          <p className="text-sm text-gray-500">Cần thông tin đăng nhập hoadondientu.gdt.gov.vn</p>
          <button onClick={() => setShowSetup(true)}
            className="bg-blue-600 text-white text-sm px-6 py-2.5 rounded-xl font-medium hover:bg-blue-700">
            🔧 Thiết lập ngay
          </button>
        </div>
      )}

      {/* ── Status card — Configured ── */}
      {cfg && (
        <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`w-2.5 h-2.5 rounded-full ${STATUS_DOT[lastStatus ?? 'success'] ?? 'bg-gray-400'}`} />
              <span className="font-medium text-gray-900">
                {STATUS_LABEL[lastStatus ?? 'success'] ?? 'Chưa chạy'}
              </span>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              {cfg.is_active ? 'Hoạt động' : 'Tắt'}
            </span>
          </div>

          <div className="text-xs text-gray-500 space-y-1">
            <p>MST: <strong className="text-gray-700 font-mono">{cfg.tax_code}</strong></p>
            <p>Tần suất: mỗi <strong className="text-gray-700">{cfg.sync_frequency_hours} giờ</strong></p>
            {cfg.last_run_at && (
              <p>Lần cuối: <strong className="text-gray-700">{new Date(cfg.last_run_at).toLocaleString('vi-VN')}</strong>
                {' '}· HĐ ra: {cfg.last_run_output_count} · vào: {cfg.last_run_input_count}
              </p>
            )}
            {cfg.blocked_until && new Date(cfg.blocked_until) > new Date() && (
              <p className="text-orange-600">⏳ Tạm khóa đến: {new Date(cfg.blocked_until).toLocaleString('vi-VN')}</p>
            )}
          </div>

          {cfg.last_error && (
            <div className="bg-red-50 rounded-lg px-3 py-2 text-xs text-red-700 break-all">
              ⚠️ {cfg.last_error}
            </div>
          )}

          {lastStatus === 'otp_required' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
              <p className="text-sm font-medium text-amber-800">🔐 Bot cần mã OTP để tiếp tục</p>
              <button onClick={() => setShowOtp(true)}
                className="w-full bg-amber-600 text-white text-sm py-2 rounded-lg font-medium">
                Nhập OTP ngay
              </button>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => {
                const today = new Date();
                const todayStr = today.toISOString().slice(0, 10);
                const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
                setRunFrom(firstOfMonth);
                setRunTo(todayStr);
                setDateError('');
                setShowDatePicker(true);
              }}
              disabled={running}
              className="flex-1 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50 hover:bg-blue-700"
            >
              {running ? '⏳ Đang xử lý...' : '▶ Đồng bộ hóa đơn'}
            </button>
            <button onClick={() => setShowSetup(true)} disabled={running}
              className="border border-gray-300 text-gray-700 rounded-xl px-4 py-2.5 text-sm hover:bg-gray-50 disabled:opacity-50">
              ✏️ Sửa
            </button>
            <button onClick={deleteConfig}
              className="border border-red-200 text-red-600 rounded-xl px-4 py-2.5 text-sm hover:bg-red-50">
              🗑
            </button>
          </div>
        </div>
      )}

      {/* ── Last runs log ── */}
      {status?.lastRuns && status.lastRuns.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <p className="text-sm font-semibold text-gray-700 mb-3">Lịch sử chạy gần đây</p>
          <div className="space-y-2">
            {status.lastRuns.map(run => (
              <div key={run.id} className="flex items-center justify-between text-xs py-1 border-b border-gray-50 last:border-0">
                <div>
                  <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${run.status === 'success' ? 'bg-green-400' : run.status === 'error' ? 'bg-red-400' : 'bg-amber-400'}`} />
                  {new Date(run.started_at).toLocaleString('vi-VN')}
                  {run.error_detail && <span className="block text-red-500 mt-0.5 truncate max-w-[200px]">{run.error_detail}</span>}
                </div>
                <div className="text-right text-gray-500">
                  <p>Ra: {run.output_count} · Vào: {run.input_count}</p>
                  {run.duration_ms && <p>{(run.duration_ms / 1000).toFixed(0)}s</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Setup modal ── */}
      {showSetup && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-gray-900">Cấu hình GDT Bot</h2>
                <button onClick={() => setShowSetup(false)} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
              </div>

              <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-800">
                ℹ️ <strong>Mật khẩu cổng thuế</strong> — là mật khẩu đăng nhập{' '}
                <strong>hoadondientu.gdt.gov.vn</strong> (khác với mật khẩu MISA/Viettel).
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Mật khẩu cổng thuế *</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    placeholder="Mật khẩu hoadondientu.gdt.gov.vn"
                    autoComplete="new-password"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Tần suất đồng bộ</label>
                  <select
                    value={form.sync_frequency_hours}
                    onChange={e => setForm(p => ({ ...p, sync_frequency_hours: Number(e.target.value) }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    <option value={6}>Mỗi 6 giờ (khuyến nghị)</option>
                    <option value={12}>Mỗi 12 giờ</option>
                    <option value={24}>Mỗi 24 giờ</option>
                    <option value={0}>Thủ công (không tự chạy)</option>
                  </select>
                </div>

                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={form.has_otp}
                    onChange={e => setForm(p => ({ ...p, has_otp: e.target.checked }))}
                    className="w-4 h-4 rounded" />
                  Tài khoản có xác thực 2 bước (OTP)
                </label>

                {form.has_otp && (
                  <div>
                    <label className="text-xs font-medium text-gray-600 block mb-1">Phương thức OTP</label>
                    <select
                      value={form.otp_method}
                      onChange={e => setForm(p => ({ ...p, otp_method: e.target.value as typeof form.otp_method }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                    >
                      <option value="sms">SMS</option>
                      <option value="email">Email</option>
                      <option value="app">App xác thực</option>
                    </select>
                  </div>
                )}
              </div>

              <p className="text-xs text-gray-400">🔒 Mật khẩu được mã hóa AES-256-GCM và không lưu dạng văn bản thô.</p>

              <div className="flex gap-3">
                <button onClick={() => setShowSetup(false)}
                  className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm">
                  Hủy
                </button>
                <button onClick={saveConfig} disabled={!form.password}
                  className="flex-1 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50">
                  Lưu & Kết nối
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Date picker modal — Lấy dữ liệu lịch sử ── */}
      {showDatePicker && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-900">🕒 Lấy dữ liệu theo khoảng thời gian</h2>
              <button onClick={() => setShowDatePicker(false)} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
            </div>
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠️ Quy định GDT: chỉ được phép tra cứu tối đa <strong>31 ngày</strong> mỗi lần.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Từ ngày</label>
                <input
                  type="date"
                  value={runFrom}
                  max={runTo || new Date().toISOString().slice(0, 10)}
                  onChange={e => validateAndSetFrom(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Đến ngày</label>
                <input
                  type="date"
                  value={runTo}
                  min={runFrom}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={e => validateAndSetTo(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
              {dateError && <p className="text-xs text-red-600">{dateError}</p>}
              {runFrom && runTo && !dateError && (() => {
                const diffDays = Math.round((new Date(runTo).getTime() - new Date(runFrom).getTime()) / 86400000);
                return <p className="text-xs text-green-600">✓ Khoảng: {diffDays} ngày</p>;
              })()}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowDatePicker(false)}
                className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm">
                Hủy
              </button>
              <button
                onClick={() => {
                  if (!runFrom || !runTo || dateError) return;
                  setShowDatePicker(false);
                  void runNow(runFrom, runTo);
                }}
                disabled={!runFrom || !runTo || !!dateError || running}
                className="flex-1 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50"
              >
                Lấy dữ liệu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── OTP modal ── */}
      {showOtp && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5 space-y-4">
            <h2 className="font-bold text-gray-900">🔐 Nhập mã OTP</h2>
            <p className="text-sm text-gray-600">
              Mã OTP đã được gửi đến {cfg?.otp_method === 'sms' ? 'điện thoại' : cfg?.otp_method === 'email' ? 'email' : 'app xác thực'} của bạn.
            </p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
              className="w-full border border-gray-300 rounded-xl px-4 py-3 text-center text-2xl font-mono tracking-widest"
              placeholder="000000"
            />
            <div className="flex gap-3">
              <button onClick={() => { setShowOtp(false); setOtp(''); }}
                className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm">
                Hủy
              </button>
              <button onClick={submitOtp} disabled={otp.length < 6}
                className="flex-1 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50">
                Xác nhận
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
