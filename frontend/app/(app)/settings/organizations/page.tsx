'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';

interface Org {
  id: string;
  name: string;
  short_name: string | null;
  company_count: number;
  created_at: string;
}

export default function OrganizationsPage() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: Org[] }>('/organizations');
      setOrgs(res.data.data);
    } catch { /* silent */ } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await apiClient.post('/organizations', { name: name.trim(), short_name: shortName.trim() || null });
      setShowCreate(false); setName(''); setShortName('');
      await load();
    } catch { /* silent */ } finally { setSaving(false); }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Tập Đoàn / Nhóm</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-primary-600 text-white text-sm rounded-xl font-semibold hover:bg-primary-700"
        >
          + Tạo nhóm mới
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-white rounded-xl shadow-sm p-4 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Tập đoàn mới</h2>
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Tên tập đoàn *" required
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          />
          <input
            value={shortName} onChange={(e) => setShortName(e.target.value)}
            placeholder="Tên viết tắt (tuỳ chọn)"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 outline-none"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={saving}
              className="flex-1 py-2 bg-primary-600 text-white text-sm rounded-lg font-semibold disabled:opacity-50">
              {saving ? 'Đang lưu…' : 'Tạo'}
            </button>
            <button type="button" onClick={() => setShowCreate(false)}
              className="px-4 py-2 text-sm text-gray-600 rounded-lg border border-gray-200">
              Huỷ
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary-600" />
        </div>
      ) : orgs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">🏢</p>
          <p className="font-medium">Chưa có tập đoàn nào</p>
          <p className="text-sm mt-1">Tạo nhóm để quản lý nhiều công ty trong một tập đoàn</p>
        </div>
      ) : (
        <div className="space-y-3">
          {orgs.map((o) => (
            <Link key={o.id} href={`/settings/organizations/${o.id}`}
              className="flex items-center gap-4 bg-white rounded-xl shadow-sm p-4 hover:shadow-md transition-shadow">
              <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center shrink-0">
                <span className="text-purple-700 font-bold text-sm">
                  {(o.short_name ?? o.name).charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900">{o.name}</p>
                {o.short_name && <p className="text-xs text-gray-400">{o.short_name}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold text-gray-700">{o.company_count}</p>
                <p className="text-xs text-gray-400">công ty</p>
              </div>
              <span className="text-gray-300 text-lg">›</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
