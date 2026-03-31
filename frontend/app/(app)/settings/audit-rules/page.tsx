'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';

interface AuditRule {
  rule_id: string;
  threshold: number;
  severity: 'critical' | 'warning' | 'info';
  enabled: boolean;
  exclusions: string[];
}

const labels: Record<string, string> = {
  price_spike: 'Spike giá so với baseline',
  new_vendor: 'NCC mới giá trị cao',
  qty_spike: 'Spike số lượng mua',
  round_number: 'Giá trị tròn bất thường',
  freq_spike: 'Tần suất mua bất thường',
  cross_vendor: 'Chênh lệch giá chéo NCC',
};

export default function AuditRulesSettingsPage() {
  const [rules, setRules] = useState<AuditRule[]>([]);
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => {
    const res = await apiClient.get<{ data: AuditRule[] }>('/audit/rules');
    setRules(res.data.data);
  };

  useEffect(() => {
    void load();
  }, []);

  const saveRule = async (rule: AuditRule) => {
    setSaving(rule.rule_id);
    try {
      await apiClient.put(`/audit/rules/${rule.rule_id}`, {
        threshold: rule.threshold,
        severity: rule.severity,
        enabled: rule.enabled,
        exclusions: rule.exclusions ?? [],
      });
      await load();
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Cấu Hình Luật Kiểm Toán</h1>
        <p className="text-sm text-gray-500 mt-1">Điều chỉnh ngưỡng cảnh báo cho audit tự động</p>
      </div>

      {rules.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm p-6 text-sm text-gray-400">Chưa có rule cấu hình.</div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.rule_id} className="bg-white rounded-xl shadow-sm p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-gray-800">{labels[rule.rule_id] ?? rule.rule_id}</p>
                <label className="text-xs text-gray-600 flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => setRules((prev) => prev.map((r) => r.rule_id === rule.rule_id ? { ...r, enabled: e.target.checked } : r))}
                  />
                  Bật
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-gray-600 space-y-1">
                  <span>Threshold</span>
                  <input
                    type="number"
                    value={rule.threshold ?? 0}
                    onChange={(e) => setRules((prev) => prev.map((r) => r.rule_id === rule.rule_id ? { ...r, threshold: Number(e.target.value) } : r))}
                    className="w-full px-2 py-1.5 border border-gray-200 rounded-md"
                  />
                </label>
                <label className="text-xs text-gray-600 space-y-1">
                  <span>Severity</span>
                  <select
                    value={rule.severity}
                    onChange={(e) => setRules((prev) => prev.map((r) => r.rule_id === rule.rule_id ? { ...r, severity: e.target.value as AuditRule['severity'] } : r))}
                    className="w-full px-2 py-1.5 border border-gray-200 rounded-md"
                  >
                    <option value="critical">critical</option>
                    <option value="warning">warning</option>
                    <option value="info">info</option>
                  </select>
                </label>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => void saveRule(rule)}
                  disabled={saving === rule.rule_id}
                  className="text-xs px-3 py-1.5 rounded-lg bg-primary-50 text-primary-700 hover:bg-primary-100 disabled:opacity-50"
                >
                  {saving === rule.rule_id ? 'Đang lưu...' : 'Lưu thay đổi'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
