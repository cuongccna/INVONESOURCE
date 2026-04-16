'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import BackButton from '../../../../components/BackButton';

interface Company {
  id: string;
  name: string;
  tax_code: string;
  address: string;
  phone: string;
  email: string;
  company_type: 'household' | 'enterprise' | 'branch';
  fiscal_year_start: number;
  onboarded: boolean;
  role: string;
  created_at: string;
}

const COMPANY_TYPE_LABELS: Record<string, string> = {
  household: 'Hộ kinh doanh',
  enterprise: 'Doanh nghiệp',
  branch: 'Chi nhánh doanh nghiệp',
};

const MONTHS = [
  'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4',
  'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8',
  'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

type CompanyFormData = {
  name: string;
  tax_code: string;
  address: string;
  phone: string;
  email: string;
  company_type: 'household' | 'enterprise' | 'branch';
  fiscal_year_start: number;
};

const EMPTY_FORM: CompanyFormData = {
  name: '',
  tax_code: '',
  address: '',
  phone: '',
  email: '',
  company_type: 'enterprise',
  fiscal_year_start: 1,
};

function validateTaxCode(tax_code: string, company_type: CompanyFormData['company_type']): string {
  if (!tax_code) return '';
  if (company_type === 'household') {
    if (!/^\d{9}$|^\d{10}$|^\d{11}$|^\d{12}$/.test(tax_code)) {
      return 'Hộ kinh doanh: MST/Giấy tờ tùy thân phải là 9, 10, 11 hoặc 12 chữ số';
    }
  } else {
    if (!/^\d{10}(-\d{3})?$/.test(tax_code)) {
      return 'MST phải là 10 chữ số (hoặc 13 ký tự cho chi nhánh: 0123456789-001)';
    }
  }
  return '';
}

export default function CompaniesSettingsPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<Company | null>(null);
  const [form, setForm] = useState<CompanyFormData>(EMPTY_FORM);
  const [taxCodeError, setTaxCodeError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const { setActiveCompanyId, activeCompanyId, refreshCompanies } = useCompany();
  const router = useRouter();

  const loadCompanies = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Company[] }>('/companies');
      setCompanies(res.data.data);
    } catch {
      setError('Không thể tải danh sách công ty');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCompanies();
  }, [loadCompanies]);

  // Auto-open create modal when user has no companies (first login)
  useEffect(() => {
    if (!loading && companies.length === 0) {
      openCreate();
    }
    // Run only after initial load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const openCreate = () => {
    setEditTarget(null);
    setForm(EMPTY_FORM);
    setError('');
    setTaxCodeError('');
    setShowModal(true);
  };

  const openEdit = (c: Company) => {
    setEditTarget(c);
    setForm({
      name: c.name,
      tax_code: c.tax_code,
      address: c.address ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      company_type: c.company_type,
      fiscal_year_start: c.fiscal_year_start,
    });
    setError('');
    setTaxCodeError('');
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const tcErr = validateTaxCode(form.tax_code, form.company_type);
    if (tcErr) {
      setTaxCodeError(tcErr);
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      if (editTarget) {
        await apiClient.put(`/companies/${editTarget.id}`, form);
      } else {
        const res = await apiClient.post<{ data: Company }>('/companies', form);
        // New company: go to onboarding
        const newId = res.data?.data?.id;
        if (newId) {
          // Pass newId directly so refreshCompanies sets it as active.
          // Do NOT call setActiveCompanyId(newId) separately — it uses a stale
          // closure where companies doesn't yet include the newly created company.
          await refreshCompanies(newId);
          router.push('/onboarding');
          return;
        }
      }
      await loadCompanies();
      await refreshCompanies();
      setShowModal(false);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? 'Có lỗi xảy ra';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || !deletePassword) return;
    setDeleteError('');
    setDeleteSubmitting(true);
    try {
      await apiClient.delete(`/companies/${deleteTarget.id}`, { data: { password: deletePassword } });
      // If the deleted company was active, clear the active selection
      if (deleteTarget.id === activeCompanyId) {
        setActiveCompanyId('');
      }
      await loadCompanies();
      await refreshCompanies();
      setDeleteTarget(null);
      setDeletePassword('');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? 'Có lỗi xảy ra, vui lòng thử lại';
      setDeleteError(msg);
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const handleSwitch = (id: string) => {
    setActiveCompanyId(id);
    router.push('/dashboard');
  };

  return (
    <div className="max-w-2xl lg:max-w-5xl mx-auto px-4 py-6">
      <BackButton fallbackHref="/dashboard" className="mb-4" />
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Quản lý công ty</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 bg-primary-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-primary-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Thêm công ty
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : companies.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">🏢</p>
          <p>Bạn chưa có công ty nào</p>
        </div>
      ) : (
        <div className="space-y-3">
          {companies.map((c) => (
            <div
              key={c.id}
              className={`bg-white rounded-xl border p-4 ${
                c.id === activeCompanyId ? 'border-primary-300 ring-1 ring-primary-200' : 'border-gray-100'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-primary-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                    {c.name[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900 text-sm">{c.name}</p>
                    <p className="text-xs text-gray-500">MST: {c.tax_code}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
                        {COMPANY_TYPE_LABELS[c.company_type] ?? c.company_type}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        c.role === 'OWNER'
                          ? 'bg-amber-100 text-amber-700'
                          : c.role === 'ADMIN'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {c.role}
                      </span>
                      {!c.onboarded && (
                        <span
                          className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full cursor-help"
                          title="Công ty chưa hoàn tất thiết lập kết nối với nhà cung cấp hóa đơn (MISA / Viettel / GDT). Nhấn biểu tượng chỉnh sửa để tiếp tục cài đặt."
                        >
                          Chưa kết nối
                        </span>
                      )}
                      {c.id === activeCompanyId && (
                        <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">
                          Đang chọn
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {c.id !== activeCompanyId && (
                    <button
                      onClick={() => handleSwitch(c.id)}
                      className="text-xs text-primary-600 hover:bg-primary-50 px-2.5 py-1.5 rounded-lg transition-colors"
                    >
                      Chọn
                    </button>
                  )}
                  {['OWNER', 'ADMIN'].includes(c.role) && (
                    <button
                      onClick={() => openEdit(c)}
                      className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                  )}
                  {c.role === 'OWNER' && (
                    <button
                      onClick={() => setDeleteTarget(c)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4">
          <div className="bg-white w-full max-w-md rounded-2xl shadow-xl">
            <form onSubmit={(e) => void handleSubmit(e)}>
              <div className="p-5 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">
                  {editTarget ? 'Sửa thông tin công ty' : 'Thêm công ty mới'}
                </h2>
              </div>

              <div className="p-5 space-y-4">
                {error && (
                  <div className="bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{error}</div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Tên công ty *</label>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                    placeholder="Công ty TNHH ABC"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    {form.company_type === 'household' ? 'MST / Giấy tờ tùy thân *' : 'Mã số thuế *'}
                  </label>
                  <input
                    required
                    value={form.tax_code}
                    onChange={(e) => {
                      const val = e.target.value;
                      setForm({ ...form, tax_code: val });
                      setTaxCodeError(validateTaxCode(val, form.company_type));
                    }}
                    className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 ${
                      taxCodeError
                        ? 'border-red-400 focus:ring-red-300'
                        : 'border-amber-400 focus:ring-amber-400'
                    }`}
                    placeholder={form.company_type === 'household' ? '0123456789 / CMND / CCCD' : '0123456789'}
                  />
                  {taxCodeError ? (
                    <p className="mt-1.5 text-xs text-red-600 font-medium">{taxCodeError}</p>
                  ) : !editTarget ? (
                    <div className="mt-1.5 flex items-start gap-1.5 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-xs text-amber-800">
                      <span className="text-base leading-none mt-0.5">&#9888;&#xFE0F;</span>
                      <span>
                        <strong>Mã số thuế phải chính xác.</strong>{' '}
                        {form.company_type === 'household'
                          ? 'Hộ kinh doanh có thể nhập MST (10 số), CMND (9 số), CCCD (12 số) hoặc giấy tờ tùy thân khác (11 số).'
                          : 'Hệ thống dùng MST này để đăng nhập cổng thuế GDT tự động đồng bộ hóa đơn. Sai MST sẽ không kết nối được.'}
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Loại hình DN</label>
                    <select
                      value={form.company_type}
                      onChange={(e) => {
                        const newType = e.target.value as typeof form.company_type;
                        setForm({ ...form, company_type: newType });
                        setTaxCodeError(validateTaxCode(form.tax_code, newType));
                      }}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                    >
                      {Object.entries(COMPANY_TYPE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Tháng đầu năm TK</label>
                    <select
                      value={form.fiscal_year_start}
                      onChange={(e) => setForm({ ...form, fiscal_year_start: Number(e.target.value) })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                    >
                      {MONTHS.map((m, i) => (
                        <option key={i + 1} value={i + 1}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Địa chỉ</label>
                  <input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                    placeholder="Số nhà, đường, quận/huyện, tỉnh/thành"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Điện thoại</label>
                    <input
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                      placeholder="0901234567"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
                      placeholder="ketoan@congty.vn"
                    />
                  </div>
                </div>
              </div>

              <div className="p-5 border-t border-gray-100 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 border border-gray-200 text-gray-600 py-2.5 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
                >
                  Huỷ
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 bg-primary-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-primary-700 disabled:opacity-60 transition-colors"
                >
                  {submitting ? 'Đang lưu...' : editTarget ? 'Lưu thay đổi' : 'Thêm công ty'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Xóa vĩnh viễn công ty?</h3>
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
              <p className="text-sm text-red-700 font-medium mb-1">⚠️ Cảnh báo: Không thể hoàn tác!</p>
              <p className="text-sm text-red-600">
                Toàn bộ dữ liệu của <strong>{deleteTarget.name}</strong> sẽ bị xóa vĩnh viễn, bao gồm:
                hóa đơn, tờ khai thuế, sổ tiền mặt, báo cáo KQKD, cấu hình bot và tất cả dữ liệu liên quan.
              </p>
            </div>

            {/* Password confirmation */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Nhập mật khẩu của bạn để xác nhận xóa
              </label>
              <input
                type="password"
                value={deletePassword}
                onChange={(e) => { setDeletePassword(e.target.value); setDeleteError(''); }}
                placeholder="Mật khẩu hiện tại"
                autoComplete="current-password"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
              />
              {deleteError && (
                <p className="mt-1.5 text-xs text-red-600 font-medium">{deleteError}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setDeleteTarget(null); setDeletePassword(''); setDeleteError(''); }}
                className="flex-1 border border-gray-200 py-2.5 rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleDelete()}
                disabled={!deletePassword || deleteSubmitting}
                className="flex-1 bg-red-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleteSubmitting ? 'Đang xóa...' : 'Xóa vĩnh viễn'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
