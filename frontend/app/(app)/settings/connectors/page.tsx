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

const PROVIDER_INFO: Record<string, { name: string; color: string; icon: string }> = {
  misa:             { name: 'MISA meInvoice',   color: 'blue',   icon: '🔵' },
  viettel:          { name: 'Viettel SInvoice',  color: 'red',    icon: '🔴' },
  bkav:             { name: 'BKAV eInvoice',     color: 'green',  icon: '🟢' },
  gdt_intermediary: { name: 'GDT Intermediary',  color: 'purple', icon: '🟣' },
};

const CB_COLORS: Record<string, string> = {
  CLOSED:    'bg-green-100 text-green-700',
  OPEN:      'bg-red-100 text-red-700',
  HALF_OPEN: 'bg-yellow-100 text-yellow-700',
};

export default function ConnectorsPage() {
  const toast = useToast();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ providerId: 'misa', credentials: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Connector[] }>('/connectors');
      setConnectors(res.data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggleConnector = async (id: string) => {
    try {
      await apiClient.patch(`/connectors/${id}/toggle`);
      await load();
    } catch {
      toast.error('Lỗi thay đổi trạng thái kết nối');
    }
  };

  const testConnector = async (id: string) => {
    setTesting(id);
    try {
      const res = await apiClient.post<{ data: { healthy: boolean } }>(`/connectors/${id}/test`);
      if (res.data.data.healthy) {
        toast.success('Kết nối thành công!');
      } else {
        toast.warning('Kết nối thất bại!');
      }
    } catch {
      toast.error('Không thể kết nối đến nhà cung cấp');
    } finally {
      setTesting(null);
    }
  };

  const saveConnector = async () => {
    if (!form.credentials.trim()) {
      toast.warning('Vui lòng nhập thông tin xác thực (JSON)');
      return;
    }
    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(form.credentials) as Record<string, string>;
    } catch {
      toast.error('Thông tin xác thực phải là JSON hợp lệ');
      return;
    }

    setSaving(true);
    try {
      await apiClient.post('/connectors', {
        providerId: form.providerId,
        credentials,
      });
      setShowForm(false);
      toast.success('Đã lưu kết nối thành công');
      await load();
    } catch {
      toast.error('Lỗi lưu kết nối. Vui lòng thử lại.');
    } finally {
      setSaving(false);
    }
  };

  const credPlaceholders: Record<string, string> = {
    misa:    '{"username":"email@company.vn","password":"secret","taxCode":"0123456789"}',
    viettel: '{"username":"0100109106-215","password":"111111a@A","taxCode":"0100109106"}',
    bkav:    '{"partnerGuid":"YOUR-GUID","partnerToken":"YOUR-TOKEN","taxCode":"0123456789"}',
    gdt_intermediary: '{"clientId":"YOUR-ID","clientSecret":"YOUR-SECRET","taxCode":"0123456789"}',
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <BackButton fallbackHref="/dashboard" className="mb-4" />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kết Nối NHÀ MẠNG</h1>
          <p className="text-sm text-gray-500 mt-1">Quản lý kết nối MISA / Viettel / BKAV</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          + Thêm
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <div className="bg-white rounded-xl shadow-sm p-4 mb-4 border border-primary-200">
          <h2 className="font-semibold text-gray-900 mb-3">Thêm Kết Nối Mới</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Nhà Cung Cấp</label>
              <select
                value={form.providerId}
                onChange={(e) => setForm((f) => ({ ...f, providerId: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              >
                <option value="misa">MISA meInvoice</option>
                <option value="viettel">Viettel SInvoice</option>
                <option value="bkav">BKAV eInvoice</option>
                <option value="gdt_intermediary">GDT Intermediary</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Thông Tin Xác Thực (JSON)</label>
              <textarea
                rows={4}
                value={form.credentials}
                onChange={(e) => setForm((f) => ({ ...f, credentials: e.target.value }))}
                placeholder={credPlaceholders[form.providerId]}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-gray-400 mt-1">
                ⚠️ Thông tin được mã hóa AES-256-GCM trước khi lưu
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveConnector}
                disabled={saving}
                className="flex-1 bg-primary-600 text-white py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {saving ? 'Đang lưu...' : 'Lưu Kết Nối'}
              </button>
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connector List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : connectors.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-2">Chưa có kết nối nào</p>
          <p className="text-sm">Nhấn &quot;+Thêm&quot; để cấu hình kết nối đầu tiên</p>
        </div>
      ) : (
        <div className="space-y-3">
          {connectors.map((conn) => {
            const info = PROVIDER_INFO[conn.provider_id] ?? { name: conn.provider_id, color: 'gray', icon: '⚪' };
            const cbColor = CB_COLORS[conn.circuit_breaker_state] ?? 'bg-gray-100 text-gray-700';
            return (
              <div key={conn.id} className="bg-white rounded-xl shadow-sm p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{info.icon}</span>
                    <div>
                      <p className="font-semibold text-gray-900">{info.name}</p>
                      <p className="text-xs text-gray-400">Mỗi {conn.sync_frequency_minutes} phút</p>
                    </div>
                  </div>
                  <div
                    className={`w-12 h-6 rounded-full cursor-pointer transition-colors ${conn.is_enabled ? 'bg-primary-600' : 'bg-gray-300'}`}
                    onClick={() => toggleConnector(conn.id)}
                  >
                    <div className={`w-5 h-5 m-0.5 bg-white rounded-full shadow transition-transform ${conn.is_enabled ? 'translate-x-6' : 'translate-x-0'}`} />
                  </div>
                </div>

                <div className="flex items-center gap-2 mb-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cbColor}`}>
                    CB: {conn.circuit_breaker_state}
                  </span>
                  {conn.last_sync_at && (
                    <span className="text-xs text-gray-400">
                      Đồng bộ: {new Date(conn.last_sync_at).toLocaleString('vi-VN')}
                    </span>
                  )}
                </div>

                {conn.last_error && (
                  <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2 mb-3 break-all">
                    Lỗi: {conn.last_error}
                  </p>
                )}

                <button
                  onClick={() => testConnector(conn.id)}
                  disabled={testing === conn.id || !conn.is_enabled}
                  className="w-full border border-gray-300 rounded-lg py-2 text-sm text-gray-700 font-medium disabled:opacity-50"
                >
                  {testing === conn.id ? 'Đang kiểm tra...' : '🔍 Kiểm Tra Kết Nối'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
