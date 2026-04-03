'use client';

import { useState, useMemo } from 'react';

export interface SyncJob {
  fromDate: string;
  toDate: string;
  label: string;
}

/** Format Date → YYYY-MM-DD dùng giờ địa phương (không bị lệch UTC). */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getMonthRange(year: number, month: number): { from: string; to: string } {
  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 0); // last day of month
  return {
    from: toLocalDateStr(from),
    to:   toLocalDateStr(to),
  };
}

function getQuarterJobs(year: number, quarter: number): SyncJob[] {
  const startMonth = (quarter - 1) * 3 + 1;
  return [0, 1, 2].map((offset) => {
    const m = startMonth + offset;
    const range = getMonthRange(year, m);
    return { fromDate: range.from, toDate: range.to, label: `Tháng ${m}` };
  });
}

/** Build last 24 months list */
function getLast24Months(): { year: number; month: number; label: string }[] {
  const now = new Date();
  const result: { year: number; month: number; label: string }[] = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    result.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      label: `Tháng ${d.getMonth() + 1}/${d.getFullYear()}`,
    });
  }
  return result;
}

function getAvailableQuarters(): { year: number; quarter: number; label: string }[] {
  const now = new Date();
  const currentQ = Math.ceil((now.getMonth() + 1) / 3);
  const result: { year: number; quarter: number; label: string }[] = [];
  for (let i = 0; i < 8; i++) {
    let q = currentQ - i;
    let y = now.getFullYear();
    while (q < 1) { q += 4; y--; }
    result.push({ year: y, quarter: q, label: `Quý ${q}/${y}` });
  }
  return result;
}

interface SyncDatePickerProps {
  onConfirm: (jobs: SyncJob[]) => void;
  onCancel: () => void;
  syncing?: boolean;
}

export default function SyncDatePicker({ onConfirm, onCancel, syncing }: SyncDatePickerProps) {
  const [tab, setTab] = useState<'month' | 'quarter'>('month');
  const months = useMemo(() => getLast24Months(), []);
  const quarters = useMemo(() => getAvailableQuarters(), []);
  const [selectedMonth, setSelectedMonth] = useState(0); // index into months[]
  const [selectedQuarter, setSelectedQuarter] = useState(0); // index into quarters[]

  const jobs = useMemo<SyncJob[]>(() => {
    if (tab === 'month') {
      const m = months[selectedMonth];
      if (!m) return [];
      const range = getMonthRange(m.year, m.month);
      return [{ fromDate: range.from, toDate: range.to, label: m.label }];
    } else {
      const q = quarters[selectedQuarter];
      if (!q) return [];
      return getQuarterJobs(q.year, q.quarter);
    }
  }, [tab, selectedMonth, selectedQuarter, months, quarters]);

  const previewText = useMemo(() => {
    if (jobs.length === 0) return '';
    if (jobs.length === 1) {
      return `Đồng bộ HĐ từ ${formatDate(jobs[0].fromDate)} đến ${formatDate(jobs[0].toDate)}`;
    }
    const q = quarters[selectedQuarter];
    return `Đồng bộ ${q?.label ?? 'Quý'} — sẽ chạy 3 lần (${jobs.map((j) => j.label).join(', ')})`;
  }, [jobs, quarters, selectedQuarter]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-gray-900">Chọn kỳ đồng bộ</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex bg-gray-100 rounded-lg p-1">
          {(['month', 'quarter'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                tab === t ? 'bg-white shadow text-primary-700' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'month' ? 'Theo tháng' : 'Theo quý'}
            </button>
          ))}
        </div>

        {/* Month selector */}
        {tab === 'month' && (
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(Number(e.target.value))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {months.map((m, i) => (
              <option key={`${m.year}-${m.month}`} value={i}>{m.label}</option>
            ))}
          </select>
        )}

        {/* Quarter selector */}
        {tab === 'quarter' && (
          <>
            <select
              value={selectedQuarter}
              onChange={(e) => setSelectedQuarter(Number(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {quarters.map((q, i) => (
                <option key={`${q.year}-${q.quarter}`} value={i}>{q.label}</option>
              ))}
            </select>
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠️ Thuế chỉ cho phép lấy theo từng tháng — hệ thống sẽ tự động tách thành 3 lần đồng bộ.
            </p>
          </>
        )}

        {/* Preview */}
        {previewText && (
          <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            ✓ {previewText}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm text-gray-700"
          >
            Hủy
          </button>
          <button
            onClick={() => onConfirm(jobs)}
            disabled={jobs.length === 0 || syncing}
            className="flex-1 bg-primary-600 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {syncing ? 'Đang xử lý...' : 'Bắt đầu đồng bộ'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
