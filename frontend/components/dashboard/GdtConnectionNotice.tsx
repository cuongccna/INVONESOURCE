'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../lib/apiClient';
import { useCompany } from '../../contexts/CompanyContext';
import { useView } from '../../contexts/ViewContext';

interface GdtConnection {
  companyId:   string;
  companyName: string;
  taxCode:     string | null;
  checkedAt:   string | null;
  status:      'ok' | 'error' | 'unknown';
  fixBy:       'user' | 'system' | null;
  code:        string | null;
  message:     string | null;
}

function fmtCheckedAt(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  });
}

/**
 * Thông báo nhỏ trên trang chủ khi kết nối tới cổng thuế GDT có vấn đề.
 * Không hiện gì khi mọi thứ bình thường. Dữ liệu từ lần chẩn đoán tự động hằng ngày.
 */
export function GdtConnectionNotice() {
  const { activeCompanyId } = useCompany();
  const { mode } = useView();
  const [items, setItems] = useState<GdtConnection[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiClient.get<{ data: { companies: GdtConnection[] } }>('/bot/users/me/gdt-connection')
      .then(r => { if (!cancelled) setItems(r.data.data.companies); })
      .catch(() => { /* thông báo phụ — lỗi tải không làm hỏng dashboard */ });
    return () => { cancelled = true; };
  }, [activeCompanyId]);

  const errors = items.filter(c =>
    c.status === 'error' && (mode !== 'single' || c.companyId === activeCompanyId));
  if (errors.length === 0) return null;

  const needsUser = errors.some(e => e.fixBy === 'user');
  const tone = needsUser
    ? { box: 'bg-red-50 border-red-200', title: 'text-red-800', text: 'text-red-700' }
    : { box: 'bg-amber-50 border-amber-200', title: 'text-amber-800', text: 'text-amber-700' };

  // Một công ty: hiện nguyên thông điệp. Nhiều công ty (group/portfolio): gom gọn.
  if (errors.length === 1) {
    const e = errors[0]!;
    return (
      <div className={`rounded-xl border px-4 py-2.5 ${tone.box}`} role="status">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className={`text-sm font-semibold ${tone.title}`}>
              ⚠ Kết nối cổng thuế GDT gặp sự cố{mode !== 'single' ? ` — ${e.companyName}` : ''}
            </p>
            <p className={`text-xs ${tone.text}`}>
              {e.message}
              {e.checkedAt && <span className="opacity-70"> (kiểm tra lúc {fmtCheckedAt(e.checkedAt)})</span>}
            </p>
          </div>
          {e.fixBy === 'user' && (
            <Link href="/settings/bot" className="shrink-0 rounded-md bg-white border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
              Kiểm tra tài khoản GDT
            </Link>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border px-4 py-2.5 ${tone.box}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${tone.title}`}>⚠ {errors.length} công ty đang gặp sự cố kết nối cổng thuế GDT</p>
          <ul className={`mt-0.5 space-y-0.5 text-xs ${tone.text}`}>
            {errors.slice(0, 4).map(e => (
              <li key={e.companyId} className="truncate">
                <b>{e.companyName}</b>: {e.fixBy === 'user' ? 'cần cập nhật tài khoản GDT' : 'sự cố phía hệ thống, không cần thao tác'}
              </li>
            ))}
            {errors.length > 4 && <li>… và {errors.length - 4} công ty khác</li>}
          </ul>
        </div>
        {needsUser && (
          <Link href="/settings/bot" className="shrink-0 rounded-md bg-white border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
            Kiểm tra tài khoản GDT
          </Link>
        )}
      </div>
    </div>
  );
}
