'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../../lib/apiClient';

/**
 * Cửa sổ "Hoá đơn gốc".
 *
 * Phân biệt rõ 3 thứ để người dùng không nhầm:
 *   1. Bản của NHÀ CUNG CẤP (Viettel S-Invoice, MISA meInvoice, VNPT…):
 *      PDF theo mẫu riêng của họ. Cổng thuế KHÔNG lưu file này — lấy trên cổng tra cứu
 *      của nhà cung cấp bằng "Mã tra cứu"/"Mã số bí mật" in trên hoá đơn.
 *   2. Bản thể hiện của CỔNG THUẾ: PDF dựng từ gói bản gốc mà hoadondientu.gdt.gov.vn
 *      phát hành — đúng dữ liệu, mẫu của cổng thuế.
 *   3. XML ký số: bản gốc hợp pháp (chữ ký người bán + chữ ký cấp mã CQT).
 */

type ViewState = 'loading' | 'ready' | 'waiting' | 'unavailable' | 'error';

interface ProviderInfo {
  tax_code: string;
  name: string;
  short_name: string | null;
  portal_url: string | null;
  code_label: string;
  note: string | null;
  known: boolean;
}

interface OriginalSources {
  provider: ProviderInfo | null;
  lookup_code: string | null;
  lookup_label: string | null;
  seller_tax_code: string | null;
  seller_name: string | null;
  invoice_label: string;
  provider_pdf: {
    status: string;
    has_pdf: boolean;
    size: number | null;
    source: string | null;
    error: string | null;
    automatable: boolean;
    connected: boolean;
  };
}

interface Props {
  invoiceId: string;
  /** Nhãn hiển thị trên tiêu đề, ví dụ "C26TAS-52" */
  label?: string;
  onClose: () => void;
  /** Gọi khi trạng thái bản gốc thay đổi để danh sách cập nhật badge */
  onStatusChange?: (status: string) => void;
}

const POLL_INTERVAL_MS = 12_000;
const MAX_POLLS = 25;   // ~5 phút

export default function OriginalInvoiceModal({ invoiceId, label, onClose, onStatusChange }: Props) {
  const [state, setState]     = useState<ViewState>('loading');
  const [pdfUrl, setPdfUrl]   = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  const [elapsed, setElapsed] = useState(0);
  const [sources, setSources] = useState<OriginalSources | null>(null);
  const [copied, setCopied]   = useState<string | null>(null);
  const cancelled = useRef(false);
  const objectUrl = useRef<string | null>(null);

  /** Thử tải PDF bản thể hiện. true = đã có file hoặc kết luận cuối cùng */
  const fetchPdf = useCallback(async (): Promise<boolean> => {
    const res = await apiClient.get(`/invoices/${invoiceId}/original-pdf`, {
      responseType: 'blob',
      validateStatus: s => s === 200 || s === 202 || s === 409 || s === 404,
    });

    if (res.status === 200) {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      const url = URL.createObjectURL(res.data as Blob);
      objectUrl.current = url;
      setPdfUrl(url);
      setState('ready');
      onStatusChange?.('available');
      return true;
    }

    let payload: { message?: string; error?: { message?: string } } = {};
    try { payload = JSON.parse(await (res.data as Blob).text()); } catch { /* bỏ qua */ }

    if (res.status === 409) {
      setMessage(payload.error?.message ?? 'Cổng thuế không lưu bản thể hiện của hoá đơn này.');
      setState('unavailable');
      onStatusChange?.('unavailable');
      return true;
    }

    setMessage(payload.message ?? 'Đang lấy bản gốc từ hệ thống thuế…');
    setState('waiting');
    onStatusChange?.('queued');
    return false;
  }, [invoiceId, onStatusChange]);

  // Nguồn bản gốc của nhà cung cấp — hiển thị ngay, không phụ thuộc việc render PDF
  useEffect(() => {
    apiClient.get<{ data: OriginalSources }>(`/invoices/${invoiceId}/original-sources`)
      .then(r => setSources(r.data.data))
      .catch(() => undefined);
  }, [invoiceId]);

  useEffect(() => {
    cancelled.current = false;

    (async () => {
      try {
        const done = await fetchPdf();
        if (done || cancelled.current) return;

        for (let i = 0; i < MAX_POLLS; i++) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          if (cancelled.current) return;
          setElapsed(e => e + POLL_INTERVAL_MS / 1000);

          const st = await apiClient.get<{ data: { statuses: Array<{
            pdf_status: string; has_pdf: boolean; pdf_error: string | null;
          }> } }>('/invoices/original-xml/status', { params: { ids: invoiceId } });
          const row = st.data.data.statuses[0];
          if (!row) continue;

          if (row.has_pdf) { await fetchPdf(); return; }
          if (row.pdf_status === 'unavailable') {
            setMessage(row.pdf_error ?? 'Cổng thuế không lưu bản thể hiện của hoá đơn này.');
            setState('unavailable');
            onStatusChange?.('unavailable');
            return;
          }
          if (row.pdf_status === 'failed') {
            setMessage(row.pdf_error ?? 'Tạo bản thể hiện thất bại — hệ thống sẽ tự thử lại.');
            setState('error');
            onStatusChange?.('failed');
            return;
          }
        }
        setMessage('Hệ thống thuế phản hồi chậm. Bản gốc vẫn đang được tải — bạn có thể đóng cửa sổ và quay lại sau.');
        setState('error');
      } catch {
        if (!cancelled.current) {
          setMessage('Không kết nối được máy chủ. Vui lòng thử lại.');
          setState('error');
        }
      }
    })();

    return () => {
      cancelled.current = true;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1800);
    } catch { /* trình duyệt chặn clipboard — người dùng bôi đen copy tay */ }
  };

  const download = (kind: 'pdf' | 'xml') => {
    const a = document.createElement('a');
    if (kind === 'pdf' && pdfUrl) {
      a.href = pdfUrl;
      a.download = `BanTheHien_${label ?? invoiceId}.pdf`;
    } else {
      const base = apiClient.defaults.baseURL ?? '';
      a.href = `${base}/invoices/${invoiceId}/original-${kind}`;
      a.target = '_blank';
    }
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const provider = sources?.provider ?? null;
  const providerLabel = provider?.short_name ?? provider?.name ?? null;
  const hasProviderPdf = sources?.provider_pdf?.has_pdf === true;
  const apiBase = apiClient.defaults.baseURL ?? '';

  const openProviderPdf = () => {
    window.open(`${apiBase}/invoices/${invoiceId}/provider-pdf`, '_blank', 'noopener');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-6"
         onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-5xl h-[92vh] flex flex-col shadow-2xl overflow-hidden"
           onClick={e => e.stopPropagation()}>

        {/* Thanh tiêu đề */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 truncate">
              Hoá đơn gốc {label ? `· ${label}` : ''}
            </p>
            <p className="text-xs text-gray-500">
              {providerLabel
                ? `Phát hành qua ${providerLabel}`
                : 'Nguồn dữ liệu: hệ thống hoá đơn điện tử của Tổng cục Thuế'}
            </p>
          </div>
          <div className="flex-1" />
          {state === 'ready' && (
            <>
              <button onClick={() => download('pdf')}
                className="text-xs font-medium border border-gray-300 text-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-50">
                ⬇ Tải bản thể hiện
              </button>
              <button onClick={() => download('xml')}
                title="File XML đã ký số — bản gốc hợp pháp để đối chiếu/nộp cơ quan thuế"
                className="text-xs font-medium border border-gray-300 text-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-50">
                ⬇ XML ký số
              </button>
            </>
          )}
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-700 rounded-lg px-2 py-1 text-xl leading-none">×</button>
        </div>

        {/* Bản gốc theo mẫu nhà cung cấp — cổng thuế không lưu file này */}
        <div className="px-4 py-3 bg-amber-50 border-b border-amber-200">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="font-semibold text-amber-900">
              📑 Bản gốc theo mẫu nhà cung cấp{providerLabel ? ` (${providerLabel})` : ''}
            </span>

            {hasProviderPdf && (
              <button onClick={openProviderPdf}
                className="inline-flex items-center gap-1 bg-emerald-600 text-white font-semibold rounded-lg px-3 py-1.5 hover:bg-emerald-700">
                ⬇ Tải PDF bản nhà cung cấp
                {sources?.provider_pdf?.size ? ` (${Math.round(sources.provider_pdf.size / 1024)} KB)` : ''}
              </button>
            )}

            {sources?.lookup_code ? (
              <>
                <span className="text-amber-900">
                  {sources.lookup_label ?? 'Mã tra cứu'}:{' '}
                  <code className="font-mono font-semibold bg-white border border-amber-300 rounded px-1.5 py-0.5">
                    {sources.lookup_code}
                  </code>
                </span>
                <button onClick={() => copy(sources.lookup_code!, 'code')}
                  className="text-amber-800 underline hover:text-amber-900">
                  {copied === 'code' ? '✓ đã chép' : 'chép mã'}
                </button>
              </>
            ) : (
              <span className="text-amber-800">
                Hoá đơn này không kèm mã tra cứu của nhà cung cấp trong XML
              </span>
            )}

            {sources?.seller_tax_code && (
              <>
                <span className="text-amber-900">
                  MST người bán:{' '}
                  <code className="font-mono bg-white border border-amber-300 rounded px-1.5 py-0.5">
                    {sources.seller_tax_code}
                  </code>
                </span>
                <button onClick={() => copy(sources.seller_tax_code!, 'mst')}
                  className="text-amber-800 underline hover:text-amber-900">
                  {copied === 'mst' ? '✓ đã chép' : 'chép MST'}
                </button>
              </>
            )}

            {provider?.portal_url && (
              <a href={provider.portal_url} target="_blank" rel="noopener noreferrer"
                 className="ml-auto inline-flex items-center gap-1 bg-amber-600 text-white font-semibold rounded-lg px-3 py-1.5 hover:bg-amber-700">
                Mở cổng tra cứu {provider.short_name ?? ''} ↗
              </a>
            )}
          </div>
          {provider?.note && (
            <p className="mt-1 text-[11px] text-amber-800">{provider.note}</p>
          )}
          {sources?.provider_pdf?.automatable && !sources.provider_pdf.connected && !hasProviderPdf && (
            <p className="mt-1 text-[11px] text-amber-800">
              💡 Hệ thống có thể tự tải bản PDF của {providerLabel ?? 'nhà cung cấp'} về đây —
              chỉ cần thêm tài khoản {providerLabel ?? ''} tại{' '}
              <a href="/settings/connectors" className="underline font-semibold">Cài đặt → Kết nối hoá đơn</a>.
            </p>
          )}
          {!provider?.portal_url && provider && (
            <p className="mt-1 text-[11px] text-amber-800">
              Nhà cung cấp: {provider.name} (MST {provider.tax_code}) — tra cứu trên website của đơn vị này
              bằng mã ở trên để tải PDF theo đúng mẫu của họ.
            </p>
          )}
        </div>

        {/* Bản thể hiện từ cổng thuế */}
        <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-[11px] text-gray-600">
          Dưới đây là <strong>bản thể hiện do cổng thuế phát hành</strong> (dữ liệu giống hệt hoá đơn gốc,
          mẫu trình bày của cổng thuế). Bản có dấu hiệu nhận diện thương hiệu của nhà cung cấp phải tải ở cổng phía trên.
        </div>

        {/* Nội dung */}
        <div className="flex-1 bg-gray-100">
          {state === 'ready' && pdfUrl && (
            <iframe src={pdfUrl} title="Bản thể hiện hoá đơn" className="w-full h-full border-0" />
          )}

          {(state === 'loading' || state === 'waiting') && (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
              <p className="text-sm font-medium text-gray-700">
                {state === 'loading' ? 'Đang mở bản thể hiện…' : 'Đang tải bản gốc từ hệ thống thuế…'}
              </p>
              <p className="text-xs text-gray-500 max-w-md">
                {message || 'Hệ thống đăng nhập cổng hoá đơn điện tử để lấy gói bản gốc. Thường mất 1–3 phút.'}
              </p>
              {elapsed > 0 && <p className="text-xs text-gray-400">Đã chờ {Math.round(elapsed)}s</p>}
            </div>
          )}

          {state === 'unavailable' && (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="text-4xl">🚫</span>
              <p className="text-sm font-semibold text-gray-800">Cổng thuế không lưu bản thể hiện</p>
              <p className="text-xs text-gray-600 max-w-md">{message}</p>
              <p className="text-xs text-gray-500 max-w-md">
                Hoá đơn không mã cơ quan thuế (nhóm 6) và hoá đơn máy tính tiền/uỷ nhiệm (nhóm 8)
                không được lưu file trên cổng tra cứu. Hãy dùng mã tra cứu ở trên để lấy bản của
                nhà cung cấp, hoặc xin file từ người bán.
              </p>
            </div>
          )}

          {state === 'error' && (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="text-4xl">⏳</span>
              <p className="text-sm font-semibold text-gray-800">Chưa lấy được bản thể hiện</p>
              <p className="text-xs text-gray-600 max-w-md">{message}</p>
              <button onClick={() => { setState('loading'); setElapsed(0); void fetchPdf(); }}
                className="text-xs font-medium border border-gray-300 rounded-lg px-3 py-1.5 text-gray-700 hover:bg-gray-50">
                Thử lại
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
