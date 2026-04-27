'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../lib/apiClient';

interface Plan {
  id: string; code: string; name: string; tier: string;
  invoice_quota: number; price_per_month: number; price_per_invoice: number | null;
  max_companies: number; max_users: number; is_active: boolean; sort_order: number;
}

const TIER_BADGE: Record<string, string> = {
  basic:      'bg-blue-100 text-blue-700',
  enterprise: 'bg-purple-100 text-purple-700',
  free:       'bg-gray-100 text-gray-600',
};

const TIERS = ['basic', 'enterprise', 'free'] as const;

function PlanRow({
  plan,
  onToggle,
  onEdit,
}: {
  plan: Plan;
  onToggle: (id: string, active: boolean) => void;
  onEdit: (p: Plan) => void;
}) {
  return (
    <tr className={`border-t border-gray-100 transition-colors hover:bg-gray-50 ${!plan.is_active ? 'opacity-50' : ''}`}>
      <td className="px-4 py-3">
        <p className="font-medium text-gray-800">{plan.name}</p>
        <p className="text-xs text-gray-400 font-mono">{plan.code}</p>
      </td>
      <td className="px-4 py-3">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${TIER_BADGE[plan.tier] ?? 'bg-gray-100'}`}>
          {plan.tier}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-700">{plan.invoice_quota.toLocaleString('vi-VN')}</td>
      <td className="px-4 py-3 text-sm text-gray-700">
        {plan.price_per_month.toLocaleString('vi-VN')}đ
      </td>
      <td className="px-4 py-3 text-sm text-gray-500">{plan.max_companies} cty / {plan.max_users} user</td>
      <td className="px-4 py-3">
        <div className="flex gap-2">
          <button onClick={() => onEdit(plan)} className="text-xs text-indigo-600 hover:underline">Sửa</button>
          <button
            onClick={() => onToggle(plan.id, plan.is_active)}
            className={`text-xs ${plan.is_active ? 'text-red-500 hover:underline' : 'text-green-600 hover:underline'}`}
          >
            {plan.is_active ? 'Vô hiệu' : 'Kích hoạt'}
          </button>
        </div>
      </td>
    </tr>
  );
}

interface FormState {
  code: string; name: string; tier: typeof TIERS[number];
  invoice_quota: number; price_per_month: number; max_companies: number; max_users: number;
}

const BLANK: FormState = { code: '', name: '', tier: 'basic', invoice_quota: 1000, price_per_month: 250000, max_companies: 5, max_users: 3 };

export default function AdminPlansPage() {
  const [plans, setPlans]       = useState<Plan[]>([]);
  const [editPlan, setEditPlan] = useState<Plan | null>(null);
  const [showNew, setShowNew]   = useState(false);
  const [form, setForm]         = useState<FormState>(BLANK);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');
  const [loading, setLoading]   = useState(true);
  const [loadErr, setLoadErr]   = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    apiClient.get<{ data: Plan[] }>('/admin/plans')
      .then(r => setPlans(r.data.data ?? []))
      .catch((e: unknown) => {
        const msg = (e as { response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message
          ?? (e instanceof Error ? e.message : 'Không thể tải danh sách gói dịch vụ');
        setLoadErr(msg);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function openEdit(p: Plan) {
    setEditPlan(p);
    setForm({
      code: p.code, name: p.name, tier: p.tier as typeof TIERS[number],
      invoice_quota: p.invoice_quota, price_per_month: p.price_per_month,
      max_companies: p.max_companies, max_users: p.max_users,
    });
    setShowNew(false);
  }

  function openNew() {
    setEditPlan(null); setForm(BLANK); setShowNew(true); setErr('');
  }

  async function save() {
    setSaving(true); setErr('');
    try {
      if (editPlan) {
        await apiClient.patch(`/admin/plans/${editPlan.id}`, form);
      } else {
        await apiClient.post('/admin/plans', form);
      }
      setShowNew(false); setEditPlan(null);
      load();
    } catch (e: unknown) {
      const m = (e as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Lỗi';
      setErr(m);
    } finally { setSaving(false); }
  }

  async function toggleActive(id: string, current: boolean) {
    if (current) {
      await apiClient.delete(`/admin/plans/${id}`);
    } else {
      await apiClient.patch(`/admin/plans/${id}`, { is_active: true });
    }
    load();
  }

  const showForm = showNew || editPlan !== null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold text-gray-800">Gói dịch vụ</h1>
        <button onClick={openNew}
          className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
          + Tạo gói mới
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <div className="bg-white border border-indigo-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-gray-800">
            {editPlan ? `Chỉnh sửa: ${editPlan.name}` : 'Tạo gói mới'}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <Field label="Mã gói (code)" value={form.code} disabled={!!editPlan}
              onChange={v => setForm(f => ({ ...f, code: v }))} />
            <Field label="Tên gói" value={form.name}
              onChange={v => setForm(f => ({ ...f, name: v }))} />
            <div>
              <label className="block text-xs text-gray-500 mb-1">Tier</label>
              <select value={form.tier} onChange={e => setForm(f => ({ ...f, tier: e.target.value as typeof TIERS[number] }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
                {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <NumField label="Quota HĐ / tháng" value={form.invoice_quota}
              onChange={v => setForm(f => ({ ...f, invoice_quota: v }))} />
            <NumField label="Giá / tháng (VNĐ)" value={form.price_per_month}
              onChange={v => setForm(f => ({ ...f, price_per_month: v }))} />
            <NumField label="Số công ty tối đa" value={form.max_companies}
              onChange={v => setForm(f => ({ ...f, max_companies: v }))} />
            <NumField label="Số user tối đa" value={form.max_users}
              onChange={v => setForm(f => ({ ...f, max_users: v }))} />
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <div className="flex gap-3">
            <button onClick={save} disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Đang lưu…' : editPlan ? 'Lưu thay đổi' : 'Tạo gói'}
            </button>
            <button onClick={() => { setShowNew(false); setEditPlan(null); }}
              className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
              Hủy
            </button>
          </div>
        </div>
      )}

      {/* Load error banner */}
      {loadErr && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-red-700">
            <span className="font-semibold">Lỗi tải dữ liệu:</span> {loadErr}
          </p>
          <button
            onClick={load}
            className="ml-4 text-sm text-red-600 underline hover:text-red-800 shrink-0"
          >
            Thử lại
          </button>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Gói', 'Tier', 'Quota / tháng', 'Giá / tháng', 'Giới hạn', ''].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">
                  Đang tải…
                </td>
              </tr>
            ) : plans.length === 0 && !loadErr ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">
                  Chưa có gói nào. Nhấn &quot;+ Tạo gói mới&quot; để bắt đầu.
                </td>
              </tr>
            ) : (
              plans.map(p => (
                <PlanRow key={p.id} plan={p} onToggle={toggleActive} onEdit={openEdit} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:bg-gray-100" />
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
    </div>
  );
}
