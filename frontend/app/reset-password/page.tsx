'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import apiClient from '../../lib/apiClient';

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) setError('Liên kết không hợp lệ. Vui lòng yêu cầu lại.');
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Mật khẩu xác nhận không khớp');
      return;
    }
    if (newPassword.length < 8) {
      setError('Mật khẩu phải có ít nhất 8 ký tự');
      return;
    }

    setLoading(true);
    try {
      await apiClient.post('/auth/reset-password', { token, newPassword });
      setSuccess(true);
      setTimeout(() => router.push('/login'), 3000);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })
          ?.response?.data?.error?.message ?? 'Đã xảy ra lỗi, vui lòng thử lại';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">📄</div>
          <h1 className="text-3xl font-bold text-gray-900">HĐĐT</h1>
          <p className="text-gray-500 mt-1">Đặt Lại Mật Khẩu</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm p-6">
          {success ? (
            <div className="text-center space-y-4">
              <div className="text-4xl">✅</div>
              <h2 className="text-lg font-bold text-gray-900">Đặt lại thành công!</h2>
              <p className="text-sm text-gray-600">
                Mật khẩu đã được cập nhật. Đang chuyển hướng đến trang đăng nhập...
              </p>
              <Link href="/login" className="block text-sm text-primary-600 font-medium">
                Đăng nhập ngay →
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Mật Khẩu Mới</h2>
              <p className="text-sm text-gray-500 mb-6">Nhập mật khẩu mới cho tài khoản của bạn.</p>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">
                  {error}
                </div>
              )}

              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Mật khẩu mới</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    disabled={!token}
                    autoComplete="new-password"
                    placeholder="Ít nhất 8 ký tự"
                    className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Xác nhận mật khẩu</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={!token}
                    autoComplete="new-password"
                    placeholder="Nhập lại mật khẩu mới"
                    className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || !token}
                  className="w-full bg-primary-600 text-white rounded-xl py-3 font-semibold text-sm disabled:opacity-50"
                >
                  {loading ? 'Đang cập nhật...' : 'Đặt Lại Mật Khẩu'}
                </button>
              </form>

              <div className="text-center mt-4">
                <Link href="/login" className="text-sm text-gray-500 hover:text-gray-700">
                  ← Quay lại đăng nhập
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Đang tải...</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
