'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import apiClient from '../../../../../../lib/apiClient';
import BackButton from '../../../../../../components/BackButton';

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface MonthlySummary {
  period: { month: number; year: number };
  company: { name: string; tax_code: string; address: string } | null;
  invoiceSummary: Array<{
    direction: string;
    invoice_count: string;
    subtotal: string;
    vat_total: string;
    total: string;
    valid_count: string;
    cancelled_count: string;
    unvalidated_count: string;
  }>;
  vatReconciliation: {
    output_vat: string;
    input_vat: string;
    payable_vat: string;
    carry_forward_vat: string;
  } | null;
  topCounterparties: Array<{
    direction: string;
    counterparty_name: string;
    counterparty_tax_code: string;
    invoice_count: string;
    total_amount: string;
  }>;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
import { formatVND, formatVNDFull } from '../../../../../../utils/formatCurrency';

const vnd = (n: string | number | undefined) => formatVNDFull(Number(n ?? 0));

const MONTH_NAMES = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
  'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];

/* ─── Main Page ───────────────────────────────────────────────────────────── */
export default function MonthlyReportPage() {
  const params = useParams<{ year: string; month: string }>();
  const router = useRouter();
  const month = Number(params.month);
  const year = Number(params.year);

  const [report, setReport] = useState<MonthlySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: MonthlySummary }>(
        `/reports/monthly-summary?month=${month}&year=${year}`
      );
      setReport(res.data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => { void load(); }, [load]);

  const goTo = (m: number, y: number) => router.push(`/reports/monthly/${y}/${m}`);

  const prevMonth = month === 1 ? { m: 12, y: year - 1 } : { m: month - 1, y: year };
  const nextMonth = month === 12 ? { m: 1, y: year + 1 } : { m: month + 1, y: year };
  const isCurrentOrFuture = year > new Date().getFullYear() ||
    (year === new Date().getFullYear() && month >= new Date().getMonth() + 1);

  const outputRow = report?.invoiceSummary.find((r) => r.direction === 'output');
  const inputRow  = report?.invoiceSummary.find((r) => r.direction === 'input');
  const vat = report?.vatReconciliation;

  const topCustomers = report?.topCounterparties.filter((r) => r.direction === 'output') ?? [];
  const topSuppliers  = report?.topCounterparties.filter((r) => r.direction === 'input')  ?? [];

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <>
      {/* ── Print styles ── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
        }
      `}</style>

      <div className="p-4 max-w-2xl mx-auto space-y-5">
        <div className="no-print">
          <BackButton fallbackHref="/reports" />
        </div>

        {/* ── Nav ── */}
        <div className="no-print flex items-center justify-between">
          <button
            onClick={() => goTo(prevMonth.m, prevMonth.y)}
            className="text-sm text-gray-500 hover:text-gray-800 flex items-center gap-1"
          >
            ← {MONTH_NAMES[prevMonth.m - 1]}/{prevMonth.y}
          </button>
          <h1 className="text-xl font-bold text-gray-900">
            {MONTH_NAMES[month - 1]} {year}
          </h1>
          {!isCurrentOrFuture && (
            <button
              onClick={() => goTo(nextMonth.m, nextMonth.y)}
              className="text-sm text-gray-500 hover:text-gray-800 flex items-center gap-1"
            >
              {MONTH_NAMES[nextMonth.m - 1]}/{nextMonth.y} →
            </button>
          )}
          {isCurrentOrFuture && <div />}
        </div>

        {/* ── Print button ── */}
        <div className="no-print flex justify-end">
          <button
            onClick={() => window.print()}
            className="bg-gray-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-gray-900"
          >
            🖨 In báo cáo
          </button>
        </div>

        {/* ── Header (print only) ── */}
        <div className="hidden print:block text-center mb-4">
          <p className="text-xs text-gray-500">BÁO CÁO TÌNH HÌNH HÓA ĐƠN</p>
          <h2 className="text-lg font-bold">{MONTH_NAMES[month - 1].toUpperCase()} {year}</h2>
          {report?.company && (
            <p className="text-sm">{report.company.name} — MST: {report.company.tax_code}</p>
          )}
        </div>

        {/* ── Company block ── */}
        {report?.company && (
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <p className="font-bold text-gray-900">{report.company.name}</p>
            <p className="text-sm text-gray-500">MST: {report.company.tax_code}</p>
            {report.company.address && (
              <p className="text-sm text-gray-500">{report.company.address}</p>
            )}
          </div>
        )}

        {/* ── Invoice summary table ── */}
        <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
          <p className="px-4 pt-4 text-sm font-semibold text-gray-700">Tổng hợp hóa đơn</p>
          <table className="w-full min-w-[480px] text-sm mt-3">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-2">Loại</th>
                <th className="text-right px-4 py-2">Số lượng</th>
                <th className="text-right px-4 py-2">Tiền hàng</th>
                <th className="text-right px-4 py-2">Thuế GTGT</th>
                <th className="text-right px-4 py-2">Tổng tiền</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-50">
                <td className="px-4 py-3 font-medium text-blue-700">↑ Bán ra (đầu ra)</td>
                <td className="px-4 py-3 text-right tabular-nums">{outputRow?.invoice_count ?? 0}</td>
                <td className="px-4 py-3 text-right tabular-nums">{vnd(outputRow?.subtotal)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{vnd(outputRow?.vat_total)}</td>
                <td className="px-4 py-3 text-right tabular-nums font-semibold">{vnd(outputRow?.total)}</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium text-green-700">↓ Mua vào (đầu vào)</td>
                <td className="px-4 py-3 text-right tabular-nums">{inputRow?.invoice_count ?? 0}</td>
                <td className="px-4 py-3 text-right tabular-nums">{vnd(inputRow?.subtotal)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{vnd(inputRow?.vat_total)}</td>
                <td className="px-4 py-3 text-right tabular-nums font-semibold">{vnd(inputRow?.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── VAT reconciliation ── */}
        {vat ? (
          <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
            <p className="text-sm font-semibold text-gray-700">Đối chiếu thuế GTGT</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-blue-50 rounded-xl p-3">
                <p className="text-xs text-gray-500 mb-0.5">Thuế đầu ra</p>
                <p className="font-bold text-blue-700">{vnd(vat.output_vat)}</p>
              </div>
              <div className="bg-green-50 rounded-xl p-3">
                <p className="text-xs text-gray-500 mb-0.5">Thuế đầu vào</p>
                <p className="font-bold text-green-700">{vnd(vat.input_vat)}</p>
              </div>
              {Number(vat.payable_vat) > 0 && (
                <div className="bg-red-50 rounded-xl p-3 col-span-2">
                  <p className="text-xs text-gray-500 mb-0.5">Phải nộp [41]</p>
                  <p className="font-bold text-red-600 text-xl">{vnd(vat.payable_vat)}</p>
                </div>
              )}
              {Number(vat.carry_forward_vat) > 0 && (
                <div className="bg-emerald-50 rounded-xl p-3 col-span-2">
                  <p className="text-xs text-gray-500 mb-0.5">Kết chuyển sang kỳ sau [43]</p>
                  <p className="font-bold text-emerald-700 text-xl">{vnd(vat.carry_forward_vat)}</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4 text-sm text-yellow-700">
            Chưa có dữ liệu đối chiếu thuế GTGT cho kỳ này. Vui lòng tính tờ khai tại{' '}
            <a href="/declarations" className="underline font-medium">Tờ Khai</a>.
          </div>
        )}

        {/* ── Top counterparties ── */}
        {topCustomers.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Khách hàng lớn nhất</p>
            <div className="space-y-2">
              {topCustomers.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-800">{r.counterparty_name}</p>
                    <p className="text-xs text-gray-400 font-mono">{r.counterparty_tax_code}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-semibold text-gray-900">{vnd(r.total_amount)}</p>
                    <p className="text-xs text-gray-400">{r.invoice_count} HĐ</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {topSuppliers.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Nhà cung cấp lớn nhất</p>
            <div className="space-y-2">
              {topSuppliers.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-800">{r.counterparty_name}</p>
                    <p className="text-xs text-gray-400 font-mono">{r.counterparty_tax_code}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-semibold text-gray-900">{vnd(r.total_amount)}</p>
                    <p className="text-xs text-gray-400">{r.invoice_count} HĐ</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Data quality ── */}
        {(outputRow || inputRow) && (
          <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-2">
            <p className="text-sm font-semibold text-gray-700">Chất lượng dữ liệu</p>
            {outputRow && Number(outputRow.unvalidated_count) > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">HĐ đầu ra chưa xác nhận GDT</span>
                <span className="font-semibold text-yellow-600">{outputRow.unvalidated_count}</span>
              </div>
            )}
            {inputRow && Number(inputRow.unvalidated_count) > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">HĐ đầu vào chưa xác nhận GDT</span>
                <span className="font-semibold text-yellow-600">{inputRow.unvalidated_count}</span>
              </div>
            )}
            {Number(outputRow?.unvalidated_count ?? 0) === 0 && Number(inputRow?.unvalidated_count ?? 0) === 0 && (
              <p className="text-sm text-green-600">✓ Tất cả hóa đơn đều đã được xác nhận GDT</p>
            )}
          </div>
        )}

        {/* ── Footer ── */}
        <div className="no-print pb-4" />
      </div>
    </>
  );
}
