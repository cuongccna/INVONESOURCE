'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import apiClient from '../../../../../lib/apiClient';

interface CompanyNode {
  id: string;
  name: string;
  tax_code: string;
  level: number;
  entity_type: string;
  parent_id: string | null;
  is_consolidated: boolean;
  children: CompanyNode[];
}

interface OrgDetail {
  id: string;
  name: string;
  short_name: string | null;
  companies: CompanyNode[];
}

interface UserCompany {
  id: string;
  name: string;
  tax_code: string;
}

const LEVEL_LABEL: Record<number, string> = { 1: 'TCT', 2: 'CT Con', 3: 'Chi Nhánh' };
const LEVEL_COLOR: Record<number, string> = {
  1: 'bg-purple-100 text-purple-700',
  2: 'bg-blue-100 text-blue-700',
  3: 'bg-gray-100 text-gray-600',
};

function CompanyTree({ nodes, orgId, onRefresh }: { nodes: CompanyNode[]; orgId: string; onRefresh: () => void }) {
  const handleRemove = async (companyId: string) => {
    if (!confirm('Xoá công ty này khỏi nhóm?')) return;
    await apiClient.delete(`/organizations/${orgId}/companies/${companyId}`);
    onRefresh();
  };

  return (
    <ul className="space-y-1">
      {nodes.map((n) => (
        <li key={n.id}>
          <div className="flex items-center gap-2 py-2 px-3 rounded-lg hover:bg-gray-50 group">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${LEVEL_COLOR[n.level] ?? 'bg-gray-100 text-gray-500'}`}>
              {LEVEL_LABEL[n.level] ?? `L${n.level}`}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">{n.name}</p>
              <p className="text-xs text-gray-400 font-mono">{n.tax_code}</p>
            </div>
            <button
              onClick={() => handleRemove(n.id)}
              className="text-xs text-red-500 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded hover:bg-red-50"
            >
              Xoá
            </button>
          </div>
          {n.children.length > 0 && (
            <div className="ml-6 border-l border-gray-100 pl-3">
              <CompanyTree nodes={n.children} orgId={orgId} onRefresh={onRefresh} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function OrgDetailPage() {
  const { id: orgId } = useParams<{ id: string }>();
  const router = useRouter();
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editName, setEditName] = useState('');
  const [editShort, setEditShort] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [myCompanies, setMyCompanies] = useState<UserCompany[]>([]);
  const [addCompanyId, setAddCompanyId] = useState('');
  const [addParentId, setAddParentId] = useState('');
  const [addEntityType, setAddEntityType] = useState('company');
  const [adding, setAdding] = useState(false);

  const loadOrg = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: OrgDetail }>(`/organizations/${orgId}`);
      const data = res.data.data;
      setOrg(data);
      setEditName(data.name);
      setEditShort(data.short_name ?? '');
    } catch { /* silent */ } finally { setLoading(false); }
  }, [orgId]);

  useEffect(() => { void loadOrg(); }, [loadOrg]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiClient.put(`/organizations/${orgId}`, { name: editName, short_name: editShort || null });
      await loadOrg();
    } catch { /* silent */ } finally { setSaving(false); }
  };

  const openAdd = async () => {
    setShowAddModal(true);
    try {
      const res = await apiClient.get<{ data: UserCompany[] }>('/companies');
      setMyCompanies(res.data.data);
    } catch { /* silent */ }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addCompanyId) return;
    setAdding(true);
    try {
      await apiClient.post(`/organizations/${orgId}/companies`, {
        companyId: addCompanyId,
        parentId: addParentId || null,
        entityType: addEntityType,
      });
      setShowAddModal(false);
      setAddCompanyId(''); setAddParentId(''); setAddEntityType('company');
      await loadOrg();
    } catch { /* silent */ } finally { setAdding(false); }
  };

  // Flatten tree for parent selector
  const flattenTree = (nodes: CompanyNode[]): CompanyNode[] =>
    nodes.flatMap((n) => [n, ...flattenTree(n.children)]);

  if (loading) return (
    <div className="flex justify-center items-center min-h-[50vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
    </div>
  );

  if (!org) return (
    <div className="p-4 text-center text-gray-500">
      <p>Không tìm thấy tập đoàn</p>
      <button onClick={() => router.back()} className="mt-3 text-sm text-primary-600">← Quay lại</button>
    </div>
  );

  const allNodes = flattenTree(org.companies);

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => router.back()} className="text-gray-400 hover:text-gray-600 text-lg">←</button>
        <h1 className="text-2xl font-bold text-gray-900">{org.name}</h1>
      </div>

      {/* Edit form */}
      <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Thông tin tập đoàn</h2>
        <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Tên tập đoàn *" required
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
        <input value={editShort} onChange={(e) => setEditShort(e.target.value)} placeholder="Tên viết tắt"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 outline-none" />
        <button type="submit" disabled={saving}
          className="px-4 py-2 bg-primary-600 text-white text-sm rounded-lg font-semibold disabled:opacity-50">
          {saving ? 'Đang lưu…' : 'Lưu thay đổi'}
        </button>
      </form>

      {/* Company tree */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">
            Cấu trúc công ty ({allNodes.length} đơn vị)
          </h2>
          <button onClick={openAdd}
            className="text-xs text-primary-600 font-semibold hover:text-primary-700">
            + Thêm công ty
          </button>
        </div>
        <div className="p-3">
          {org.companies.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">Chưa có công ty nào trong nhóm này</p>
          ) : (
            <CompanyTree nodes={org.companies} orgId={orgId} onRefresh={loadOrg} />
          )}
        </div>
      </div>

      {/* Add company modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end justify-center sm:items-center p-4">
          <form onSubmit={handleAdd}
            className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 space-y-4">
            <h2 className="text-base font-semibold text-gray-900">Thêm công ty vào nhóm</h2>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Chọn công ty *</label>
              <select value={addCompanyId} onChange={(e) => setAddCompanyId(e.target.value)} required
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 outline-none">
                <option value="">-- Chọn --</option>
                {myCompanies.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.tax_code})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Công ty mẹ (tuỳ chọn)</label>
              <select value={addParentId} onChange={(e) => setAddParentId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 outline-none">
                <option value="">-- Cấp gốc --</option>
                {allNodes.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Loại đơn vị</label>
              <select value={addEntityType} onChange={(e) => setAddEntityType(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 outline-none">
                <option value="company">Công ty</option>
                <option value="branch">Chi nhánh</option>
                <option value="representative_office">Văn phòng đại diện</option>
                <option value="project">Dự án</option>
              </select>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={adding}
                className="flex-1 py-2.5 bg-primary-600 text-white text-sm rounded-xl font-semibold disabled:opacity-50">
                {adding ? 'Đang thêm…' : 'Thêm vào nhóm'}
              </button>
              <button type="button" onClick={() => setShowAddModal(false)}
                className="px-4 py-2.5 text-sm text-gray-600 rounded-xl border border-gray-200">
                Huỷ
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
