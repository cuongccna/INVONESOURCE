'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../../lib/apiClient';

/**
 * Cửa sổ "Hoá đơn gốc".
 *
 * Phân biệt rõ 3 thứ để người dùng không nhầm:
 *   1. Bản của NHÀ CUNG CẤP (Viettel, MISA, NewCA, EFY…):
 *      PDF theo mẫu riêng của họ. Cổng thuế KHÔNG lưu file này — lấy trên cổng tra cứu
 *      của nhà cung cấp bằng "Mã tra cứu"/"Mã số bí mật" in trên hoá đơn.
 *      Hệ thống tự tra hộ: cổng nào không có mã xác thực thì chạy một nhịp, cổng nào có
 *      thì hiện ảnh ngay tại đây cho người dùng nhập.
 *   2. Bản thể hiện của CỔNG THUẾ: PDF dựng từ gói bản gốc mà hoadondientu.gdt.gov.vn
 *      phát hành — đúng dữ liệu, mẫu của cổng thuế.
 *   3. XML ký số: bản gốc hợp pháp (chữ ký người bán + chữ ký cấp mã CQT).
 */

type ViewState = 'loading' | 'ready' | 'waiting' | 'unavailable' | 'error';
type Tab = 'provider' | 'gdt';

interface ProviderInfo {
  tax_code: string;
  name: string;
  short_name: string | null;
  portal_url: string | null;
  code_label: string;
  note: string | null;
  known: boolean;
}

interface PortalCapability {
  supported: boolean;
  driver_id: string | null;
  provider: string | null;
  needs_captcha: boolean;
  verified: boolean;
}

interface OriginalSources {
  provider: ProviderInfo | null;
  lookup_code: string | null;
  lookup_label: string | null;
  /** Cổng tra cứu đọc từ chính file hoá đơn; thiếu thì lấy từ danh bạ nhà cung cấp */
  lookup_url: string | null;
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
  portal_lookup: PortalCapability;
}

/** Phản hồi của /provider-lookup và /provider-lookup/captcha */
interface LookupOutcome {
  status: 'ready' | 'done' | 'captcha' | 'manual' | 'notfound' | 'error';
  message: string;
  size?: number | null;
  sessionId?: string;
  imageDataUrl?: string;
  hint?: string;
  attemptsLeft?: number;
  portalUrl?: string | null;
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

  // ── Bản gốc theo mẫu nhà cung cấp ─────────────────────────────────────────
  const [tab, setTab]                   = useState<Tab>('gdt');
  const [providerUrl, setProviderUrl]   = useState<string | null>(null);
  const [lookupBusy, setLookupBusy]     = useState(false);
  const [lookupNote, setLookupNote]     = useState<string>('');
  const [lookupFailed, setLookupFailed] = useState(false);
  const [captcha, setCaptcha]           = useState<LookupOutcome | null>(null);
  const [answer, setAnswer]             = useState('');

  // ── Dán link + mã tra cứu của người bán ───────────────────────────────────
  // Hoá đơn KHÔNG MÃ cơ quan thuế (Viettel, EFY, VNPT…) không có bản gốc trên hệ thống
  // thuế nên hệ thống không có XML để trích mã. Thứ người dùng luôn có là đoạn chữ người
  // bán gửi kèm hoá đơn — dán vào đây là hệ thống tra hộ được như mọi hoá đơn khác.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteErr,  setPasteErr]  = useState<string | null>(null);

  const cancelled  = useRef(false);
  const objectUrl  = useRef<string | null>(null);
  const providerObjectUrl = useRef<string | null>(null);

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

  /**
   * Tải file PDF của nhà cung cấp về để xem ngay trong cửa sổ.
   * Phải đi qua apiClient: token nằm trong bộ nhớ nên mở tab mới sẽ không có quyền.
   */
  const loadProviderPdf = useCallback(async (): Promise<boolean> => {
    const res = await apiClient.get(`/invoices/${invoiceId}/provider-pdf`, {
      responseType: 'blob',
      validateStatus: s => s === 200 || s === 409 || s === 404,
    });
    if (res.status !== 200) return false;
    if (providerObjectUrl.current) URL.revokeObjectURL(providerObjectUrl.current);
    const url = URL.createObjectURL(res.data as Blob);
    providerObjectUrl.current = url;
    setProviderUrl(url);
    setTab('provider');
    return true;
  }, [invoiceId]);

  /** Xử lý chung cho cả bước mở phiên lẫn bước gửi mã xác thực */
  const applyOutcome = useCallback(async (out: LookupOutcome) => {
    setLookupNote(out.message ?? '');
    if (out.status === 'captcha') {
      setCaptcha(out);
      setAnswer('');
      setLookupFailed(false);
      return;
    }
    setCaptcha(null);
    if (out.status === 'done' || out.status === 'ready') {
      setLookupFailed(false);
      const ok = await loadProviderPdf();
      if (!ok) {
        setLookupFailed(true);
        setLookupNote('Đã tải được bản gốc nhưng chưa mở được file — thử lại sau ít phút.');
      }
      return;
    }
    setLookupFailed(true);
  }, [loadProviderPdf]);

  const runLookup = useCallback(async (force = false) => {
    setLookupBusy(true);
    setLookupFailed(false);
    setLookupNote('Đang kết nối cổng tra cứu của nhà cung cấp…');
    try {
      const res = await apiClient.post<{ data: LookupOutcome }>(
        `/invoices/${invoiceId}/provider-lookup`, { force },
      );
      await applyOutcome(res.data.data);
    } catch {
      setLookupFailed(true);
      setLookupNote('Không kết nối được máy chủ. Vui lòng thử lại.');
    } finally {
      setLookupBusy(false);
    }
  }, [invoiceId, applyOutcome]);

  const sendCaptcha = useCallback(async () => {
    if (!captcha?.sessionId || !answer.trim()) return;
    setLookupBusy(true);
    setLookupNote('Đang gửi mã xác thực…');
    try {
      const res = await apiClient.post<{ data: LookupOutcome }>(
        '/invoices/provider-lookup/captcha',
        { sessionId: captcha.sessionId, answer: answer.trim() },
      );
      await applyOutcome(res.data.data);
    } catch {
      setLookupFailed(true);
      setLookupNote('Không gửi được mã xác thực. Vui lòng thử lại.');
    } finally {
      setLookupBusy(false);
    }
  }, [captcha, answer, applyOutcome]);

  // Nguồn bản gốc của nhà cung cấp — hiển thị ngay, không phụ thuộc việc render PDF
  useEffect(() => {
    apiClient.get<{ data: OriginalSources }>(`/invoices/${invoiceId}/original-sources`)
      .then(r => {
        setSources(r.data.data);
        // Đã có sẵn file của nhà cung cấp thì mở luôn — đó là thứ người dùng muốn xem
        if (r.data.data.provider_pdf?.has_pdf) void loadProviderPdf();
      })
      .catch(() => undefined);
  }, [invoiceId, loadProviderPdf]);

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
      if (providerObjectUrl.current) URL.revokeObjectURL(providerObjectUrl.current);
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

  /** Lưu đoạn "link + mã tra cứu" người dùng dán, rồi tra luôn nếu hệ thống hỗ trợ cổng đó */
  const savePastedLookup = useCallback(async () => {
    const text = pasteText.trim();
    if (!text || pasteBusy) return;
    setPasteBusy(true);
    setPasteErr(null);
    try {
      const res = await apiClient.patch<{ data: OriginalSources }>(
        `/invoices/${invoiceId}/lookup-info`, { text },
      );
      setSources(res.data.data);
      setPasteOpen(false);
      setPasteText('');
      if (res.data.data.portal_lookup?.supported) await runLookup(false);
      else setLookupNote('Đã lưu thông tin tra cứu — bấm "Mở cổng tra cứu" để lấy bản gốc.');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message;
      setPasteErr(msg ?? 'Không lưu được thông tin tra cứu. Kiểm tra lại nội dung vừa dán.');
    } finally {
      setPasteBusy(false);
    }
  }, [pasteText, pasteBusy, invoiceId, runLookup]);

  const downloadBlob = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  /**
   * Tải XML ký số.
   *
   * Phần lớn hoá đơn trong hệ thống là hoá đơn KHÔNG MÃ / uỷ nhiệm — cơ quan thuế không
   * lưu bản gốc, nên endpoint trả 409 (không có) hoặc 202 (đang xếp hàng tải). Trước đây
   * chỗ này không xử lý hai mã đó: axios ném lỗi, người dùng bấm nút thì không có gì xảy
   * ra mà cũng không biết vì sao. Nay nói rõ tình trạng.
   */
  const downloadXml = async () => {
    try {
      const res = await apiClient.get(`/invoices/${invoiceId}/original-xml`, {
        responseType: 'blob',
        validateStatus: s => s === 200 || s === 202 || s === 409,
      });
      if (res.status === 200) {
        const url = URL.createObjectURL(res.data as Blob);
        downloadBlob(url, `HoaDon_${label ?? invoiceId}.xml`);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return;
      }
      const text = await (res.data as Blob).text();
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      setLookupFailed(res.status === 409);
      setLookupNote(
        parsed.error?.message ?? parsed.message ??
        (res.status === 202
          ? 'Đang tải bản gốc từ hệ thống thuế — thử lại sau ít phút.'
          : 'Hoá đơn này không có XML gốc trên hệ thống thuế.'),
      );
    } catch {
      setLookupFailed(true);
      setLookupNote('Không tải được XML ký số. Vui lòng thử lại.');
    }
  };

  const provider = sources?.provider ?? null;
  const providerLabel = provider?.short_name ?? provider?.name ?? null;
  // Link in trong chính hoá đơn là nguồn chuẩn nhất; danh bạ chỉ là dự phòng
  const lookupUrl = sources?.lookup_url ?? provider?.portal_url ?? null;
  const canLookup = sources?.portal_lookup?.supported === true;
  const hasProviderPdf = !!providerUrl || sources?.provider_pdf?.has_pdf === true;

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
          {tab === 'provider' && providerUrl && (
            <button onClick={() => downloadBlob(providerUrl, `HoaDonGoc_${label ?? invoiceId}.pdf`)}
              className="text-xs font-medium border border-gray-300 text-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-50">
              ⬇ Tải bản nhà cung cấp
            </button>
          )}
          {tab === 'gdt' && state === 'ready' && pdfUrl && (
            <button onClick={() => downloadBlob(pdfUrl, `BanTheHien_${label ?? invoiceId}.pdf`)}
              className="text-xs font-medium border border-gray-300 text-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-50">
              ⬇ Tải bản thể hiện
            </button>
          )}
          <button onClick={() => void downloadXml()}
            title="File XML đã ký số — bản gốc hợp pháp để đối chiếu/nộp cơ quan thuế"
            className="text-xs font-medium border border-gray-300 text-gray-700 rounded-lg px-3 py-1.5 hover:bg-gray-50">
            ⬇ XML ký số
          </button>
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-700 rounded-lg px-2 py-1 text-xl leading-none">×</button>
        </div>

        {/* Bản gốc theo mẫu nhà cung cấp — cổng thuế không lưu file này */}
        <div className="px-4 py-3 bg-amber-50 border-b border-amber-200">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="font-semibold text-amber-900">
              📑 Bản gốc theo mẫu nhà cung cấp{providerLabel ? ` (${providerLabel})` : ''}
            </span>

            {/* Nút tra cứu tự động — chỉ hiện khi hệ thống thật sự tra được cổng đó */}
            {canLookup && !hasProviderPdf && !captcha && (
              <button onClick={() => void runLookup(false)} disabled={lookupBusy}
                className="inline-flex items-center gap-1 bg-emerald-600 text-white font-semibold rounded-lg px-3 py-1.5 hover:bg-emerald-700 disabled:opacity-60">
                {lookupBusy ? 'Đang tra cứu…' : '⤓ Lấy bản gốc từ nhà cung cấp'}
              </button>
            )}

            {hasProviderPdf && (
              <button onClick={() => setTab('provider')}
                className="inline-flex items-center gap-1 bg-emerald-600 text-white font-semibold rounded-lg px-3 py-1.5 hover:bg-emerald-700">
                ✓ Xem bản nhà cung cấp
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

            {!hasProviderPdf && (
              <button onClick={() => { setPasteOpen(o => !o); setPasteErr(null); }}
                className="text-amber-800 underline hover:text-amber-900">
                {sources?.lookup_code ? 'sửa link/mã tra cứu' : '+ dán link tra cứu của người bán'}
              </button>
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

            {lookupUrl && (
              <a href={lookupUrl} target="_blank" rel="noopener noreferrer"
                 className="ml-auto inline-flex items-center gap-1 bg-amber-600 text-white font-semibold rounded-lg px-3 py-1.5 hover:bg-amber-700">
                Mở cổng tra cứu {provider?.short_name ?? ''} ↗
              </a>
            )}
          </div>

          {/* Dán đoạn tra cứu người bán gửi kèm hoá đơn — đường duy nhất cho hoá đơn
              không mã cơ quan thuế, và cho các cổng cấp riêng theo từng tài khoản */}
          {pasteOpen && (
            <div className="mt-3 bg-white border border-amber-300 rounded-lg p-3">
              <p className="text-[11px] text-gray-600 mb-2">
                Dán nguyên đoạn tra cứu trong thư/hoá đơn người bán gửi — hệ thống tự tách
                link và mã. Ví dụ:{' '}
                <span className="font-mono text-gray-500">
                  …truy cập: https://…-tt78.vnpt-invoice.com.vn — Mã tra cứu hóa đơn: N2026V…
                </span>
              </p>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Dán link tra cứu và mã tra cứu vào đây"
                className="w-full text-xs font-mono border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <div className="mt-2 flex items-center gap-3">
                <button onClick={() => void savePastedLookup()} disabled={pasteBusy || !pasteText.trim()}
                  className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-3 py-2 hover:bg-emerald-700 disabled:opacity-60">
                  {pasteBusy ? 'Đang lưu…' : 'Lưu và tra cứu'}
                </button>
                <button onClick={() => { setPasteOpen(false); setPasteErr(null); }}
                  className="text-xs text-gray-500 underline hover:text-gray-700">
                  huỷ
                </button>
                {pasteErr && <span className="text-[11px] text-red-700">⚠ {pasteErr}</span>}
              </div>
            </div>
          )}

          {/* Ô nhập mã xác thực — cổng nào bắt captcha thì khách nhập ngay tại đây */}
          {captcha?.imageDataUrl && (
            <div className="mt-3 flex flex-wrap items-center gap-3 bg-white border border-amber-300 rounded-lg p-3">
              <div className="text-xs text-amber-900 font-semibold w-full sm:w-auto">
                Cổng {sources?.portal_lookup?.provider ?? 'nhà cung cấp'} yêu cầu mã xác thực:
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={captcha.imageDataUrl} alt="Mã xác thực của cổng tra cứu"
                   className="h-12 rounded border border-gray-300 bg-white" />
              <input
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void sendCaptcha(); }}
                autoFocus
                placeholder="Nhập mã trong ảnh"
                className="w-40 text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <button onClick={() => void sendCaptcha()} disabled={lookupBusy || !answer.trim()}
                className="text-xs font-semibold bg-emerald-600 text-white rounded-lg px-3 py-2 hover:bg-emerald-700 disabled:opacity-60">
                {lookupBusy ? 'Đang tra…' : 'Tra cứu'}
              </button>
              <button onClick={() => void runLookup(true)} disabled={lookupBusy}
                className="text-xs text-amber-800 underline hover:text-amber-900 disabled:opacity-60">
                đổi mã khác
              </button>
              <button onClick={() => { setCaptcha(null); setLookupNote(''); }}
                className="text-xs text-gray-500 underline hover:text-gray-700">
                bỏ qua
              </button>
              {captcha.hint && (
                <span className="text-[11px] text-gray-500 w-full">{captcha.hint}</span>
              )}
            </div>
          )}

          {lookupNote && (
            <p className={`mt-1 text-[11px] ${lookupFailed ? 'text-red-700' : 'text-amber-800'}`}>
              {lookupFailed ? '⚠ ' : ''}{lookupNote}
            </p>
          )}

          {lookupUrl && sources?.lookup_url === lookupUrl && (
            <p className="mt-1 text-[11px] text-amber-800">
              Cổng tra cứu lấy từ chính file hoá đơn: <span className="font-mono">{lookupUrl}</span>
            </p>
          )}
          {provider?.note && (
            <p className="mt-1 text-[11px] text-amber-800">{provider.note}</p>
          )}
          {!canLookup && !hasProviderPdf && sources?.lookup_code && (
            <p className="mt-1 text-[11px] text-amber-800">
              Hệ thống chưa tự tra được cổng của nhà cung cấp này — bấm “Mở cổng tra cứu”
              rồi dán mã ở trên để tải bản PDF theo đúng mẫu của họ.
            </p>
          )}
          {!lookupUrl && provider && (
            <p className="mt-1 text-[11px] text-amber-800">
              Nhà cung cấp: {provider.name}{provider.tax_code ? ` (MST ${provider.tax_code})` : ''} —
              hoá đơn không ghi kèm link tra cứu, tìm cổng tra cứu trên website của đơn vị này
              rồi nhập mã ở trên để tải PDF theo đúng mẫu của họ.
            </p>
          )}
        </div>

        {/* Chọn bản đang xem */}
        <div className="flex items-center gap-1 px-4 py-1.5 bg-gray-50 border-b border-gray-200">
          <button onClick={() => setTab('provider')} disabled={!providerUrl}
            className={`text-[11px] font-medium rounded-md px-2.5 py-1 ${
              tab === 'provider'
                ? 'bg-white border border-gray-300 text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-800 disabled:opacity-40 disabled:hover:text-gray-500'}`}>
            Bản nhà cung cấp{providerUrl ? '' : ' (chưa có)'}
          </button>
          <button onClick={() => setTab('gdt')}
            className={`text-[11px] font-medium rounded-md px-2.5 py-1 ${
              tab === 'gdt'
                ? 'bg-white border border-gray-300 text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-800'}`}>
            Bản thể hiện cổng thuế
          </button>
          <span className="text-[11px] text-gray-500 ml-2">
            {tab === 'provider'
              ? 'PDF theo đúng mẫu và logo của nhà cung cấp phát hành hoá đơn.'
              : 'Dữ liệu giống hệt hoá đơn gốc, trình bày theo mẫu của cổng thuế.'}
          </span>
        </div>

        {/* Nội dung */}
        <div className="flex-1 bg-gray-100">
          {tab === 'provider' && providerUrl && (
            <iframe src={providerUrl} title="Bản gốc theo mẫu nhà cung cấp"
                    className="w-full h-full border-0" />
          )}

          {tab === 'provider' && !providerUrl && (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="text-4xl">📑</span>
              <p className="text-sm font-semibold text-gray-800">Chưa có bản của nhà cung cấp</p>
              <p className="text-xs text-gray-600 max-w-md">
                {canLookup
                  ? 'Bấm “Lấy bản gốc từ nhà cung cấp” ở trên — hệ thống tự điền mã tra cứu và MST người bán, cổng nào cần mã xác thực sẽ hiện ảnh ngay tại đây.'
                  : 'Cổng thuế không lưu bản theo mẫu nhà cung cấp. Dùng mã tra cứu ở trên để tải trên cổng của họ.'}
              </p>
            </div>
          )}

          {tab === 'gdt' && state === 'ready' && pdfUrl && (
            <iframe src={pdfUrl} title="Bản thể hiện hoá đơn" className="w-full h-full border-0" />
          )}

          {tab === 'gdt' && (state === 'loading' || state === 'waiting') && (
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

          {tab === 'gdt' && state === 'unavailable' && (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="text-4xl">🚫</span>
              <p className="text-sm font-semibold text-gray-800">Cổng thuế không lưu bản thể hiện</p>
              <p className="text-xs text-gray-600 max-w-md">{message}</p>
              <p className="text-xs text-gray-500 max-w-md">
                Hoá đơn không mã cơ quan thuế (nhóm 6) và hoá đơn máy tính tiền/uỷ nhiệm (nhóm 8)
                không được lưu file trên cổng tra cứu. Hãy lấy bản của nhà cung cấp ở trên,
                hoặc xin file từ người bán.
              </p>
            </div>
          )}

          {tab === 'gdt' && state === 'error' && (
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
