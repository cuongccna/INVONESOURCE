'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import apiClient from '../../lib/apiClient';
import { useCompany } from '../../contexts/CompanyContext';

/* ─── Types ─────────────────────────────────────────────────────────────── */
interface ConnectorFormData {
  provider_type: string;
  username: string;
  password: string;
  company_tax_code: string;
}

const PROVIDERS = [
  { id: 'gdt_intermediary', label: 'GDT Intermediary' },
];

const STEP_LABELS = [
  'Kiểm tra thông tin',
  'Kết nối nhà cung cấp',
  'Đồng bộ lần đầu',
  'Hoàn tất',
];

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [connectors, setConnectors] = useState<ConnectorFormData[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncDone, setSyncDone] = useState(false);
  const [addingConnector, setAddingConnector] = useState(false);
  const [connForm, setConnForm] = useState<ConnectorFormData>({
    provider_type: 'gdt_intermediary',
    username: '',
    password: '',
    company_tax_code: '',
  });
  const [connError, setConnError] = useState('');
  const { activeCompany, activeCompanyId, refreshCompanies } = useCompany();
  const router = useRouter();

  // If no active company, go to companies settings
  useEffect(() => {
    if (!activeCompanyId) router.replace('/settings/companies');
  }, [activeCompanyId, router]);

  /* ─── Step 1: Confirm company info ─────────────────────────────────────── */
  const StepInfo = () => (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-xl p-4 space-y-3">
        <Row label="Tên công ty" value={activeCompany?.name ?? '—'} />
        <Row label="Mã số thuế" value={activeCompany?.tax_code ?? '—'} mono />
      </div>
      <p className="text-xs text-gray-400">
        Nếu thông tin không đúng, hãy{' '}
        <Link href="/settings/companies" className="text-primary-600 underline">
          chỉnh sửa tại đây
        </Link>{' '}
        trước khi tiếp tục.
      </p>
      <button
        onClick={() => setStep(1)}
        className="w-full bg-primary-600 text-white py-3 rounded-xl text-sm font-medium hover:bg-primary-700 transition-colors"
      >
        Xác nhận & tiếp tục
      </button>
    </div>
  );

  /* ─── Step 2: Add connectors ────────────────────────────────────────────── */
  const addConnector = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnError('');
    setAddingConnector(true);
    try {
      await apiClient.post('/connectors', {
        ...connForm,
        company_tax_code: connForm.company_tax_code || activeCompany?.tax_code,
      });
      setConnectors((prev) => [...prev, connForm]);
      setConnForm({ provider_type: 'gdt_intermediary', username: '', password: '', company_tax_code: '' });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? 'Kết nối thất bại';
      setConnError(msg);
    } finally {
      setAddingConnector(false);
    }
  };

  const StepConnectors = () => (
    <div className="space-y-4">
      {connectors.length > 0 && (
        <div className="space-y-2">
          {connectors.map((c, i) => (
            <div key={i} className="flex items-center gap-2 bg-green-50 border border-green-100 rounded-xl px-4 py-3">
              <span className="text-green-500">✅</span>
              <span className="text-sm font-medium text-gray-800">
                {PROVIDERS.find((p) => p.id === c.provider_type)?.label ?? c.provider_type}
              </span>
              <span className="text-xs text-gray-400 ml-auto">{c.username}</span>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={(e) => void addConnector(e)} className="bg-gray-50 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Thêm nhà cung cấp</h3>

        {connError && (
          <div className="bg-red-50 text-red-600 text-xs px-3 py-2 rounded-lg">{connError}</div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Nhà cung cấp</label>
          <select
            value={connForm.provider_type}
            onChange={(e) => setConnForm({ ...connForm, provider_type: e.target.value })}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tài khoản</label>
            <input
              required
              value={connForm.username}
              onChange={(e) => setConnForm({ ...connForm, username: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
              placeholder="user@company"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Mật khẩu</label>
            <input
              required
              type="password"
              value={connForm.password}
              onChange={(e) => setConnForm({ ...connForm, password: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
              placeholder="••••••••"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={addingConnector}
          className="w-full border border-primary-300 text-primary-700 py-2 rounded-xl text-sm font-medium hover:bg-primary-50 disabled:opacity-60 transition-colors"
        >
          {addingConnector ? 'Đang kết nối...' : '+ Thêm kết nối'}
        </button>
      </form>

      <div className="flex gap-3">
        <button
          onClick={() => setStep(0)}
          className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          Quay lại
        </button>
        <button
          onClick={() => setStep(2)}
          className="flex-1 bg-primary-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-primary-700 transition-colors"
          disabled={connectors.length === 0}
        >
          {connectors.length === 0 ? 'Cần thêm ít nhất 1' : 'Tiếp tục'}
        </button>
      </div>
    </div>
  );

  /* ─── Step 3: First sync ────────────────────────────────────────────────── */
  const triggerSync = async () => {
    setSyncing(true);
    try {
      await apiClient.post('/connectors/sync-all');
    } catch {
      // silent — job queued
    }
    // Show progress for 3 seconds then allow continuing
    await new Promise((r) => setTimeout(r, 3000));
    setSyncDone(true);
    setSyncing(false);
  };

  const StepSync = () => (
    <div className="space-y-4">
      <div className="bg-blue-50 rounded-xl p-4 text-sm text-blue-700 leading-relaxed">
        Hệ thống sẽ kéo hóa đơn từ {connectors.length} nhà cung cấp về lần đầu. Quá trình có thể
        mất vài phút tùy số lượng hóa đơn.
      </div>

      {!syncing && !syncDone && (
        <button
          onClick={() => void triggerSync()}
          className="w-full bg-primary-600 text-white py-3 rounded-xl text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          Bắt đầu đồng bộ
        </button>
      )}

      {syncing && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
          <p className="text-sm text-gray-500">Đang đồng bộ hóa đơn...</p>
        </div>
      )}

      {syncDone && (
        <>
          <div className="flex items-center gap-3 bg-green-50 border border-green-100 rounded-xl px-4 py-3">
            <span className="text-2xl">✅</span>
            <p className="text-sm text-green-700">Đã bắt đầu đồng bộ! Hóa đơn sẽ xuất hiện sau ít phút.</p>
          </div>
          <button
            onClick={() => setStep(3)}
            className="w-full bg-primary-600 text-white py-3 rounded-xl text-sm font-medium hover:bg-primary-700 transition-colors"
          >
            Tiếp tục
          </button>
        </>
      )}
    </div>
  );

  /* ─── Step 4: Done ──────────────────────────────────────────────────────── */
  const finish = async () => {
    if (!activeCompanyId) return;
    try {
      await apiClient.patch(`/companies/${activeCompanyId}/onboarded`);
      await refreshCompanies();
    } catch {
      // silent
    }
    router.push('/dashboard');
  };

  const StepDone = () => (
    <div className="space-y-4 text-center">
      <div className="text-6xl mb-2">🎉</div>
      <h2 className="text-xl font-bold text-gray-900">Tất cả đã sẵn sàng!</h2>
      <p className="text-sm text-gray-500 leading-relaxed">
        Công ty <strong>{activeCompany?.name}</strong> đã được kết nối. Hóa đơn sẽ được đồng bộ tự động mỗi 15 phút.
      </p>
      <button
        onClick={() => void finish()}
        className="w-full bg-primary-600 text-white py-3 rounded-xl text-sm font-semibold hover:bg-primary-700 transition-colors mt-2"
      >
        Đi đến Dashboard
      </button>
    </div>
  );

  const STEPS = [<StepInfo key={0} />, <StepConnectors key={1} />, <StepSync key={2} />, <StepDone key={3} />];

  return (
    <div className="min-h-screen bg-gray-50 flex items-start justify-center pt-10 px-4">
      <div className="w-full max-w-md">
        {/* Logo / title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary-600 text-white text-2xl font-bold mb-3">
            I
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Thiết lập công ty</h1>
          <p className="text-sm text-gray-500 mt-1">{STEP_LABELS[step]}</p>
        </div>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-1 mb-8">
          {STEP_LABELS.map((_, i) => (
            <div key={i} className="flex items-center gap-1">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                  i < step
                    ? 'bg-primary-600 text-white'
                    : i === step
                    ? 'bg-primary-600 text-white ring-4 ring-primary-100'
                    : 'bg-gray-200 text-gray-500'
                }`}
              >
                {i < step ? '✓' : i + 1}
              </div>
              {i < STEP_LABELS.length - 1 && (
                <div className={`w-8 h-0.5 ${i < step ? 'bg-primary-600' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          {STEPS[step]}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-medium text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
