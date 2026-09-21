'use client';

import { useCallback, useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { useToast } from '../../../../components/ToastProvider';

/**
 * Hồ sơ thuế của công ty — những thông tin bắt buộc in trên tờ khai.
 *
 * Trước đây tờ khai xuất ra để trống cơ quan thuế nơi nộp, người ký và mã ngành nghề,
 * dễ bị từ chối khi nộp qua eTax. Màn hình này là nơi khai báo một lần, dùng cho mọi kỳ.
 */

interface Option { code: string; label: string }

interface TaxProfile {
  tax_authority_code: string | null;
  tax_authority_name: string | null;
  signer_name: string | null;
  signer_title: string | null;
  business_line_code: string | null;
  accounting_regime: string | null;
  company_type: string | null;
  tax_authority_from_lookup: string | null;
  mst_status: string | null;
  verified_at: string | null;
  business_line_options: Option[];
  accounting_regime_options: Option[];
}

export default function TaxProfilePage() {
  const { activeCompany, activeCompanyId } = useCompany();
  const toast = useToast();

  const [profile, setProfile] = useState<TaxProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    tax_authority_code: '',
    tax_authority_name: '',
    signer_name: '',
    signer_title: '',
    business_line_code: '',
    accounting_regime: '',
  });

  const load = useCallback(async () => {
    if (!activeCompanyId) return;
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: TaxProfile }>(`/companies/${activeCompanyId}/tax-profile`);
      const p = res.data.data;
      setProfile(p);
      setForm({
        tax_authority_code: p.tax_authority_code ?? '',
        tax_authority_name: p.tax_authority_name ?? p.tax_authority_from_lookup ?? '',
        signer_name:        p.signer_name ?? '',
        signer_title:       p.signer_title ?? '',
        business_line_code: p.business_line_code ?? '01',
        accounting_regime:  p.accounting_regime ?? '',
      });
    } catch {
      toast.error('Không tải được hồ sơ thuế');
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, toast]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!activeCompanyId || saving) return;
    setSaving(true);
    try {
      await apiClient.put(`/companies/${activeCompanyId}/tax-profile`, {
        ...form,
        accounting_regime: form.accounting_regime || null,
      });
      toast.success('Đã lưu — tờ khai xuất sau sẽ dùng thông tin này');
      void load();
    } catch {
      toast.error('Lưu thất bại. Vui lòng thử lại.');
    } finally {
      setSaving(false);
    }
  };

  const field = (
    label: string,
    key: keyof typeof form,
    placeholder: string,
    hint?: string,
  ) => (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-700">{label}</label>
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  const missing = [
    !form.tax_authority_code && 'mã cơ quan thuế nơi nộp',
    !form.signer_name && 'người ký tờ khai',
    !form.business_line_code && 'mã ngành nghề',
  ].filter(Boolean) as string[];

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Hồ sơ thuế</h1>
        <p className="text-sm text-gray-500">
          {activeCompany?.name} · MST {activeCompany?.tax_code} — thông tin in trên tờ khai thuế
        </p>
      </div>

      {missing.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-900">
          ⚠ Tờ khai xuất ra sẽ để trống: <strong>{missing.join(', ')}</strong>.
          Cơ quan thuế có thể từ chối hồ sơ khi nộp qua eTax.
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Cơ quan thuế quản lý</p>

        {profile?.tax_authority_from_lookup && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-600">
            Tra cứu từ cổng Cục Thuế: <strong>{profile.tax_authority_from_lookup}</strong>
            {profile.verified_at && ` · ${new Date(profile.verified_at).toLocaleDateString('vi-VN')}`}
            <button
              onClick={() => setForm({ ...form, tax_authority_name: profile.tax_authority_from_lookup ?? '' })}
              className="ml-2 text-primary-600 underline"
            >dùng tên này</button>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {field('Mã cơ quan thuế', 'tax_authority_code', 'VD: 1A0203',
            'Xem trên giấy chứng nhận đăng ký thuế hoặc tài khoản eTax')}
          {field('Tên cơ quan thuế', 'tax_authority_name', 'VD: Thuế cơ sở 5 thành phố Hà Nội')}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Người ký tờ khai</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {field('Họ tên người ký', 'signer_name', 'VD: Nguyễn Văn A')}
          {field('Chức danh', 'signer_title', 'VD: Giám đốc')}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Áp dụng chính sách</p>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700">Ngành nghề trên tờ khai 01/GTGT</label>
          <select
            value={form.business_line_code}
            onChange={(e) => setForm({ ...form, business_line_code: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
          >
            {(profile?.business_line_options ?? []).map((o) => (
              <option key={o.code} value={o.code}>{o.code} — {o.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700">Chế độ kế toán áp dụng</label>
          <select
            value={form.accounting_regime}
            onChange={(e) => setForm({ ...form, accounting_regime: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
          >
            <option value="">— Chưa chọn —</option>
            {(profile?.accounting_regime_options ?? []).map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500">
            Quyết định mẫu báo cáo tài chính áp dụng (B02-DN theo TT200 hay B02-DNN theo TT133).
          </p>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={() => void load()} disabled={saving}
          className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
          Hoàn tác
        </button>
        <button onClick={() => void save()} disabled={saving}
          className="px-5 py-2 text-sm font-semibold bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
          {saving ? 'Đang lưu…' : 'Lưu hồ sơ thuế'}
        </button>
      </div>
    </div>
  );
}
