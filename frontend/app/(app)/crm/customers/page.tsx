'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';

type Segment = 'champions' | 'loyal' | 'at_risk' | 'new_customer' | 'big_spender' | 'lost' | 'other' | '';

interface SegmentSummary {
  segment: Segment;
  customer_count: string;
  total_revenue: string;
  avg_rfm: string;
}

interface Customer {
  id: string;
  buyer_tax_code: string;
  buyer_name: string;
  r_score: number; f_score: number; m_score: number;
  rfm_score: number;
  segment: Segment;
  last_invoice_date: string;
  invoice_count_12m: number;
  total_amount_12m: string;
}

interface CustomerInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: string;
  vat_amount: string;
}

const SEG_LABEL: Record<string, string> = {
  champions: 'Khách VIP', loyal: 'Trung thành', at_risk: 'Có nguy cơ',
  new_customer: 'Khách mới', big_spender: 'Chi lớn', lost: 'Đã rời', other: 'Khác',
};
const SEG_COLOR: Record<string, string> = {
  champions: 'bg-purple-100 text-purple-700', loyal: 'bg-blue-100 text-blue-700',
  at_risk: 'bg-red-100 text-red-600', new_customer: 'bg-green-100 text-green-700',
  big_spender: 'bg-amber-100 text-amber-700', lost: 'bg-gray-100 text-gray-500',
  other: 'bg-gray-50 text-gray-400',
};
const RFM_COLOR: Record<number, string> = { 5: 'bg-emerald-100 text-emerald-700', 4: 'bg-teal-100 text-teal-700', 3: 'bg-amber-100 text-amber-700', 2: 'bg-orange-100 text-orange-700', 1: 'bg-red-100 text-red-600' };
const compact = (n: number) => n.toLocaleString('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });
const fmtDate = (iso: string) => iso ? new Date(iso).toLocaleDateString('vi-VN') : '—';
const initials = (name: string) => name.trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase();

export default function CrmCustomersPage() {
  const [summary, setSummary] = useState<SegmentSummary[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [segment, setSegment] = useState<Segment>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);

  // Slide panel state
  const [panelCustomer, setPanelCustomer] = useState<Customer | null>(null);
  const [panelInvoices, setPanelInvoices] = useState<CustomerInvoice[]>([]);
  const [panelLoadingInv, setPanelLoadingInv] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [loadingAi, setLoadingAi] = useState(false);

  const loadSummary = async () => {
    try {
      const res = await apiClient.get<{ data: SegmentSummary[] }>('/crm/rfm/summary');
      setSummary(res.data.data);
    } catch { /* silent */ }
  };

  const loadCustomers = useCallback(async (seg: Segment, p: number) => {
    setLoading(true);
    try {
      const q = seg ? `&segment=${seg}` : '';
      const res = await apiClient.get<{ data: Customer[]; meta: { total: number } }>(
        `/crm/rfm?page=${p}&pageSize=50${q}`
      );
      setCustomers(res.data.data);
      setTotal(res.data.meta.total);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadSummary(); }, []);
  useEffect(() => { void loadCustomers(segment, page); }, [segment, page, loadCustomers]);

  const recalculate = async () => {
    setRecalculating(true);
    try {
      await apiClient.post('/crm/rfm/recalculate', {});
      await Promise.all([loadSummary(), loadCustomers(segment, page)]);
    } catch { /* silent */ } finally { setRecalculating(false); }
  };

  const openPanel = async (c: Customer) => {
    setPanelCustomer(c);
    setAiAnalysis(null);
    setPanelLoadingInv(true);
    try {
      const res = await apiClient.get<{ data: CustomerInvoice[] }>(
        `/invoices?buyerTaxCode=${c.buyer_tax_code}&pageSize=5`
      );
      setPanelInvoices(res.data.data);
    } catch {
      setPanelInvoices([]);
    } finally {
      setPanelLoadingInv(false);
    }
  };

  const analyzeWithAi = async (c: Customer) => {
    setLoadingAi(true);
    try {
      const res = await apiClient.post<{ data: { analysis: string } }>('/crm/rfm/analyze', {
        buyer_tax_code: c.buyer_tax_code,
        buyer_name: c.buyer_name,
        invoice_count_12m: c.invoice_count_12m,
        total_amount_12m: c.total_amount_12m,
        r_score: c.r_score, f_score: c.f_score, m_score: c.m_score,
        segment: c.segment,
      });
      setAiAnalysis(res.data.data.analysis);
    } catch {
      setAiAnalysis('Không thể phân tích lúc này. Vui lòng thử lại.');
    } finally {
      setLoadingAi(false);
    }
  };

  const totalRevenue = summary.reduce((s, r) => s + Number(r.total_revenue), 0);

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Phân Tích Khách Hàng</h1>
        <button onClick={recalculate} disabled={recalculating}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          {recalculating ? 'Đang tính…' : '↺ Tính lại RFM'}
        </button>
      </div>

      {/* Segment summary cards */}
      {summary.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {summary.map((s) => (
            <button key={s.segment} onClick={() => { setSegment(s.segment === segment ? '' : s.segment); setPage(1); }}
              className={`text-left bg-white rounded-xl shadow-sm p-3 border-2 transition-colors ${
                segment === s.segment ? 'border-primary-400' : 'border-transparent'
              }`}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SEG_COLOR[s.segment]}`}>
                  {SEG_LABEL[s.segment] ?? s.segment}
                </span>
                <span className="text-xs text-gray-400">{s.customer_count} KH</span>
              </div>
              <p className="text-base font-bold text-gray-900">{compact(Number(s.total_revenue))}₫</p>
              {totalRevenue > 0 && (
                <p className="text-xs text-gray-400">
                  {((Number(s.total_revenue) / totalRevenue) * 100).toFixed(1)}% tổng DT
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {(['', 'champions', 'loyal', 'at_risk', 'new_customer', 'big_spender', 'lost'] as Segment[]).map((s) => (
          <button key={s} onClick={() => { setSegment(s); setPage(1); }}
            className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              segment === s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {s === '' ? 'Tất cả' : (SEG_LABEL[s] ?? s)}
          </button>
        ))}
      </div>

      {/* Customer list */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-700">{total.toLocaleString('vi-VN')} khách hàng</p>
          <Link href="/crm/aging" className="text-xs text-primary-600 font-semibold">Xem công nợ →</Link>
        </div>
        {loading ? (
          <div className="flex justify-center py-10">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600" />
          </div>
        ) : customers.length === 0 ? (
          <p className="text-center text-sm text-gray-400 py-10">Chưa có dữ liệu phân tích</p>
        ) : (
          <div className="divide-y divide-gray-50">
            {customers.map((c) => (
              <button key={c.id} onClick={() => void openPanel(c)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 transition-colors">
                {/* Avatar */}
                <div className="shrink-0 w-9 h-9 rounded-full bg-primary-100 text-primary-700 font-bold text-sm flex items-center justify-center">
                  {initials(c.buyer_name || c.buyer_tax_code)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{c.buyer_name}</p>
                  <p className="text-xs text-gray-400 font-mono">{c.buyer_tax_code}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {[['R', c.r_score], ['F', c.f_score], ['M', c.m_score]].map(([label, score]) => (
                      <span key={label as string} className={`text-[9px] font-bold px-1 py-0 rounded ${RFM_COLOR[score as number] ?? 'bg-gray-50 text-gray-400'}`}>
                        {label}:{score}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-gray-900">{compact(Number(c.total_amount_12m))}₫</p>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SEG_COLOR[c.segment]}`}>
                    {SEG_LABEL[c.segment] ?? c.segment}
                  </span>
                  <p className="text-xs text-gray-400 mt-0.5">{c.invoice_count_12m} HĐ</p>
                </div>
              </button>
            ))}
          </div>
        )}
        {total > 50 && (
          <div className="px-4 py-3 flex justify-between border-t border-gray-100">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}
              className="text-xs px-3 py-1.5 rounded border border-gray-200 disabled:opacity-40">← Trước</button>
            <span className="text-xs text-gray-500">Trang {page} / {Math.ceil(total / 50)}</span>
            <button disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(page + 1)}
              className="text-xs px-3 py-1.5 rounded border border-gray-200 disabled:opacity-40">Sau →</button>
          </div>
        )}
      </div>

      {/* ── Customer detail slide panel ── */}
      {panelCustomer && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setPanelCustomer(null)} />

          {/* Panel — slides from bottom on mobile, right on desktop */}
          <div className="fixed inset-x-0 bottom-0 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-96 bg-white shadow-2xl z-50 flex flex-col rounded-t-2xl sm:rounded-none max-h-[85vh] sm:max-h-full overflow-y-auto">
            {/* Panel header */}
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary-100 text-primary-700 font-bold text-sm flex items-center justify-center">
                  {initials(panelCustomer.buyer_name || panelCustomer.buyer_tax_code)}
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900 leading-tight">{panelCustomer.buyer_name}</p>
                  <p className="text-xs text-gray-400 font-mono">{panelCustomer.buyer_tax_code}</p>
                </div>
              </div>
              <button onClick={() => setPanelCustomer(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Info section */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Thông tin</p>
                <div className="flex flex-wrap gap-2">
                  <span className={`text-xs font-bold px-2 py-1 rounded ${SEG_COLOR[panelCustomer.segment]}`}>
                    {SEG_LABEL[panelCustomer.segment] ?? panelCustomer.segment}
                  </span>
                  <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                    RFM: R{panelCustomer.r_score} F{panelCustomer.f_score} M{panelCustomer.m_score} = {panelCustomer.rfm_score}
                  </span>
                </div>
                <div className="mt-3 space-y-1 text-sm text-gray-600">
                  <p>Lần mua cuối:{' '}
                    <span className="font-medium text-gray-900">{fmtDate(panelCustomer.last_invoice_date)}</span>
                  </p>
                  <p>Tổng DT 12T:{' '}
                    <span className="font-bold text-gray-900">{compact(Number(panelCustomer.total_amount_12m))}₫</span>
                  </p>
                  <p>Số đơn 12T:{' '}
                    <span className="font-medium text-gray-900">{panelCustomer.invoice_count_12m}</span>
                  </p>
                </div>
              </div>

              {/* Invoice history */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Lịch Sử Mua Hàng</p>
                {panelLoadingInv ? (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin h-5 w-5 rounded-full border-b-2 border-primary-600" />
                  </div>
                ) : panelInvoices.length === 0 ? (
                  <p className="text-xs text-gray-400">Không có hóa đơn gần đây</p>
                ) : (
                  <div className="space-y-2">
                    {panelInvoices.map((inv) => (
                      <div key={inv.id} className="flex items-center justify-between text-xs border border-gray-100 rounded-lg px-3 py-2">
                        <div>
                          <p className="font-medium text-gray-800">{inv.invoice_number}</p>
                          <p className="text-gray-400">{fmtDate(inv.invoice_date)}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-gray-900">{compact(Number(inv.total_amount))}₫</p>
                          <p className="text-gray-400">VAT: {compact(Number(inv.vat_amount))}₫</p>
                        </div>
                      </div>
                    ))}
                    <Link href={`/invoices?buyerTaxCode=${panelCustomer.buyer_tax_code}`}
                      className="block text-center text-xs text-primary-600 hover:underline py-1">
                      Xem tất cả hóa đơn →
                    </Link>
                  </div>
                )}
              </div>

              {/* AI Analysis section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-gray-500 uppercase">Phân Tích AI (Gemini)</p>
                  {!aiAnalysis && (
                    <button onClick={() => void analyzeWithAi(panelCustomer)}
                      disabled={loadingAi}
                      className="text-xs px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-600 font-medium hover:bg-indigo-100 disabled:opacity-60">
                      {loadingAi ? 'Đang phân tích…' : '🤖 Phân tích'}
                    </button>
                  )}
                </div>
                {loadingAi && (
                  <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                    <div className="animate-spin h-4 w-4 rounded-full border-b-2 border-indigo-600" />
                    Gemini đang phân tích dữ liệu khách hàng...
                  </div>
                )}
                {aiAnalysis && (
                  <div className="bg-indigo-50 rounded-xl p-3 text-xs text-indigo-900 whitespace-pre-wrap leading-relaxed">
                    {aiAnalysis}
                  </div>
                )}
                {!aiAnalysis && !loadingAi && (
                  <p className="text-xs text-gray-400">Nhấn "Phân tích" để Gemini AI đánh giá hành vi mua hàng, rủi ro rời bỏ và đề xuất chiến lược.</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
