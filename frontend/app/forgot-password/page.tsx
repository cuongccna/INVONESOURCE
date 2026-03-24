'use client';

import { useState } from 'react';
import Link from 'next/link';
import apiClient from '../../lib/apiClient';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiClient.post<{ data: { resetToken?: string } }>('/auth/forgot-password', { email });
      setSent(true);
      if (res.data.data?.resetToken) {
        setDevToken(res.data.data.resetToken);
      }
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
          {sent ? (
            <div className="text-center space-y-4">
              <div className="text-4xl">✉️</div>
              <h2 className="text-lg font-bold text-gray-900">Đã gửi!</h2>
              <p className="text-sm text-gray-600">
                Nếu email <strong>{email}</strong> tồn tại, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu.
              </p>

              {devToken && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-left">
                  <p className="text-xs font-semibold text-yellow-700 mb-1">🛠 Dev mode — token:</p>
                  <Link
                    href={`/reset-password?token=${devToken}`}
                    className="text-xs text-blue-600 break-all underline"
                  >
                    /reset-password?token={devToken}
                  </Link>
                </div>
              )}

              <Link href="/login" className="block text-sm text-primary-600 font-medium mt-2">
                ← Quay lại đăng nhập
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-bold text-gray-900 mb-2">Quên Mật Khẩu</h2>
              <p className="text-sm text-gray-500 mb-6">
                Nhập email của bạn để nhận liên kết đặt lại mật khẩu.
              </p>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">
                  {error}
                </div>
              )}

              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="email@company.vn"
                    className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-primary-600 text-white rounded-xl py-3 font-semibold text-sm disabled:opacity-50"
                >
                  {loading ? 'Đang gửi...' : 'Gửi Liên Kết'}
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
