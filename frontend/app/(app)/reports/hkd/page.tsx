'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';

/**
 * Sổ kế toán hộ kinh doanh — Thông tư 152/2025/TT-BTC.
 *
 * Không phải hộ nào cũng ghi cả 7 sổ: thông tư phân theo doanh thu năm và cách nộp
 * thuế TNCN. Màn hình này chỉ rõ hộ đang thuộc nhóm nào và phải ghi những sổ nào,
 * để người dùng không mở nhầm sổ không thuộc nghĩa vụ của mình.
 */

interface BookRequirement {
  code: string;
  name: string;
  required: boolean;
  reason: string;
}

interface RequiredBooks {
  year: number;
  annual_revenue: number;
  group: string;
  groupLabel: string;
  books: BookRequirement[];
  legalBasis: string;
}

const BOOK_TITLES: Record<string, string> = {
  s1a: 'S1a-HKD',
  s2a: 'S2a-HKD',
  s2b: 'S2b-HKD',
  s2c: 'S2c-HKD',
  s2d: 'S2d-HKD',
  s2e: 'S2e-HKD',
  s3a: 'S3a-HKD',
};

export default function HkdBooksPage() {
  const { activeCompany, activeCompanyId } = useCompany();
  const [data, setData] = useState<RequiredBooks | null>(null);
  const [loading, setLoading] = useState(true);
  const year = new Date().getFullYear();

  const load = useCallback(async () => {
    if (!activeCompanyId) return;
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: RequiredBooks }>(
        '/hkd-reports/required-books', { params: { year } });
      setData(res.data.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, year]);

  useEffect(() => { void load(); }, [load]);

  const fmt = (n: number) => n.toLocaleString('vi-VN');

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Sổ kế toán hộ kinh doanh</h1>
        <p className="text-sm text-gray-500">
          {activeCompany?.name} · Năm {year} — mẫu sổ theo Thông tư 152/2025/TT-BTC
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : !data ? (
        <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-6 text-sm text-gray-600 text-center">
          Chưa xác định được nhóm doanh thu. Hãy đồng bộ hoá đơn bán ra của năm {year} rồi quay lại.
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Doanh thu năm {year}</p>
                <p className="text-lg font-semibold text-gray-900 tabular-nums">{fmt(data.annual_revenue)}đ</p>
              </div>
              <div>
                <p className="text-xs text-gray-400 uppercase tracking-wide">Nhóm áp dụng</p>
                <p className="text-sm font-medium text-gray-800">{data.groupLabel}</p>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">Căn cứ: {data.legalBasis}</p>
          </div>

          <div className="space-y-2">
            {data.books.map((b) => (
              <div key={b.code}
                className={`flex items-start gap-3 border rounded-xl px-4 py-3 ${
                  b.required ? 'bg-white border-emerald-200' : 'bg-gray-50 border-gray-200'}`}>
                <span className={`mt-0.5 text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${
                  b.required ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-500'}`}>
                  {b.required ? 'Phải ghi' : 'Không bắt buộc'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold ${b.required ? 'text-gray-900' : 'text-gray-500'}`}>
                    {BOOK_TITLES[b.code] ?? b.code.toUpperCase()} — {b.name}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{b.reason}</p>
                </div>
                <Link href={`/reports/hkd/${b.code}`}
                  className={`text-xs font-semibold rounded-lg px-3 py-1.5 whitespace-nowrap ${
                    b.required
                      ? 'bg-primary-600 text-white hover:bg-primary-700'
                      : 'border border-gray-300 text-gray-600 hover:bg-gray-100'}`}>
                  Mở sổ
                </Link>
              </div>
            ))}
          </div>

          <p className="text-xs text-gray-500">
            Hộ có phát sinh thuế xuất khẩu, tiêu thụ đặc biệt, tài nguyên, bảo vệ môi trường hoặc
            sử dụng đất thì ghi thêm sổ S3a-HKD.
          </p>
        </>
      )}
    </div>
  );
}
