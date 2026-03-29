'use client';

import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ResponsiveContainer, ReferenceLine, Line, ComposedChart, CartesianGrid } from 'recharts';
import apiClient from '../../../../lib/apiClient';

interface ProductItem {
  product_code: string | null;
  product_name: string;
  unit: string | null;
  total_revenue: number;
  total_cost?: number;
  gross_profit?: number;
  margin_pct?: number;
  total_vat: number;
  quantity_sold: number;
  avg_unit_price: number;
  invoice_count: number;
  revenue_share_pct: number;
  cumulative_pct: number;
  abc_class: 'A' | 'B' | 'C';
  trend?: 'up' | 'down' | 'stable';
  last_purchase_date?: string;
}

interface ProfitData {
  items: ProductItem[];
  total_revenue: number;
  total_vat: number;
  total_items: number;
  period_month: number;
  period_year: number;
}

// BCG classification
type BcgClass = 'star' | 'cow' | 'question' | 'dog';
const BCG_ICON: Record<BcgClass, string> = { star: '⭐', cow: '🐄', question: '❓', dog: '🐕' };
const BCG_LABEL: Record<BcgClass, string> = { star: 'Đầu tư thêm', cow: 'Duy trì', question: 'Xem lại giá', dog: 'Cân nhắc dừng' };
const BCG_COLOR: Record<BcgClass, string> = { star: 'bg-emerald-100 text-emerald-700', cow: 'bg-blue-100 text-blue-700', question: 'bg-amber-100 text-amber-700', dog: 'bg-red-100 text-red-600' };
const BAR_COLOR_BCG: Record<BcgClass, string> = { star: '#10b981', cow: '#3b82f6', question: '#f59e0b', dog: '#ef4444' };

function classifyBcg(item: ProductItem, allItems: ProductItem[]): BcgClass {
  if (allItems.length === 0) return 'question';
  const maxRev = Math.max(...allItems.map((i) => i.total_revenue));
  const highRev = item.total_revenue >= maxRev * 0.3 || item.abc_class === 'A';
  const margin = item.margin_pct ?? (item.gross_profit != null ? (item.gross_profit / Math.max(1, item.total_revenue)) * 100 : null);
  const highMargin = margin != null ? margin >= 20 : item.abc_class !== 'C';
  const growing = item.trend === 'up' || item.abc_class === 'A';

  if (highRev && (highMargin || growing)) return 'star';
  if (highRev && !highMargin) return 'cow';
  if (!highRev && highMargin) return 'question';
  return 'dog';
}

const MARGIN_COLOR = (pct: number | null) => {
  if (pct == null) return 'text-gray-400';
  if (pct >= 30) return 'text-emerald-600 font-semibold';
  if (pct >= 10) return 'text-amber-600';
  return 'text-red-500';
};

import { formatVND, formatVNDShort, formatVNDFull } from '../../../../utils/formatCurrency';
import PeriodSelector, {
  type PeriodValue,
  defaultPeriod,
  periodToParams,
  periodLabel,
} from '../../../../components/PeriodSelector';

const fmt = formatVNDFull;
const fmtM = formatVNDShort;


export default function ProductProfitabilityPage() {
  const [data, setData] = useState<ProfitData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriod);
  const [filter, setFilter] = useState<'ALL' | BcgClass>('ALL');
  const [sortBy, setSortBy] = useState<'revenue' | 'margin' | 'profit'>('revenue');

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: ProfitData }>(`/products/profitability?${periodToParams(period)}`);
      setData(res.data.data);
    } catch { /* silent */ } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [period]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = data?.items ?? [];

  // Annotate with BCG
  const itemsWithBcg = items.map((i) => ({ ...i, bcg: classifyBcg(i, items) }));

  const visible = (filter === 'ALL' ? itemsWithBcg : itemsWithBcg.filter((i) => i.bcg === filter))
    .sort((a, b) => {
      if (sortBy === 'margin') return (b.margin_pct ?? 0) - (a.margin_pct ?? 0);
      if (sortBy === 'profit') return (b.gross_profit ?? 0) - (a.gross_profit ?? 0);
      return b.total_revenue - a.total_revenue;
    });

  // Top 20 for Pareto chart
  const chartItems = itemsWithBcg.slice(0, 20);

  // Dormant items (not in current period but recent purchase)
  const dormant = items.filter((i) => i.last_purchase_date && !i.quantity_sold);
  const dormantValue = dormant.reduce((s, i) => s + i.total_revenue, 0);

  // 80/20 insight
  const topPct = items.length > 0
    ? Math.round((items.filter((i) => i.abc_class === 'A').reduce((s, i) => s + i.total_revenue, 0) / Math.max(1, data?.total_revenue ?? 1)) * 100)
    : 0;

  // BCG counts
  const bcgCounts = { star: 0, cow: 0, question: 0, dog: 0 };
  itemsWithBcg.forEach((i) => { bcgCounts[i.bcg]++; });

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Lợi Nhuận Sản Phẩm</h1>
          <p className="text-sm text-gray-500">Phân tích BCG + hiệu quả kinh doanh · {periodLabel(period)}</p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodSelector value={period} onChange={setPeriod} />
          <button onClick={() => void load()}
            className="px-3 py-1.5 bg-gray-100 border border-gray-200 rounded-lg text-sm">
            🔄 Tính lại
          </button>
        </div>
      </div>

      {/* No line-items state */}
      {!loading && items.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400">
          <p className="text-3xl mb-3">📦</p>
          <p className="font-medium text-gray-600">Tính năng này cần dữ liệu chi tiết hàng hóa từ hóa đơn XML.</p>
          <p className="text-sm mt-1">Hệ thống đang trích xuất tự động. Quay lại sau lần đồng bộ tiếp theo.</p>
        </div>
      )}

      {/* 80/20 insight banner */}
      {items.length > 0 && (
        <div className="bg-gradient-to-r from-primary-50 to-indigo-50 border border-primary-100 rounded-xl p-4">
          <p className="text-sm font-semibold text-primary-800">
            📊 20% sản phẩm hàng đầu đóng góp <span className="text-primary-600">{topPct}%</span> doanh thu kỳ này
          </p>
          <p className="text-xs text-gray-500 mt-0.5">Tổng DT: {fmtM(data?.total_revenue ?? 0)}₫ · {data?.total_items} mặt hàng</p>
        </div>
      )}

      {/* BCG summary cards */}
      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(Object.entries(bcgCounts) as [BcgClass, number][]).map(([cls, count]) => (
            <button key={cls} onClick={() => setFilter(filter === cls ? 'ALL' : cls)}
              className={`rounded-xl p-3 text-left border-2 transition-colors ${
                filter === cls ? 'border-gray-800' : 'border-transparent bg-white shadow-sm'
              } ${BCG_COLOR[cls]}`}>
              <p className="text-xl mb-1">{BCG_ICON[cls]}</p>
              <p className="text-lg font-bold">{count}</p>
              <p className="text-xs font-medium">{BCG_LABEL[cls]}</p>
            </button>
          ))}
        </div>
      )}

      {/* Pareto chart */}
      {!loading && chartItems.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Top 20 Mặt Hàng — Doanh Thu + Tích Lũy</h2>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={chartItems} margin={{ top: 4, right: 8, bottom: 50, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="product_name" tick={{ fontSize: 9 }} angle={-40} textAnchor="end" interval={0} />
              <YAxis yAxisId="bar" tickFormatter={fmtM} tick={{ fontSize: 9 }} />
              <YAxis yAxisId="line" orientation="right" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 9 }} domain={[0, 100]} />
              <Tooltip formatter={(v: number, name: string) => [name === 'cumulative_pct' ? `${v}%` : `${fmt(v)}₫`, name === 'cumulative_pct' ? 'Tích lũy' : 'Doanh thu']} />
              <ReferenceLine yAxisId="bar" y={0} stroke="#e5e7eb" />
              <Bar yAxisId="bar" dataKey="total_revenue" radius={[3, 3, 0, 0]}>
                {chartItems.map((entry, i) => (
                  <Cell key={i} fill={BAR_COLOR_BCG[entry.bcg]} />
                ))}
              </Bar>
              <Line yAxisId="line" type="monotone" dataKey="cumulative_pct" stroke="#6366f1" strokeWidth={2} dot={false} name="Tích lũy" />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-3 justify-center mt-2">
            {(Object.entries(BCG_ICON) as [BcgClass, string][]).map(([cls, icon]) => (
              <span key={cls} className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded ${BCG_COLOR[cls]}`}>
                {icon} {BCG_LABEL[cls]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Filter + sort toolbar */}
      {items.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex gap-1.5">
            {([['ALL', 'Tất cả'], ['star', '⭐ Star'], ['cow', '🐄 Cash Cow'], ['question', '❓ Question'], ['dog', '🐕 Dog']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k as typeof filter)}
                className={`text-xs px-2.5 py-1 rounded-full transition-colors ${filter === k ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {label}
              </button>
            ))}
          </div>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1">
            <option value="revenue">Sắp xếp: Doanh thu</option>
            <option value="margin">Sắp xếp: Margin%</option>
            <option value="profit">Sắp xếp: LN gộp</option>
          </select>
        </div>
      )}

      {/* Product table */}
      {items.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary-500" />
            </div>
          ) : visible.length === 0 ? (
            <p className="text-center py-10 text-gray-400">Không có sản phẩm trong nhóm này</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Sản phẩm</th>
                    <th className="px-4 py-2 text-right">Doanh thu</th>
                    <th className="px-4 py-2 text-right">Giá vốn</th>
                    <th className="px-4 py-2 text-right">LN gộp</th>
                    <th className="px-4 py-2 text-right">Margin%</th>
                    <th className="px-4 py-2 text-center">Phân loại</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {visible.map((item, idx) => {
                    const margin = item.margin_pct ?? null;
                    return (
                      <tr key={idx} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-gray-900 truncate max-w-[200px]">{item.product_name}</p>
                          {item.product_code && <p className="text-xs text-gray-400">{item.product_code} {item.unit ? `· ${item.unit}` : ''}</p>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-gray-900">{fmtM(item.total_revenue)}₫</td>
                        <td className="px-4 py-2.5 text-right text-gray-500">{item.total_cost != null ? `${fmtM(item.total_cost)}₫` : '—'}</td>
                        <td className="px-4 py-2.5 text-right text-gray-600">{item.gross_profit != null ? `${fmtM(item.gross_profit)}₫` : '—'}</td>
                        <td className={`px-4 py-2.5 text-right ${MARGIN_COLOR(margin)}`}>
                          {margin != null ? `${margin.toFixed(1)}%` : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${BCG_COLOR[item.bcg]}`}>
                            {BCG_ICON[item.bcg]} {BCG_LABEL[item.bcg]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Dormant items alert */}
      {dormant.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-orange-800 mb-2">
            ❄️ Hàng Ngủ Đông — {dormant.length} mặt hàng đã nhập nhưng chưa bán trong 90 ngày
          </h2>
          {dormantValue > 0 && (
            <p className="text-xs text-orange-600 mb-2">
              Cảnh báo: tổng giá trị tồn ước tính {fmtM(dormantValue)}₫
            </p>
          )}
          <div className="space-y-1">
            {dormant.slice(0, 5).map((i, idx) => (
              <div key={idx} className="flex justify-between text-xs text-orange-700">
                <span className="truncate max-w-[200px]">{i.product_name}</span>
                <span>{i.last_purchase_date ? new Date(i.last_purchase_date).toLocaleDateString('vi-VN') : '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
