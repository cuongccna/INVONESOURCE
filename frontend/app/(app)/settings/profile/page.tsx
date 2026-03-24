'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import BackButton from '../../../../components/BackButton';

interface Profile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: string;
}

const ROLE_LABELS: Record<string, string> = {
  OWNER:      'Chủ sở hữu',
  ADMIN:      'Quản trị viên',
  ACCOUNTANT: 'Kế toán',
  VIEWER:     'Xem',
};

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  // Profile form state
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Password form state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiClient.get<{ data: Profile }>('/auth/me');
        const p = res.data.data;
        setProfile(p);
        setFullName(p.full_name ?? '');
        setPhone(p.phone ?? '');
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setProfileMsg(null);
    try {
      await apiClient.patch('/auth/me', { fullName, phone: phone || null });
      setProfileMsg({ type: 'ok', text: 'Đã lưu thông tin.' });
    } catch {
      setProfileMsg({ type: 'err', text: 'Lỗi cập nhật. Vui lòng thử lại.' });
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg(null);
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'err', text: 'Mật khẩu xác nhận không khớp.' });
      return;
    }
    if (newPassword.length < 8) {
      setPasswordMsg({ type: 'err', text: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
      return;
    }
    setSavingPassword(true);
    try {
      await apiClient.post('/auth/change-password', { currentPassword, newPassword });
      setPasswordMsg({ type: 'ok', text: 'Đổi mật khẩu thành công.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Lỗi đổi mật khẩu.';
      setPasswordMsg({ type: 'err', text: msg });
    } finally {
      setSavingPassword(false);
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
    <div className="p-4 max-w-lg mx-auto space-y-6">
      <div>
        <BackButton fallbackHref="/dashboard" className="mb-3" />
        <h1 className="text-2xl font-bold text-gray-900">Hồ sơ cá nhân</h1>
        <p className="text-sm text-gray-500 mt-1">{profile?.email}</p>
      </div>

      {/* Role badge */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Vai trò:</span>
        <span className="bg-primary-100 text-primary-700 text-xs font-semibold px-2.5 py-1 rounded-full">
          {ROLE_LABELS[profile?.role ?? ''] ?? profile?.role}
        </span>
      </div>

      {/* ── Profile info ── */}
      <form onSubmit={(e) => void saveProfile(e)} className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
        <h2 className="font-semibold text-gray-800">Thông tin cơ bản</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Họ và tên</label>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
            placeholder="Nguyễn Văn A"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Số điện thoại</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
            placeholder="0912 345 678"
          />
        </div>
        {profileMsg && (
          <p className={`text-sm font-medium ${profileMsg.type === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
            {profileMsg.text}
          </p>
        )}
        <button
          type="submit"
          disabled={savingProfile}
          className="w-full bg-primary-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-primary-700 disabled:opacity-60 transition-colors"
        >
          {savingProfile ? 'Đang lưu...' : 'Lưu thay đổi'}
        </button>
      </form>

      {/* ── Change password ── */}
      <form onSubmit={(e) => void changePassword(e)} className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
        <h2 className="font-semibold text-gray-800">Đổi mật khẩu</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Mật khẩu hiện tại</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
            autoComplete="current-password"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Mật khẩu mới</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
            autoComplete="new-password"
            required
            minLength={8}
          />
          <p className="text-xs text-gray-400 mt-1">Tối thiểu 8 ký tự</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Xác nhận mật khẩu mới</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-300"
            autoComplete="new-password"
            required
          />
        </div>
        {passwordMsg && (
          <p className={`text-sm font-medium ${passwordMsg.type === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
            {passwordMsg.text}
          </p>
        )}
        <button
          type="submit"
          disabled={savingPassword}
          className="w-full border border-primary-300 text-primary-700 py-2.5 rounded-xl text-sm font-medium hover:bg-primary-50 disabled:opacity-60 transition-colors"
        >
          {savingPassword ? 'Đang xử lý...' : 'Đổi mật khẩu'}
        </button>
      </form>

      {/* ── Account info ── */}
      <div className="bg-gray-50 rounded-xl p-4 text-sm text-gray-500 space-y-1">
        <p><span className="font-medium text-gray-700">Email:</span> {profile?.email}</p>
        <p><span className="font-medium text-gray-700">ID tài khoản:</span> <span className="font-mono text-xs">{profile?.id}</span></p>
      </div>
    </div>
  );
}
