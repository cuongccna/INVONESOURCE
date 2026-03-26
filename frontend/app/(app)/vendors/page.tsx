'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../../lib/apiClient';

interface Vendor {
  seller_tax_code: string;
  seller_name: string;
  invoice_count: string;
  total_spend: string;
  avg_per_invoice: string;
  last_invoice_date: string;
  price_trend?: 'up' | 'down' | 'stable' | 'new';
  has_price_alert?: boolean;
}

import { formatVND, formatVNDShort } from '../../../utils/formatCurrency';

const compact = formatVND;
const fmtM = formatVND;

const TREND_ICON: Record<string, string> = { up: '↑', down: '↓', stable: '→', new: 'MỚI' };
const TREND_CLASS: Record<string, string> = {
  up: 'text-red-600 font-bold',
  down: 'text-green-600 font-bold',
  stable: 'text-gray-400',
  new: 'bg-blue-100 text-blue-700 px-1 rounded',
};

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    setLoading(true);
    apiClient.get<{ data: Vendor[] }>(`/vendors?month=${month}&year=${year}`)
      .then((r) => setVendors(r.data.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [month, year]);

  const totalSpend = vendors.reduce((s, v) => s + Number(v.total_spend), 0);
  const activeCount = vendors.length;
  const alertCount = vendors.filter((v) => v.has_price_alert).length;
  const topVendor = vendors[0] ?? null;
  const topVendorPct = topVendor && totalSpend > 0
    ? ((Number(topVendor.total_spend) / totalSpend) * 100).toFixed(1)
    : '0';

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Nhà Cung Cấp</h1>
          {vendors.length > 0 && (
            <p className="text-sm text-gray-500 mt-0.5">
              {vendors.length} NCC · Tổng chi: {compact(totalSpend)}₫
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>T{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* KPI Cards */}
      {!loading && vendors.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl shadow-sm p-3">
            <p className="text-xs text-gray-400">NCC hoạt động</p>
            <p className="text-xl font-bold text-gray-900 mt-0.5">{activeCount}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-3">
            <p className="text-xs text-gray-400">Tổng chi tháng này</p>
            <p className="text-xl font-bold text-gray-900 mt-0.5">{compact(totalSpend)}₫</p>
          </div>
          <div className={`rounded-xl shadow-sm p-3 ${alertCount > 0 ? 'bg-amber-50' : 'bg-white'}`}>
            <p className="text-xs text-gray-400">Có cảnh báo giá</p>
            <p className={`text-xl font-bold mt-0.5 ${alertCount > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
              {alertCount}
            </p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-3">
            <p className="text-xs text-gray-400">NCC tỉ trọng cao nhất</p>
            <p className="text-sm font-bold text-gray-900 mt-0.5 truncate">{topVendor?.seller_name ?? '—'}</p>
            <p className="text-xs text-gray-400">{topVendorPct}%</p>
          </div>
        </div>
      )}

      {/* Alert banner */}
      {alertCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center justify-between">
          <p className="text-sm text-amber-700">
            ⚠️ {alertCount} mặt hàng có biến động giá đáng chú ý
          </p>
          <Link href="/vendors/price-alerts"
            className="text-xs font-semibold text-amber-700 underline whitespace-nowrap ml-2">
            Xem chi tiết →
          </Link>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary-600" />
        </div>
      ) : vendors.length === 0 ? (
        <div className="text-center py-16 text-gray-400">Chưa có dữ liệu nhà cung cấp</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="divide-y divide-gray-50">
            {vendors.map((v, i) => {
              const pct = totalSpend > 0 ? (Number(v.total_spend) / totalSpend) * 100 : 0;
              const risk = pct > 30 ? 'Cao' : pct > 10 ? 'TB' : 'Thấp';
              const riskColor = pct > 30 ? 'bg-red-100 text-red-600' : pct > 10 ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500';
              const trend = v.price_trend ?? 'stable';
              return (
                <div key={v.seller_tax_code} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-xs font-bold text-gray-500">
                      {(v.seller_name ?? '?').slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-gray-900 truncate">{v.seller_name}</p>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${riskColor}`}>
                          Rủi ro: {risk}
                        </span>
                        {trend !== 'stable' && (
                          <span className={`text-xs ${TREND_CLASS[trend]}`}>
                            {TREND_ICON[trend]}
                          </span>
                        )}
                        {v.has_price_alert && (
                          <span className="text-[10px] bg-amber-50 text-amber-700 px-1 py-0.5 rounded font-medium">⚠️ Giá</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 font-mono">{v.seller_tax_code}</p>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                          <div className="h-1.5 rounded-full bg-primary-400" style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="text-xs text-gray-400 w-10 text-right">{pct.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-gray-900">{compact(Number(v.total_spend))}₫</p>
                      <p className="text-xs text-gray-400">{v.invoice_count} HĐ</p>
                      <p className="text-xs text-gray-300">TB: {fmtM(Number(v.avg_per_invoice))}₫</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Price alerts CTA */}
      <div className="flex justify-end">
        <Link href="/vendors/price-alerts"
          className="text-xs px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 font-semibold hover:bg-amber-100">
          ⚠️ Xem cảnh báo giá thay đổi
        </Link>
      </div>
    </div>
  );
}

