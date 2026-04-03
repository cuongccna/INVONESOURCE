'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';
import { formatVND } from '../../../../utils/formatCurrency';

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface FlagDetail {
  code?: string;
  level?: string;
  message?: string;
  details?: Record<string, unknown>;
  acknowledge_note?: string;
  acknowledged_at?: string;
}

interface RiskFlag {
  id: string;
  tax_code: string;
  partner_type: 'seller' | 'buyer';
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  flag_types: string[];
  flag_details: FlagDetail[] | null;
  total_vat_at_risk: number;
  is_acknowledged: boolean;
  acknowledged_at: string | null;
  invoice_count: number;
  created_at: string;
  // from JOIN with company_verification_cache
  company_name: string | null;
  verified_status: string | null;
  address: string | null;
  registered_date: string | null;
  legal_rep: string | null;
}

interface GhostSummary {
  critical: number;
  high: number;
  medium: number;
  total_vat_at_risk: number;
  acknowledged: number;
  total: number;
}

/* ─── Constants ──────────────────────────────────────────────────────────── */
const LEVEL_BORDER: Record<string, string> = {
  critical: 'border-l-red-600',
  high:     'border-l-orange-500',
  medium:   'border-l-amber-400',
  low:      'border-l-blue-400',
};
const LEVEL_BADGE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  high:     'bg-orange-100 text-orange-700',
  medium:   'bg-amber-100 text-amber-700',
  low:      'bg-blue-100 text-blue-700',
};
const LEVEL_LABEL: Record<string, string> = {
  critical: 'Nghiêm trọng',
  high:     'Cảnh báo',
  medium:   'Lưu ý',
  low:      'Theo dõi',
};
const FLAG_ICON: Record<string, string> = {
  MST_NOT_FOUND:       '🚫',
  MST_DISSOLVED:       '🪦',
  MST_SUSPENDED:       '⛔',
  NAME_MISMATCH:       '⚠️',
  NEW_COMPANY_BIG_INV: '🔔',
  SPLIT_INVOICE:       '✂️',
  ROUND_AMOUNTS:       '🔢',
  HIGH_FREQUENCY:      '📈',
  ZERO_HISTORY:        '📋',
};
const FLAG_DEFAULT_MSG: Record<string, string> = {
  MST_NOT_FOUND:       'MST không tồn tại trên hệ thống GDT — hóa đơn có thể bị từ chối khấu trừ',
  MST_DISSOLVED:       'Doanh nghiệp đã giải thể hoặc phá sản — không hợp lệ để khấu trừ thuế đầu vào',
  MST_SUSPENDED:       'Doanh nghiệp đang tạm ngừng kinh doanh — cần xác minh trước khi kê khai',
  NAME_MISMATCH:       'Tên trên hóa đơn không khớp với tên đăng ký MST — dấu hiệu gian lận',
  NEW_COMPANY_BIG_INV: 'Doanh nghiệp mới thành lập (< 1 năm) với giá trị hóa đơn lớn — rủi ro cao',
  SPLIT_INVOICE:       'Nhiều hóa đơn giống nhau chia nhỏ dưới 20 triệu để né quy định thanh toán không dùng tiền mặt',
  ROUND_AMOUNTS:       'Nhiều hóa đơn có số tiền tròn bất thường — dấu hiệu lập hóa đơn khống',
  HIGH_FREQUENCY:      'Tần suất xuất hóa đơn bất thường trong thời gian ngắn',
  ZERO_HISTORY:        'Không có lịch sử giao dịch trước đây với đối tác này',
};
const MST_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  active:           { label: 'Đang hoạt động', cls: 'bg-green-100 text-green-700' },
  dissolved:        { label: 'Đã giải thể',     cls: 'bg-red-100 text-red-700' },
  suspended:        { label: 'Tạm ngừng',        cls: 'bg-orange-100 text-orange-700' },
  not_found:        { label: 'Không tìm thấy',   cls: 'bg-gray-100 text-gray-600' },
  pending:          { label: 'Chờ xác minh',      cls: 'bg-yellow-100 text-yellow-700' },
};
const TABS = [
  { key: 'active',       label: 'Tất cả chưa xử lý' },
  { key: 'critical',     label: '🔴 Nghiêm trọng' },
  { key: 'high',         label: '🟠 Cảnh báo' },
  { key: 'medium',       label: '🟡 Lưu ý' },
  { key: 'acknowledged', label: '✅ Đã kiểm tra' },
];

/* ─── Main Component ─────────────────────────────────────────────────────── */
export default function GhostCompaniesPage() {
  const [flags, setFlags]         = useState<RiskFlag[]>([]);
  const [loading, setLoading]     = useState(true);
  const [scanning, setScanning]   = useState(false);
  const [summary, setSummary]     = useState<GhostSummary | null>(null);
  const [filter, setFilter]       = useState<string>('active');
  const [page, setPage]           = useState(1);
  const [total, setTotal]         = useState(0);
  const [expandedInfo, setExpandedInfo] = useState<Set<string>>(new Set());
  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [explainOpen, setExplainOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('ghost-explain-open') !== 'false'; }
    catch { return true; }
  });
  const [ackModal, setAckModal]   = useState<{ open: boolean; flag: RiskFlag | null }>({ open: false, flag: null });
  const [ackNote, setAckNote]     = useState('');
  const [ackConfirmed, setAckConfirmed] = useState(false);
  const [ackSaving, setAckSaving] = useState(false);
  const PAGE_SIZE = 20;

  /* ── Load summary ── */
  const loadSummary = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: GhostSummary }>('/audit/ghost-companies/summary');
      setSummary(res.data.data);
    } catch { /* silent */ }
  }, []);

  /* ── Load flags list ── */
  const load = useCallback(async (p = page, f = filter) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
      if (f === 'acknowledged') {
        // no riskLevel filter, but unacknowledged=false means we want acknowledged ones
        params.set('unacknowledged', 'false');
      } else {
        params.set('unacknowledged', 'true');
        if (f !== 'active') params.set('riskLevel', f);
      }
      const res = await apiClient.get<{ data: { data: RiskFlag[]; meta: { total: number } } }>(
        `/audit/ghost-companies?${params.toString()}`,
      );
      setFlags(res.data.data.data);
      setTotal(res.data.data.meta.total);
    } finally {
      setLoading(false);
    }
  }, [page, filter]);

  useEffect(() => { void load(page, filter); }, [filter, page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadSummary(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Actions ── */
  const runScan = async () => {
    setScanning(true);
    try {
      await apiClient.post('/audit/ghost-companies/scan', {});
      await Promise.all([load(1, filter), loadSummary()]);
    } finally {
      setScanning(false);
    }
  };

  const handleVerify = async (taxCode: string) => {
    setVerifying(prev => new Set(prev).add(taxCode));
    try {
      await apiClient.post(`/audit/ghost-companies/${taxCode}/verify`, {});
      await Promise.all([load(page, filter), loadSummary()]);
    } finally {
      setVerifying(prev => { const s = new Set(prev); s.delete(taxCode); return s; });
    }
  };

  const handleQuickAcknowledge = async (id: string) => {
    await apiClient.patch(`/audit/ghost-companies/${id}/acknowledge`, { note: '' });
    setFlags(prev => prev.filter(f => f.id !== id));
    void loadSummary();
  };

  const openAckModal = (flag: RiskFlag) => {
    setAckModal({ open: true, flag });
    setAckNote('');
    setAckConfirmed(false);
  };

  const submitAcknowledge = async () => {
    if (!ackModal.flag || !ackConfirmed) return;
    setAckSaving(true);
    try {
      await apiClient.patch(`/audit/ghost-companies/${ackModal.flag.id}/acknowledge`, { note: ackNote });
      setFlags(prev => prev.filter(f => f.id !== ackModal.flag!.id));
      setAckModal({ open: false, flag: null });
      void loadSummary();
    } finally {
      setAckSaving(false);
    }
  };

  const toggleInfo = (taxCode: string) =>
    setExpandedInfo(prev => {
      const s = new Set(prev);
      s.has(taxCode) ? s.delete(taxCode) : s.add(taxCode);
      return s;
    });

  const toggleExplain = () => {
    const next = !explainOpen;
    setExplainOpen(next);
    try { localStorage.setItem('ghost-explain-open', String(next)); } catch { /**/ }
  };

  /* ── Helpers ── */
  const getActiveFlagDetails = (f: RiskFlag): FlagDetail[] => {
    if (!f.flag_details) return f.flag_types.map(code => ({ code, message: FLAG_DEFAULT_MSG[code] }));
    const realFlags = f.flag_details.filter(d => Boolean(d.code) && !d.acknowledge_note);
    if (realFlags.length === 0) return f.flag_types.map(code => ({ code, message: FLAG_DEFAULT_MSG[code] }));
    return realFlags;
  };

  const mstInfo = (status: string | null) =>
    (status && MST_STATUS_LABEL[status]) ?? { label: status ?? 'Chưa kiểm tra', cls: 'bg-gray-100 text-gray-600' };

  const formatDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('vi-VN') : '—';

  /* ─────────────────────────────────── JSX ──────────────────────────────── */
  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Phát Hiện Công Ty Ma</h1>
          <p className="text-sm text-gray-500 mt-0.5">Kiểm tra MST đối tác qua GDT · cập nhật từ hệ thống thuế</p>
        </div>
        <button
          onClick={() => void runScan()}
          disabled={scanning}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {scanning ? '⏳ Đang quét...' : '🔍 Quét ngay'}
        </button>
      </div>

      {/* ── Summary Banner ── */}
      {summary && (summary.critical > 0 || summary.high > 0) && (
        <div className="bg-red-50 border border-red-300 rounded-xl p-4 flex items-start gap-3">
          <span className="text-2xl mt-0.5">🚨</span>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-red-800">
              Phát hiện {summary.critical + summary.high} nhà cung cấp có dấu hiệu bất thường
            </p>
            {summary.total_vat_at_risk > 0 && (
              <p className="text-sm text-red-700 mt-0.5">
                Tổng VAT đầu vào có thể bị loại khỏi khấu trừ:&nbsp;
                <strong>{formatVND(summary.total_vat_at_risk)}₫</strong>
              </p>
            )}
            <div className="flex gap-3 mt-2 text-xs font-medium">
              {summary.critical > 0 && (
                <span className="text-red-700">{summary.critical} nghiêm trọng</span>
              )}
              {summary.high > 0 && (
                <span className="text-orange-700">{summary.high} cảnh báo</span>
              )}
              {summary.medium > 0 && (
                <span className="text-amber-700">{summary.medium} lưu ý</span>
              )}
            </div>
          </div>
        </div>
      )}
      {summary && summary.critical === 0 && summary.high === 0 && summary.total > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-2">
          <span>✅</span>
          <p className="text-sm text-green-700 font-medium">Không phát hiện rủi ro nghiêm trọng</p>
        </div>
      )}

      {/* ── Explanation Card ── */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
        <button
          onClick={toggleExplain}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="font-semibold text-amber-800 text-sm">ℹ️ Công ty ma là gì? Rủi ro thuế như thế nào?</span>
          <span className="text-amber-600 text-lg">{explainOpen ? '▲' : '▼'}</span>
        </button>
        {explainOpen && (
          <div className="px-4 pb-4 text-sm text-amber-900 space-y-2">
            <p>
              <strong>Công ty ma</strong> là doanh nghiệp tồn tại trên giấy tờ nhưng không có hoạt động kinh doanh thực tế.
              Hóa đơn từ các công ty này thường bị GDT từ chối, dẫn đến <strong>xuất toán thuế đầu vào</strong>.
            </p>
            <p>
              <strong>Hậu quả:</strong> Bị truy thu toàn bộ VAT đã khấu trừ + phạt 20% + lãi chậm nộp.
              Trường hợp gian lận có thể bị truy tố hình sự.
            </p>
            <p>
              <strong>Hành động:</strong> Kiểm tra lại MST qua GDT trước mỗi kỳ kê khai. Chỉ đánh dấu "đã kiểm tra"
              sau khi nắm rõ rủi ro và có căn cứ hợp lý để chấp nhận.
            </p>
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setFilter(tab.key); setPage(1); }}
            className={`whitespace-nowrap px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filter === tab.key
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Flags List ── */}
      {loading ? (
        <div className="text-center py-10 text-gray-400">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
          <p className="mt-3 text-sm">Đang tải...</p>
        </div>
      ) : flags.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-100">
          <p className="text-3xl mb-2">✅</p>
          <p className="text-gray-600 font-medium">Không có kết quả cho bộ lọc này</p>
          <p className="text-sm text-gray-400 mt-1">
            {filter === 'active' ? 'Hãy nhấn "Quét ngay" để kiểm tra đối tác.' : 'Thử bộ lọc khác.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {flags.map(flag => {
            const activeFlags = getActiveFlagDetails(flag);
            const infoExpanded = expandedInfo.has(flag.tax_code);
            const mst = mstInfo(flag.verified_status);
            const isVerifying = verifying.has(flag.tax_code);
            const isAck = Boolean(flag.acknowledged_at);

            return (
              <div
                key={flag.id}
                className={`bg-white rounded-xl border-l-4 shadow-sm border border-gray-100 ${
                  LEVEL_BORDER[flag.risk_level] ?? ''
                } ${isAck ? 'opacity-60' : ''}`}
              >
                {/* Card Header */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* Company names */}
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${LEVEL_BADGE[flag.risk_level] ?? ''}`}>
                          {LEVEL_LABEL[flag.risk_level] ?? flag.risk_level}
                        </span>
                        <span className="font-mono text-sm font-semibold text-gray-700">{flag.tax_code}</span>
                        {mst && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${mst.cls}`}>
                            {mst.label}
                          </span>
                        )}
                        {isAck && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">✅ Đã kiểm tra</span>
                        )}
                      </div>

                      {/* GDT name vs invoice name */}
                      {flag.company_name ? (
                        <div className="mt-1.5 space-y-0.5">
                          <p className="text-sm font-semibold text-gray-800">{flag.company_name}
                            <span className="ml-1.5 text-xs text-gray-400 font-normal">(tên GDT)</span>
                          </p>
                        </div>
                      ) : (
                        <p className="mt-1.5 text-sm text-gray-400 italic">Chưa tìm thấy tên trên GDT</p>
                      )}

                      {/* VAT at risk */}
                      {Number(flag.total_vat_at_risk) > 0 && (
                        <p className="mt-1 text-base font-bold text-red-600">
                          VAT có thể bị loại: {formatVND(flag.total_vat_at_risk)}₫
                          {flag.invoice_count > 0 && (
                            <span className="ml-2 text-xs font-normal text-gray-500">({flag.invoice_count} hóa đơn)</span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Flag list */}
                  <div className="mt-3 space-y-2">
                    {activeFlags.map((fd, i) => {
                      const icon = fd.code ? (FLAG_ICON[fd.code] ?? '⚠️') : '⚠️';
                      const msg  = fd.message ?? (fd.code ? FLAG_DEFAULT_MSG[fd.code] : '');
                      return (
                        <div key={i} className="flex items-start gap-2">
                          <span className="text-base leading-none mt-0.5">{icon}</span>
                          <p className="text-sm text-gray-700">{msg}</p>
                        </div>
                      );
                    })}
                  </div>

                  {/* Collapsible company info */}
                  {(flag.address || flag.legal_rep || flag.registered_date) && (
                    <div className="mt-3">
                      <button
                        onClick={() => toggleInfo(flag.tax_code)}
                        className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                      >
                        {infoExpanded ? '▲ Ẩn' : '▼ Xem'} thông tin doanh nghiệp
                      </button>
                      {infoExpanded && (
                        <div className="mt-2 bg-gray-50 rounded-lg p-3 space-y-1.5 text-xs text-gray-700">
                          {flag.address && (
                            <div className="flex gap-2">
                              <span className="text-gray-400 shrink-0">Địa chỉ:</span>
                              <span>{flag.address}</span>
                            </div>
                          )}
                          {flag.legal_rep && (
                            <div className="flex gap-2">
                              <span className="text-gray-400 shrink-0">Đại diện:</span>
                              <span>{flag.legal_rep}</span>
                            </div>
                          )}
                          {flag.registered_date && (
                            <div className="flex gap-2">
                              <span className="text-gray-400 shrink-0">Ngày đăng ký:</span>
                              <span>{formatDate(flag.registered_date)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                {!isAck && (
                  <div className="border-t border-gray-100 px-4 py-3 flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/invoices?sellerTaxCode=${flag.tax_code}&direction=input`}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium"
                    >
                      📄 Xem hóa đơn
                    </Link>
                    <button
                      onClick={() => void handleVerify(flag.tax_code)}
                      disabled={isVerifying}
                      className="text-xs px-3 py-1.5 rounded-lg border border-blue-300 text-blue-600 hover:bg-blue-50 font-medium disabled:opacity-50"
                    >
                      {isVerifying ? '⏳ Đang kiểm tra...' : '🔄 Kiểm tra lại ngay'}
                    </button>
                    <button
                      onClick={() => openAckModal(flag)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 font-medium"
                    >
                      📝 Đánh dấu đã kiểm tra
                    </button>
                    <button
                      onClick={() => void handleQuickAcknowledge(flag.id)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 font-medium"
                    >
                      Bỏ qua toàn bộ HĐ
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Pagination ── */}
      {total > PAGE_SIZE && (
        <div className="flex justify-center items-center gap-2 pt-2">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            ← Trước
          </button>
          <span className="text-sm text-gray-500">{page} / {Math.ceil(total / PAGE_SIZE)}</span>
          <button
            disabled={page >= Math.ceil(total / PAGE_SIZE)}
            onClick={() => setPage(p => p + 1)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            Sau →
          </button>
        </div>
      )}

      {/* ── Warning Box ── */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-xs text-gray-600 space-y-1">
        <p className="font-semibold text-gray-700">⚠️ Lưu ý quan trọng</p>
        <p>
          Dữ liệu MST được lấy từ&nbsp;
          <span className="font-mono">tracuunnt.gdt.gov.vn</span> và được lưu cache trong <strong>30 ngày</strong>.
          Bấm <strong>"Kiểm tra lại ngay"</strong> trước khi nộp tờ khai thuế để cập nhật trạng thái mới nhất.
        </p>
        <p>
          Việc đánh dấu "đã kiểm tra" có nghĩa bạn đã xem xét và <strong>chấp nhận rủi ro</strong> liên quan đến hóa đơn này.
        </p>
      </div>

      {/* ── Acknowledge Modal ── */}
      {ackModal.open && ackModal.flag && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
            <div>
              <h3 className="text-lg font-bold text-gray-900">Xác nhận đã kiểm tra</h3>
              <p className="text-sm text-gray-500 mt-1">
                {ackModal.flag.company_name ?? ackModal.flag.tax_code}
                &nbsp;·&nbsp;
                <span className={`text-xs px-1.5 py-0.5 rounded ${LEVEL_BADGE[ackModal.flag.risk_level] ?? ''}`}>
                  {LEVEL_LABEL[ackModal.flag.risk_level] ?? ackModal.flag.risk_level}
                </span>
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ghi chú kiểm tra (tùy chọn)
              </label>
              <textarea
                value={ackNote}
                onChange={e => setAckNote(e.target.value)}
                rows={3}
                placeholder="Ví dụ: Đã liên hệ nhà cung cấp, xác nhận hợp đồng hợp lệ..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={ackConfirmed}
                onChange={e => setAckConfirmed(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-blue-600 shrink-0"
              />
              <span className="text-sm text-gray-700">
                Tôi xác nhận đã kiểm tra và <strong>chấp nhận rủi ro</strong> liên quan đến MST&nbsp;
                <span className="font-mono">{ackModal.flag.tax_code}</span> này.
              </span>
            </label>

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setAckModal({ open: false, flag: null })}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Hủy
              </button>
              <button
                onClick={() => void submitAcknowledge()}
                disabled={!ackConfirmed || ackSaving}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {ackSaving ? 'Đang lưu...' : 'Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
