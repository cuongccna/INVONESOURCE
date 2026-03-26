'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import BackButton from '../../../../components/BackButton';

interface Connector {
  id: string;
  provider_id: string;
  is_enabled: boolean;
  circuit_breaker_state: string;
  last_sync_at: string | null;
  last_error: string | null;
  sync_frequency_minutes: number;
}

type Provider = 'misa' | 'viettel' | 'bkav';

interface MisaForm   { env: 'test' | 'production'; appid: string; username: string; password: string; taxCode: string; hasInputInvoice: boolean }
interface ViettelForm{ username: string; password: string }
interface BkavForm   { partnerGUID: string; partnerToken: string; taxCode: string }

type ConnectorForm = MisaForm | ViettelForm | BkavForm;

const PROVIDER_META: Record<Provider, { name: string; icon: string; colorClass: string }> = {
  misa:    { name: 'MISA meInvoice',  icon: '🔵', colorClass: 'blue'  },
  viettel: { name: 'Viettel VInvoice', icon: '🔴', colorClass: 'red'   },
  bkav:    { name: 'BKAV eInvoice',   icon: '🟢', colorClass: 'green' },
};

const CB_BADGE: Record<string, string> = {
  CLOSED:    'bg-green-100 text-green-700',
  OPEN:      'bg-red-100 text-red-700',
  HALF_OPEN: 'bg-yellow-100 text-yellow-700',
};

function defaultForm(provider: Provider): ConnectorForm {
  if (provider === 'misa')    return { env: 'production', appid: '', username: '', password: '', taxCode: '', hasInputInvoice: false };
  if (provider === 'viettel') return { username: '', password: '' };
  return { partnerGUID: '', partnerToken: '', taxCode: '' };
}

function formToCredentials(provider: Provider, form: ConnectorForm): Record<string, string> {
  if (provider === 'misa') {
    const f = form as MisaForm;
    return { appid: f.appid, username: f.username, password: f.password, taxCode: f.taxCode };
  }
  if (provider === 'viettel') {
    const f = form as ViettelForm;
    return { username: f.username, password: f.password };
  }
  const f = form as BkavForm;
  return { partnerGUID: f.partnerGUID, partnerToken: f.partnerToken, taxCode: f.taxCode };
}

// ─── Sub-forms ──────────────────────────────────────────────────────────────

function MisaFormFields({ form, onChange }: { form: MisaForm; onChange: (f: MisaForm) => void }) {
  const set = <K extends keyof MisaForm>(k: K, v: MisaForm[K]) => onChange({ ...form, [k]: v });
  return (
    <div className="space-y-3">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800">
        <strong>ℹ️ appid</strong> được MISA cấp khi đăng ký tích hợp (không thể tự tạo).<br />
        Liên hệ: <strong>support@misa.com.vn</strong> hoặc hotline <strong>1900 1518</strong>.
      </div>
      <Field label="Môi trường">
        <select value={form.env} onChange={e => set('env', e.target.value as MisaForm['env'])} className={INPUT}>
          <option value="production">Production — api.meinvoice.vn</option>
          <option value="test">Test — testapi.meinvoice.vn</option>
        </select>
      </Field>
      <Field label="App ID (appid)">
        <input type="text" value={form.appid} onChange={e => set('appid', e.target.value)}
          placeholder="appid do MISA cấp" className={INPUT} autoComplete="off" />
      </Field>
      <Field label="Tên đăng nhập">
        <input type="text" value={form.username} onChange={e => set('username', e.target.value)}
          placeholder="email@congty.vn" className={INPUT} autoComplete="username" />
      </Field>
      <Field label="Mật khẩu">
        <input type="password" value={form.password} onChange={e => set('password', e.target.value)}
          className={INPUT} autoComplete="current-password" />
      </Field>
      <Field label="Mã số thuế">
        <input type="text" value={form.taxCode} onChange={e => set('taxCode', e.target.value)}
          placeholder="0123456789" className={INPUT} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
        <input type="checkbox" checked={form.hasInputInvoice}
          onChange={e => set('hasInputInvoice', e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 text-primary-600" />
        Đã đăng ký dịch vụ <strong>Hóa đơn đầu vào</strong> (phí thêm)
      </label>
    </div>
  );
}

function ViettelFormFields({ form, onChange }: { form: ViettelForm; onChange: (f: ViettelForm) => void }) {
  const set = <K extends keyof ViettelForm>(k: K, v: ViettelForm[K]) => onChange({ ...form, [k]: v });
  return (
    <div className="space-y-3">
      <div className="bg-orange-50 border border-orange-300 rounded-lg p-3 text-xs text-orange-900">
        <strong>⚠️ Lưu ý IP Whitelist:</strong> IP server phải được đăng ký trên cổng quản trị Viettel VInvoice trước khi đi live.<br />
        Lỗi 500 không rõ nguyên nhân = IP chưa được whitelist hoặc sai mật khẩu.<br />
        <span className="text-orange-700">API: <code className="font-mono bg-orange-100 px-1 rounded">api-vinvoice.viettel.vn</code></span>
      </div>
      <Field label="Tên đăng nhập" hint="Mã số thuế dùng làm username, vd: 0100109106-509">
        <input type="text" value={form.username} onChange={e => set('username', e.target.value)}
          placeholder="0100109106-509" className={INPUT} autoComplete="username" />
      </Field>
      <Field label="Mật khẩu">
        <input type="password" value={form.password} onChange={e => set('password', e.target.value)}
          className={INPUT} autoComplete="current-password" />
      </Field>
    </div>
  );
}

function BkavFormFields({ form, onChange }: { form: BkavForm; onChange: (f: BkavForm) => void }) {
  const set = <K extends keyof BkavForm>(k: K, v: BkavForm[K]) => onChange({ ...form, [k]: v });
  return (
    <div className="space-y-3">
      <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-800">
        ℹ️ Lấy <strong>PartnerGUID</strong> và <strong>PartnerToken</strong> từ tài khoản doanh nghiệp trên portal BKAV.
        BKAV tự động xác nhận hóa đơn với GDT.
      </div>
      <Field label="Partner GUID">
        <input type="text" value={form.partnerGUID} onChange={e => set('partnerGUID', e.target.value)}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className={INPUT} autoComplete="off" />
      </Field>
      <Field label="Partner Token">
        <PasswordField value={form.partnerToken} onChange={v => set('partnerToken', v)}
          placeholder="Token từ portal BKAV" />
      </Field>
      <Field label="Mã số thuế">
        <input type="text" value={form.taxCode} onChange={e => set('taxCode', e.target.value)}
          placeholder="0123456789" className={INPUT} />
      </Field>
    </div>
  );
}

// ─── Shared UI atoms ─────────────────────────────────────────────────────────

const INPUT = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function PasswordField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} className={INPUT + ' pr-16'} autoComplete="off" />
      <button type="button" onClick={() => setShow(s => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-800 px-1">
        {show ? 'Ẩn' : 'Hiện'}
      </button>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function ConnectorsPage() {
  const toast = useToast();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeForm, setActiveForm] = useState<Provider | null>(null);
  const [forms, setForms] = useState<Record<Provider, ConnectorForm>>({
    misa:    defaultForm('misa'),
    viettel: defaultForm('viettel'),
    bkav:    defaultForm('bkav'),
  });
  const [testing, setTesting]   = useState<string | null>(null);
  const [saving,  setSaving]    = useState<Provider | null>(null);
  const [syncing, setSyncing]   = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Connector[] }>('/connectors');
      setConnectors(res.data.data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const connectorFor = (p: Provider) =>
    connectors.find(c => c.provider_id === p) ?? null;

  // Test credentials before saving (no DB write)
  const testNewCredentials = async (provider: Provider) => {
    const form = forms[provider];
    const credentials = formToCredentials(provider, form);
    setTesting(`new-${provider}`);
    try {
      const res = await apiClient.post<{
        success: boolean;
        data?: { healthy: boolean; environment?: string };
        error?: { message: string };
      }>('/connectors/test-credentials', { providerId: provider, credentials });
      if (res.data.success && res.data.data?.healthy) {
        toast.success(`✅ Kết nối ${PROVIDER_META[provider].name} thành công!`);
      } else {
        const msg = res.data.error?.message ?? 'Kết nối thất bại';
        const ipHint = provider === 'viettel' && msg.includes('500')
          ? ' — Kiểm tra IP whitelist tại Viettel!' : '';
        toast.error(`❌ ${msg}${ipHint}`);
      }
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message ?? 'Lỗi kết nối';
      toast.error(msg);
    } finally {
      setTesting(null);
    }
  };

  // Save connector + trigger initial sync
  const saveConnector = async (provider: Provider) => {
    const form = forms[provider];
    const credentials = formToCredentials(provider, form);

    // Inject MISA_ENV into credentials so backend can read it
    if (provider === 'misa')    credentials['env'] = (form as MisaForm).env;

    setSaving(provider);
    try {
      await apiClient.post('/connectors', { providerId: provider, credentials });
      toast.success(`Đã lưu kết nối ${PROVIDER_META[provider].name}`);
      setActiveForm(null);
      await load();
    } catch {
      toast.error('Lỗi lưu kết nối. Vui lòng thử lại.');
    } finally {
      setSaving(null);
    }
  };

  // Test existing saved connector health
  const testExisting = async (id: string, name: string) => {
    setTesting(id);
    try {
      const res = await apiClient.post<{ data: { healthy: boolean } }>(`/connectors/${id}/test`);
      if (res.data.data.healthy) {
        toast.success(`✅ ${name} đang hoạt động tốt`);
        // Reload to clear stale last_error banner
        await load();
      } else {
        toast.warning(`⚠️ ${name} trả về không khỏe mạnh`);
      }
    } catch {
      toast.error(`Không thể kiểm tra ${name}`);
    } finally {
      setTesting(null);
    }
  };

  const triggerSync = async (id: string) => {
    setSyncing(id);
    try {
      await apiClient.post(`/connectors/${id}/sync`);
      toast.success('Đã thêm vào hàng đợi đồng bộ');
    } catch {
      toast.error('Lỗi kích hoạt đồng bộ');
    } finally {
      setSyncing(null);
    }
  };

  const toggleConnector = async (id: string) => {
    try {
      await apiClient.patch(`/connectors/${id}/toggle`);
      await load();
    } catch {
      toast.error('Lỗi thay đổi trạng thái');
    }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto pb-24">
      <BackButton fallbackHref="/dashboard" className="mb-4" />
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Kết Nối Nhà Mạng</h1>
      <p className="text-sm text-gray-500 mb-6">Quản lý đồng bộ hóa đơn từ MISA · Viettel · BKAV</p>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : (
        <div className="space-y-4">
          {(['misa', 'viettel', 'bkav'] as Provider[]).map(provider => {
            const meta   = PROVIDER_META[provider];
            const conn   = connectorFor(provider);
            const isOpen = activeForm === provider;

            return (
              <div key={provider} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{meta.icon}</span>
                    <div>
                      <p className="font-semibold text-gray-900">{meta.name}</p>
                      {conn ? (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CB_BADGE[conn.circuit_breaker_state] ?? 'bg-gray-100 text-gray-600'}`}>
                          {conn.circuit_breaker_state === 'CLOSED' ? '● Đã kết nối' : conn.circuit_breaker_state}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Chưa kết nối</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {conn ? (
                      <>
                        {/* Toggle switch */}
                        <div
                          className={`w-11 h-6 rounded-full cursor-pointer transition-colors ${conn.is_enabled ? 'bg-primary-600' : 'bg-gray-300'}`}
                          onClick={() => toggleConnector(conn.id)}
                          title={conn.is_enabled ? 'Tắt' : 'Bật'}
                        >
                          <div className={`w-5 h-5 m-0.5 bg-white rounded-full shadow transition-transform ${conn.is_enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                        </div>
                        <button
                          onClick={() => setActiveForm(isOpen ? null : provider)}
                          className="text-xs text-primary-600 font-medium hover:underline"
                        >
                          Sửa
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setActiveForm(isOpen ? null : provider)}
                        className="bg-primary-600 text-white text-sm px-3 py-1.5 rounded-lg font-medium"
                      >
                        Kết nối
                      </button>
                    )}
                  </div>
                </div>

                {/* Last sync info */}
                {conn?.last_sync_at && (
                  <div className="px-4 pb-2 text-xs text-gray-400 flex items-center gap-4">
                    <span>Đồng bộ: {new Date(conn.last_sync_at).toLocaleString('vi-VN')}</span>
                    <span>Mỗi {conn.sync_frequency_minutes} phút</span>
                  </div>
                )}

                {/* Error message */}
                {conn?.last_error && (
                  <div className="mx-4 mb-3 text-xs text-red-700 bg-red-50 rounded-lg px-3 py-2 break-all">
                    ⚠️ {conn.last_error}
                    {provider === 'viettel' && conn.last_error.includes('500') && (
                      <span className="block mt-1 font-medium">→ Kiểm tra IP server đã được đăng ký whitelist tại Viettel chưa?</span>
                    )}
                  </div>
                )}

                {/* Action buttons for existing connector */}
                {conn && !isOpen && (
                  <div className="px-4 pb-4 flex gap-2">
                    <button
                      onClick={() => testExisting(conn.id, meta.name)}
                      disabled={testing === conn.id}
                      className="flex-1 border border-gray-300 rounded-lg py-1.5 text-sm text-gray-700 disabled:opacity-50"
                    >
                      {testing === conn.id ? 'Đang kiểm tra...' : '🔍 Kiểm tra'}
                    </button>
                    <button
                      onClick={() => triggerSync(conn.id)}
                      disabled={syncing === conn.id || !conn.is_enabled}
                      className="flex-1 border border-primary-300 text-primary-700 rounded-lg py-1.5 text-sm disabled:opacity-50"
                    >
                      {syncing === conn.id ? 'Đang xử lý...' : '🔄 Đồng bộ ngay'}
                    </button>
                  </div>
                )}

                {/* Expand: form */}
                {isOpen && (
                  <div className="border-t border-gray-100 p-4 bg-gray-50 space-y-4">
                    {provider === 'misa' && (
                      <MisaFormFields form={forms.misa as MisaForm} onChange={f => setForms(prev => ({ ...prev, misa: f }))} />
                    )}
                    {provider === 'viettel' && (
                      <ViettelFormFields form={forms.viettel as ViettelForm} onChange={f => setForms(prev => ({ ...prev, viettel: f }))} />
                    )}
                    {provider === 'bkav' && (
                      <BkavFormFields form={forms.bkav as BkavForm} onChange={f => setForms(prev => ({ ...prev, bkav: f }))} />
                    )}

                    <p className="text-xs text-gray-400">🔒 Thông tin được mã hóa AES-256-GCM trước khi lưu</p>

                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => testNewCredentials(provider)}
                        disabled={testing === `new-${provider}`}
                        className="flex-1 border border-gray-300 rounded-lg py-2 text-sm text-gray-700 font-medium disabled:opacity-50"
                      >
                        {testing === `new-${provider}` ? 'Đang kiểm tra...' : '🔍 Kiểm tra kết nối'}
                      </button>
                      <button
                        onClick={() => saveConnector(provider)}
                        disabled={saving === provider}
                        className="flex-1 bg-primary-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
                      >
                        {saving === provider ? 'Đang lưu...' : '💾 Lưu & Kết nối'}
                      </button>
                    </div>
                    <button
                      onClick={() => setActiveForm(null)}
                      className="w-full text-xs text-gray-400 hover:text-gray-600 py-1"
                    >
                      Hủy
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
