'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import BackButton from '../../../../components/BackButton';

interface IndicatorConfig {
  id: string;
  form_type: string;
  code: string;
  indicator_number: string;
  label: string;
  section_code: string | null;
  row_type: 'section_header' | 'subsection_header' | 'indicator';
  has_value_col: boolean;
  has_vat_col: boolean;
  value_db_field: string | null;
  vat_db_field: string | null;
  formula_expression: string | null;
  is_manual: boolean;
  is_calculated: boolean;
  display_order: number;
  is_active: boolean;
  notes: string | null;
}

export default function IndicatorConfigsPage() {
  const toast = useToast();
  const [configs, setConfigs] = useState<IndicatorConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editFormula, setEditFormula] = useState('');
  const [saving, setSaving] = useState(false);

  // OWNER-only guard is enforced server-side via requireRole('OWNER') in the API

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: IndicatorConfig[] }>('/indicator-configs?form_type=01/GTGT');
      setConfigs(res.data.data ?? []);
    } catch {
      toast.error('Không thể tải cấu hình chỉ tiêu');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const startEdit = (cfg: IndicatorConfig) => {
    setEditId(cfg.id);
    setEditLabel(cfg.label);
    setEditNotes(cfg.notes ?? '');
    setEditFormula(cfg.formula_expression ?? '');
  };

  const cancelEdit = () => setEditId(null);

  const saveEdit = async (id: string) => {
    setSaving(true);
    try {
      await apiClient.patch(`/indicator-configs/${id}`, {
        label:              editLabel || undefined,
        notes:              editNotes || null,
        formula_expression: editFormula || null,
      });
      toast.success('Đã lưu cấu hình');
      setEditId(null);
      await load();
    } catch {
      toast.error('Lỗi lưu cấu hình');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center gap-3">
        <BackButton fallbackHref="/dashboard" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Cấu hình chỉ tiêu 01/GTGT</h1>
          <p className="text-xs text-gray-400">Chỉ OWNER mới chỉnh sửa được. Thay đổi áp dụng cho tất cả tờ khai.</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">Chỉ tiêu</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Tên chỉ tiêu</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-32">Công thức</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-20">Loại</th>
              <th className="px-4 py-3 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {configs.map((cfg) => {
              const isEditing = editId === cfg.id;
              const rowClass =
                cfg.row_type === 'section_header'    ? 'bg-primary-50/40' :
                cfg.row_type === 'subsection_header' ? 'bg-gray-50/60'    : '';

              return (
                <tr key={cfg.id} className={`${rowClass} hover:bg-gray-50/50`}>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                      cfg.row_type !== 'indicator' ? 'text-gray-400' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {cfg.indicator_number ? `[${cfg.indicator_number}]` : cfg.code}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {isEditing ? (
                      <input
                        className="w-full border border-primary-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                        value={editLabel}
                        onChange={e => setEditLabel(e.target.value)}
                      />
                    ) : (
                      <span className={cfg.row_type !== 'indicator' ? 'font-semibold text-gray-700' : 'text-gray-600'}>
                        {cfg.label}
                      </span>
                    )}
                    {isEditing && (
                      <textarea
                        className="mt-1 w-full border border-gray-200 rounded-lg px-2 py-1 text-xs text-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 resize-none"
                        rows={2}
                        placeholder="Ghi chú..."
                        value={editNotes}
                        onChange={e => setEditNotes(e.target.value)}
                      />
                    )}
                    {!isEditing && cfg.notes && (
                      <p className="text-xs text-gray-400 mt-0.5">{cfg.notes}</p>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {isEditing ? (
                      <input
                        className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-gray-300"
                        value={editFormula}
                        onChange={e => setEditFormula(e.target.value)}
                        placeholder="e.g. [22]+[24]"
                      />
                    ) : (
                      <code className="text-xs text-gray-400">{cfg.formula_expression ?? '—'}</code>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-col gap-0.5">
                      {cfg.is_manual     && <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">manual</span>}
                      {cfg.is_calculated && <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">calc</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {cfg.row_type === 'indicator' && (
                      isEditing ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => void saveEdit(cfg.id)}
                            disabled={saving}
                            className="text-xs bg-primary-600 text-white px-2 py-1 rounded-lg hover:bg-primary-700 disabled:opacity-50"
                          >
                            {saving ? '…' : 'Lưu'}
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-lg hover:bg-gray-200"
                          >
                            Huỷ
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(cfg)}
                          className="text-xs text-gray-400 hover:text-primary-600 transition-colors"
                        >
                          Sửa
                        </button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
