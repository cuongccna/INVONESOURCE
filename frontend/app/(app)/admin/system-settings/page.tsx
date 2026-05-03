'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import BackButton from '../../../../components/BackButton';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SystemSetting {
  key: string;
  value: string;
  type: 'number' | 'string' | 'boolean';
  group_name: string;
  label: string;
  description: string | null;
  example: string | null;
  default_value: string;
  unit: string | null;
  updated_at: string;
  updated_by_name: string | null;
}

interface SettingsGroup {
  group_name: string;
  settings: SystemSetting[];
}

type DraftMap = Record<string, string>; // key → draft value

// ─── Group display names ──────────────────────────────────────────────────────

const GROUP_LABELS: Record<string, string> = {
  bot_safety:       '🛡️ Bot Safety — Bảo vệ tài khoản GDT',
  queue:            '⏱️ Queue & Scheduler — Lịch chạy & retry',
  circuit_breaker:  '🔌 Circuit Breaker — Bảo vệ quá tải',
  anti_detection:   '🥷 Anti-Detection — Giả lập người dùng',
  gdt_api:          '🌐 GDT API — Timeout & rate limit',
  business_rules:   '📋 Business Rules — Quy tắc nghiệp vụ',
};

// ─── Unit badge ───────────────────────────────────────────────────────────────

function UnitBadge({ unit }: { unit: string | null }) {
  if (!unit) return null;
  return (
    <span className="ml-2 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-500">
      {unit}
    </span>
  );
}

// ─── Single setting card ──────────────────────────────────────────────────────

function SettingCard({
  setting,
  draft,
  onChange,
  onReset,
}: {
  setting: SystemSetting;
  draft: string;
  onChange: (key: string, value: string) => void;
  onReset: (key: string) => void;
}) {
  const isDirty = draft !== setting.value;
  const isDefault = draft === setting.default_value;
  const [showDesc, setShowDesc] = useState(false);

  return (
    <div className={`rounded-lg border p-4 transition-colors ${isDirty ? 'border-yellow-400 bg-yellow-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start justify-between gap-4">
        {/* Label + key */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 text-sm">{setting.label}</span>
            <UnitBadge unit={setting.unit} />
            {isDirty && (
              <span className="inline-block rounded bg-yellow-200 px-1.5 py-0.5 text-xs text-yellow-800">
                Chưa lưu
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-xs text-gray-400">{setting.key}</p>

          {/* Description toggle */}
          {setting.description && (
            <button
              type="button"
              className="mt-1 text-xs text-blue-500 hover:underline"
              onClick={() => setShowDesc((v) => !v)}
            >
              {showDesc ? '▲ Ẩn giải thích' : '▼ Xem giải thích'}
            </button>
          )}
          {showDesc && setting.description && (
            <p className="mt-2 text-xs text-gray-600 leading-relaxed bg-gray-50 rounded p-2">
              {setting.description}
            </p>
          )}
          {showDesc && setting.example && (
            <p className="mt-1 text-xs text-gray-500 italic">
              <strong>Ví dụ:</strong> {setting.example}
            </p>
          )}
        </div>

        {/* Input */}
        <div className="flex items-center gap-2 shrink-0">
          {setting.type === 'boolean' ? (
            <select
              value={draft}
              onChange={(e) => onChange(setting.key, e.target.value)}
              className="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              type={setting.type === 'number' ? 'number' : 'text'}
              value={draft}
              onChange={(e) => onChange(setting.key, e.target.value)}
              className="w-36 rounded border border-gray-300 px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          )}

          {/* Reset to default */}
          {!isDefault && (
            <button
              type="button"
              title={`Đặt lại về: ${setting.default_value}`}
              onClick={() => onReset(setting.key)}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors"
            >
              ↺
            </button>
          )}
        </div>
      </div>

      {/* Footer: default value + last updated */}
      <div className="mt-2 flex items-center gap-3 text-xs text-gray-400">
        <span>Mặc định: <code className="font-mono">{setting.default_value}</code></span>
        {setting.updated_by_name && (
          <span>• Cập nhật bởi {setting.updated_by_name} lúc {new Date(setting.updated_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</span>
        )}
      </div>
    </div>
  );
}

// ─── Group accordion ──────────────────────────────────────────────────────────

function GroupSection({
  group,
  drafts,
  saving,
  onChange,
  onReset,
  onSaveGroup,
}: {
  group: SettingsGroup;
  drafts: DraftMap;
  saving: boolean;
  onChange: (key: string, value: string) => void;
  onReset: (key: string) => void;
  onSaveGroup: (groupName: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const dirtyCount = group.settings.filter((s) => (drafts[s.key] ?? s.value) !== s.value).length;

  return (
    <section className="rounded-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center justify-between px-5 py-4 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-semibold text-gray-800">
          {GROUP_LABELS[group.group_name] ?? group.group_name}
          <span className="ml-2 text-sm font-normal text-gray-500">({group.settings.length} cài đặt)</span>
          {dirtyCount > 0 && (
            <span className="ml-2 rounded-full bg-yellow-400 px-2 py-0.5 text-xs font-medium text-white">
              {dirtyCount} chưa lưu
            </span>
          )}
        </span>
        <span className="text-gray-400">{open ? '▲' : '▼'}</span>
      </button>

      {/* Settings list */}
      {open && (
        <div className="p-4 space-y-3">
          {group.settings.map((s) => (
            <SettingCard
              key={s.key}
              setting={s}
              draft={drafts[s.key] ?? s.value}
              onChange={onChange}
              onReset={onReset}
            />
          ))}

          {/* Per-section save button */}
          {dirtyCount > 0 && (
            <div className="flex justify-end pt-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => onSaveGroup(group.group_name)}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Đang lưu...' : `Lưu ${dirtyCount} thay đổi`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface ApiResponse {
  data: {
    groups: SettingsGroup[];
    total: number;
  };
}

export default function SystemSettingsPage() {
  const toast = useToast();
  const [groups, setGroups] = useState<SettingsGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<DraftMap>({});

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<ApiResponse>('/admin/system-settings');
      const fetchedGroups = res.data.data.groups;
      setGroups(fetchedGroups);

      // Initialize drafts with current values
      const initDrafts: DraftMap = {};
      for (const g of fetchedGroups) {
        for (const s of g.settings) {
          initDrafts[s.key] = s.value;
        }
      }
      setDrafts(initDrafts);
    } catch {
      toast.error('Không thể tải cài đặt hệ thống');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const handleChange = useCallback((key: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleReset = useCallback((key: string) => {
    // Find the default_value from loaded groups
    for (const g of groups) {
      const s = g.settings.find((s) => s.key === key);
      if (s) {
        setDrafts((prev) => ({ ...prev, [key]: s.default_value }));
        return;
      }
    }
  }, [groups]);

  const handleSaveGroup = useCallback(async (groupName: string) => {
    const group = groups.find((g) => g.group_name === groupName);
    if (!group) return;

    const updates = group.settings
      .filter((s) => (drafts[s.key] ?? s.value) !== s.value)
      .map((s) => ({ key: s.key, value: drafts[s.key] ?? s.value }));

    if (!updates.length) return;

    setSaving(true);
    try {
      await apiClient.post('/admin/system-settings/bulk', { updates });
      toast.success(`Đã lưu ${updates.length} cài đặt — áp dụng ngay lập tức vào backend & bot`);
      await load(); // Refresh to get updated_at / updated_by
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
      toast.error(msg ?? 'Lưu thất bại');
    } finally {
      setSaving(false);
    }
  }, [groups, drafts, toast, load]);

  const totalDirty = Object.entries(drafts).filter(([key, val]) => {
    for (const g of groups) {
      const s = g.settings.find((s) => s.key === key);
      if (s) return val !== s.value;
    }
    return false;
  }).length;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <BackButton fallbackHref="/admin" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cài đặt hệ thống</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Thay đổi được áp dụng ngay vào backend và bot đang chạy — không cần restart.
          </p>
        </div>
        {totalDirty > 0 && (
          <span className="ml-auto rounded-full bg-yellow-100 border border-yellow-300 px-3 py-1 text-sm text-yellow-800">
            {totalDirty} thay đổi chưa lưu
          </span>
        )}
      </div>

      {/* Info banner */}
      <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
        <strong>Cơ chế live update:</strong> Khi lưu → DB cập nhật → Redis Hash cập nhật →
        Pub/Sub phát tín hiệu → tất cả process (backend + bot) cập nhật in-memory ngay lập tức.
        Không mất kết nối, không restart service.
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">Đang tải cài đặt...</div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <GroupSection
              key={g.group_name}
              group={g}
              drafts={drafts}
              saving={saving}
              onChange={handleChange}
              onReset={handleReset}
              onSaveGroup={handleSaveGroup}
            />
          ))}
        </div>
      )}
    </div>
  );
}
