'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { formatVND } from '../../../../utils/formatCurrency';

interface TaxSettings {
  business_type: string;
  tax_regime: string;
  vat_rate_hkd: number;
}

interface HkdStatementData {
  period: { month: number; year: number };
  company_type: string;
  tax_regime: string;
  vat_rate_hkd: number;
  revenue: number;
  vat_payable: number;
  pit_payable: number;
  total_payable: number;
  must_declare: boolean;
  threshold: number;
  saved_statement: Record<string, unknown> | null;
}

const BUSINESS_TYPES = [
  { value: 'DN', label: 'Doanh nghiệp (DN)' },
  { value: 'HKD', label: 'Hộ kinh doanh (HKD)' },
  { value: 'HND', label: 'Hộ nông dân (HND)' },
  { value: 'CA_NHAN', label: 'Cá nhân kinh doanh' },
];

const TAX_REGIMES = [
  { value: 'khoan', label: 'Thuế khoán' },
  { value: 'thuc_te', label: 'Theo thực tế' },
  { value: 'khau_tru', label: 'Phương pháp khấu trừ' },
];

export default function HkdPage() {
  const { activeCompanyId } = useCompany();
  const [statement, setStatement] = useState<HkdStatementData | null>(null);
  const [settings, setSettings] = useState<TaxSettings>({ business_type: 'DN', tax_regime: 'khau_tru', vat_rate_hkd: 1.0 });
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState('');
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());

  const fetch = () => {
    if (!activeCompanyId) return;
    setLoading(true);
    apiClient
      .get<{ data: HkdStatementData }>(`/hkd/tax-statement?month=${month}&year=${year}`)
      .then((r) => {
        setStatement(r.data.data);
        setSettings({
          business_type: r.data.data.company_type,
          tax_regime: r.data.data.tax_regime,
          vat_rate_hkd: r.data.data.vat_rate_hkd,
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetch(); }, [activeCompanyId, month, year]);

  const generate = async () => {
    setGenerating(true);
    try {
      await apiClient.post('/hkd/generate', { month, year });
      fetch();
    } catch {
      // ignore
    } finally {
      setGenerating(false);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    setSettingsMsg('');
    try {
      await apiClient.patch('/hkd/settings', settings);
      setSettingsMsg('Đã lưu cài đặt thuế.');
      fetch();
    } catch {
      setSettingsMsg('Lỗi khi lưu cài đặt.');
    } finally {
      setSavingSettings(false);
    }
  };

  const isHkd = ['HKD', 'HND', 'CA_NHAN'].includes(settings.business_type);

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Hộ Kinh Doanh / Cá Nhân KD</h1>
        <p className="text-sm text-gray-500">Tính thuế khoán VAT & TNCN theo doanh thu</p>
      </div>

      {/* Tax settings card */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
        <h2 className="font-semibold text-gray-800">⚙️ Cài đặt loại hình & chế độ thuế</h2>
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Loại hình kinh doanh</label>
            <select value={settings.business_type}
              onChange={(e) => setSettings({ ...settings, business_type: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              {BUSINESS_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Chế độ tính thuế</label>
            <select value={settings.tax_regime}
              onChange={(e) => setSettings({ ...settings, tax_regime: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              {TAX_REGIMES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          {isHkd && settings.tax_regime === 'khoan' && (
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Tỷ lệ VAT khoán (%)</label>
              <input type="number" min={0} max={15} step={0.1}
                value={settings.vat_rate_hkd}
                onChange={(e) => setSettings({ ...settings, vat_rate_hkd: Number(e.target.value) })}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={saveSettings} disabled={savingSettings}
            className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm disabled:opacity-50">
            {savingSettings ? 'Đang lưu...' : 'Lưu cài đặt'}
          </button>
          {settingsMsg && <span className="text-sm text-green-700">{settingsMsg}</span>}
        </div>
      </div>

      {/* Period selector */}
      <div className="flex gap-2 flex-wrap">
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
          className="border rounded-lg px-2 py-1 text-sm">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>Tháng {m}</option>
          ))}
        </select>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
          className="border rounded-lg px-2 py-1 text-sm">
          {[2023, 2024, 2025, 2026].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <button onClick={generate} disabled={generating}
          className="px-4 py-1 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">
          {generating ? 'Đang tính...' : '📋 Tạo tờ khai'}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : statement && (
        <>
          {/* Must declare alert */}
          {statement.must_declare && (
            <div className="bg-red-50 border border-red-300 rounded-xl p-4 text-sm text-red-800">
              ⚠️ <strong>Bắt buộc kê khai!</strong> Doanh thu tháng này vượt ngưỡng{' '}
              {formatVND(statement.threshold)}/tháng theo quy định.
            </div>
          )}

          {/* Tax statement breakdown */}
          {isHkd ? (
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
              <h2 className="font-semibold">📄 Tờ khai thuế hộ kinh doanh — T{month}/{year}</h2>
              <div className="space-y-2 text-sm">
                {[
                  { label: 'Doanh thu trong kỳ', val: statement.revenue, color: 'text-green-700' },
                  { label: `Thuế VAT khoán (${statement.vat_rate_hkd}%)`, val: statement.vat_payable, color: 'text-orange-700' },
                  { label: 'Thuế TNCN (0.5%)', val: statement.pit_payable, color: 'text-orange-700' },
                  { label: 'Tổng phải nộp', val: statement.total_payable, color: 'text-red-700 font-bold text-base' },
                ].map((row) => (
                  <div key={row.label} className="flex justify-between border-b border-gray-100 pb-2 last:border-0">
                    <span className="text-gray-600">{row.label}</span>
                    <span className={row.color}>{formatVND(row.val)}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">
                * Sử dụng mẫu 04/GTGT khi nộp cho Cơ quan Thuế (thay vì 01/GTGT)
              </p>
            </div>
          ) : (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
              <p>Đây là doanh nghiệp (<strong>{settings.business_type}</strong>), sử dụng tờ khai 01/GTGT theo phương pháp khấu trừ.</p>
              <p className="mt-1">→ Xem mục <strong>Tờ khai 01/GTGT</strong> trong Khai báo thuế.</p>
            </div>
          )}

          {statement.saved_statement && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-700">
              ✅ Đã lưu tờ khai kỳ T{month}/{year}
            </div>
          )}
        </>
      )}
    </div>
  );
}
