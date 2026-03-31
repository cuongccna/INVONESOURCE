'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '../../../lib/apiClient';
import BackButton from '../../../components/BackButton';
import { formatVND } from '../../../utils/formatCurrency';

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface ParsedPreview {
  fileId:        string;
  format:        string;
  formatLabel:   string;
  totalRows:     number;
  validRows:     number;
  duplicateRows: number;
  errorRows:     number;
  direction:     'input' | 'output' | 'both' | null;
  preview:       PreviewRow[];
  errors:        ParseError[];
  zipFiles?:     ZipFileInfo[];
}

interface ZipFileInfo {
  filename:     string;
  invoiceCount: number;
  errorCount:   number;
  error:        string | null;
}

interface PreviewRow {
  invoice_number:  string | null;
  invoice_date:    string | null;
  seller_name:     string | null;
  buyer_name:      string | null;
  total_amount:    number | null;
  vat_amount:      number | null;
  direction:       'input' | 'output' | null;
  status:          string | null;
  error:           string | null;
}

interface ParseError {
  row:     number;
  field:   string;
  message: string;
}

const FORMAT_LABELS: Record<string, string> = {
  gdt_xml:      'XML từ cổng thuế GDT',
  gdt_excel:    'Excel từ cổng thuế GDT',
  csv:          'CSV',
  htkk_xml:     'XML chuẩn HTKK',
  custom_excel: 'Excel tùy chỉnh',
};

/* ─── Hướng dẫn stepper ───────────────────────────────────────────────────── */
function GuideModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const steps = [
    {
      title: 'Đăng nhập cổng thuế',
      content: (
        <div className="space-y-2 text-sm text-gray-700">
          <p>Truy cập <strong className="text-blue-700">https://hoadondientu.gdt.gov.vn</strong></p>
          <p>Đăng nhập bằng <strong>Mã số thuế (MST)</strong> và <strong>mật khẩu cổng thuế</strong> của doanh nghiệp.</p>
          <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-800">
            💡 Đây là tài khoản NNT (Người Nộp Thuế) — khác với tài khoản MISA/Viettel/BKAV.
          </div>
        </div>
      ),
    },
    {
      title: 'Chọn loại hóa đơn',
      content: (
        <div className="space-y-2 text-sm text-gray-700">
          <p>Sau khi đăng nhập, vào menu <strong>Tra cứu</strong>:</p>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li><strong>Hóa đơn bán ra</strong> → cho HĐ đầu ra (khách hàng)</li>
            <li><strong>Hóa đơn mua vào</strong> → cho HĐ đầu vào (nhà cung cấp)</li>
          </ul>
          <div className="bg-amber-50 rounded-lg p-3 text-xs text-amber-800">
            ⚠️ Cần xuất <strong>2 file riêng</strong> — một cho đầu vào, một cho đầu ra.
          </div>
        </div>
      ),
    },
    {
      title: 'Đặt khoảng thời gian',
      content: (
        <div className="space-y-2 text-sm text-gray-700">
          <p>Nhập <strong>ngày từ</strong> và <strong>ngày đến</strong> cần truy xuất.</p>
          <div className="bg-green-50 rounded-lg p-3 text-xs text-green-800">
            💡 Khuyến nghị: không quá <strong>3 tháng mỗi lần</strong> để file không quá lớn và tải về nhanh hơn.
          </div>
        </div>
      ),
    },
    {
      title: 'Xuất file',
      content: (
        <div className="space-y-2 text-sm text-gray-700">
          <p>Nhấn nút <strong>&ldquo;Xuất XML&rdquo;</strong> để lấy file đầy đủ (bao gồm chi tiết hàng hóa từng dòng).</p>
          <p>Hoặc <strong>&ldquo;Xuất Excel&rdquo;</strong> nếu chỉ cần tổng hợp tháng.</p>
          <div className="bg-blue-50 rounded-lg p-3 text-xs text-blue-800">
            📄 File XML chứa nhiều thông tin hơn và cho phép phân tích chi tiết hàng hóa. Nên dùng XML khi có thể.
          </div>
        </div>
      ),
    },
    {
      title: 'Upload vào hệ thống',
      content: (
        <div className="space-y-2 text-sm text-gray-700">
          <p>Kéo file vừa tải về vào ô upload bên dưới hoặc click để chọn.</p>
          <p>Hệ thống tự động nhận diện định dạng và parse dữ liệu.</p>
          <div className="bg-purple-50 rounded-lg p-3 text-xs text-purple-800">
            🤖 <strong>Tiết kiệm thời gian:</strong> Thiết lập <a href="/settings/bot" className="underline font-medium">GDT Bot</a> để tự động đồng bộ mà không cần xuất thủ công.
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-gray-900">Hướng dẫn xuất file từ cổng thuế</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">✕</button>
          </div>

          {/* Dots */}
          <div className="flex gap-1.5 mb-5">
            {steps.map((_, i) => (
              <button key={i} onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-blue-600' : 'w-1.5 bg-gray-200'}`} />
            ))}
          </div>

          <div className="text-xs font-medium text-blue-600 mb-1">Bước {step + 1}/{steps.length}</div>
          <h3 className="font-semibold text-gray-900 mb-3">{steps[step].title}</h3>
          <div className="min-h-[120px]">{steps[step].content}</div>
        </div>

        <div className="flex gap-3 px-5 pb-5">
          <button onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0}
            className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm text-gray-700 disabled:opacity-40">
            ← Trước
          </button>
          {step < steps.length - 1 ? (
            <button onClick={() => setStep(s => s + 1)}
              className="flex-1 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-medium">
              Tiếp →
            </button>
          ) : (
            <button onClick={onClose}
              className="flex-1 bg-green-600 text-white rounded-xl py-2.5 text-sm font-medium">
              Bắt đầu upload ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────────────────── */
export default function ImportPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging]   = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [preview, setPreview]     = useState<ParsedPreview | null>(null);
  const [result, setResult]       = useState<{ success_count: number; duplicate_count: number; error_count: number; session_id: string } | null>(null);
  const [error, setError]         = useState<string | null>(null);

  // Import settings
  const [direction, setDirection]   = useState<'auto_detect' | 'input' | 'output' | 'both'>('auto_detect');
  const [dupPolicy, setDupPolicy]   = useState<'skip' | 'overwrite'>('skip');

  const uploadFile = useCallback(async (file: File) => {
    setError(null);
    setPreview(null);
    setResult(null);
    setUploading(true);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('direction', direction);

    try {
      const res = await apiClient.post<{ data: ParsedPreview }>('/import/preview', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setPreview(res.data.data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: { message?: string } } } };
      setError(e?.response?.data?.error?.message ?? 'Lỗi phân tích file. Kiểm tra định dạng.');
    } finally {
      setUploading(false);
    }
  }, [direction]);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void uploadFile(files[0]);
  };

  const executeImport = async () => {
    if (!preview) return;

    // Clear any previous error first
    setError(null);

    // Determine effective direction; XML files don't embed direction — user must pick
    const effectiveDirection =
      direction === 'output' || direction === 'input'
        ? direction
        : preview.direction === 'output' || preview.direction === 'input'
        ? preview.direction
        : null;

    if (!effectiveDirection) {
      setError('Vui lòng chọn chiều hóa đơn (Đầu ra hoặc Đầu vào) trước khi nhập.');
      return;
    }

    setImporting(true);
    setImportProgress(0);

    try {
      // Use SSE-based streaming endpoint for real-time progress
      const res = await fetch('/api/import/execute-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(typeof window !== 'undefined' && document.cookie
            ? {} : {}),
        },
        credentials: 'include',
        body: JSON.stringify({
          fileId:          preview.fileId,
          direction:       effectiveDirection,
          duplicatePolicy: dupPolicy,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error('Lỗi kết nối streaming');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6)) as Record<string, unknown>;

            if (data.type === 'progress') {
              setImportProgress(data.percent as number);
            } else if (data.type === 'complete') {
              setImportProgress(100);
              setResult({
                session_id:      data.session_id as string,
                success_count:   data.success_count as number,
                duplicate_count: data.duplicate_count as number,
                error_count:     data.error_count as number,
              });
              setPreview(null);
            }
          } catch { /* skip malformed events */ }
        }
      }
    } catch (err: unknown) {
      // Fallback: try regular endpoint if SSE fails
      try {
        const res2 = await apiClient.post<{ data: typeof result }>('/import/execute', {
          fileId:          preview.fileId,
          direction:       effectiveDirection,
          duplicatePolicy: dupPolicy,
        });
        setImportProgress(100);
        setResult(res2.data.data);
        setPreview(null);
      } catch (err2: unknown) {
        const e = err2 as { response?: { data?: { error?: { message?: string } } } };
        setError(e?.response?.data?.error?.message ?? 'Lỗi nhập hóa đơn.');
      }
    } finally {
      setImporting(false);
    }
  };

  const dirLabel = (d: string | null | undefined) => d === 'output' ? '↑ Đầu ra' : d === 'input' ? '↓ Đầu vào' : '';
  const statusColor = (s: string) => s === 'valid' ? 'text-green-700' : s === 'cancelled' ? 'text-red-500' : 'text-gray-500';

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto pb-24 space-y-5">
      <BackButton fallbackHref="/dashboard" />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Import Hóa Đơn</h1>
          <p className="text-sm text-gray-500">Nhập thủ công từ file XML / Excel / CSV cổng thuế</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowGuide(true)}
            className="text-xs border border-gray-300 rounded-lg px-3 py-1.5 text-gray-600 hover:bg-gray-50">
            ❓ Hướng dẫn
          </button>
          <button onClick={() => router.push('/import/history')}
            className="text-xs border border-gray-300 rounded-lg px-3 py-1.5 text-gray-600 hover:bg-gray-50">
            📋 Lịch sử
          </button>
        </div>
      </div>

      {showGuide && <GuideModal onClose={() => setShowGuide(false)} />}

      {/* ── Result ── */}
      {result && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3">
          <p className="font-bold text-green-800">✅ Nhập thành công {result.success_count} hóa đơn</p>
          <div className="flex gap-4 text-sm text-green-700">
            <span>{result.success_count} mới</span>
            <span>{result.duplicate_count} bỏ qua (trùng)</span>
            {result.error_count > 0 && <span className="text-red-600">{result.error_count} lỗi</span>}
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push(`/invoices?importSessionId=${result.session_id}`)}
              className="flex-1 bg-green-700 text-white text-sm rounded-xl py-2 font-medium">
              Xem hóa đơn vừa nhập
            </button>
            <button onClick={() => { setResult(null); setError(null); }}
              className="flex-1 border border-green-400 text-green-700 text-sm rounded-xl py-2">
              Nhập file khác
            </button>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          ⚠️ {error}
        </div>
      )}

      {!result && (
        <>
        {/* ── Upload zone ── */}
        <div
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
            dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-blue-300 hover:bg-gray-50'
          }`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        >
          <input ref={fileRef} type="file" className="hidden"
            accept=".xml,.xlsx,.xls,.csv,.zip"
            onChange={e => handleFiles(e.target.files)} />
          {uploading ? (
            <div className="space-y-2">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
              <p className="text-sm text-gray-500">Đang phân tích file...</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-4xl">☁️</div>
              <p className="font-medium text-gray-700">Kéo thả file hoặc click để chọn</p>
              <p className="text-xs text-gray-400">XML · Excel (xlsx) · CSV · ZIP (chứa XML) · Tối đa 50MB</p>
            </div>
          )}
        </div>

        {/* ── Settings ── */}
        {!preview && !uploading && (
          <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
            <p className="text-sm font-semibold text-gray-700">Cài đặt import</p>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Chiều hóa đơn</label>
              <select value={direction} onChange={e => setDirection(e.target.value as typeof direction)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                <option value="auto_detect">Tự động nhận diện từ file</option>
                <option value="output">Đầu ra (bán hàng)</option>
                <option value="input">Đầu vào (mua hàng)</option>
                <option value="both">Cả hai chiều</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">Xử lý trùng lặp</label>
              <select value={dupPolicy} onChange={e => setDupPolicy(e.target.value as typeof dupPolicy)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                <option value="skip">Bỏ qua HĐ đã tồn tại (khuyến nghị)</option>
                <option value="overwrite">Cập nhật nếu có thay đổi</option>
              </select>
            </div>
          </div>
        )}

        {/* ── Preview ── */}
        {preview && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full font-medium">
                  {preview.formatLabel ?? preview.format}
                </span>
                {(preview.direction === 'output' || preview.direction === 'input') && (
                  <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">
                    {dirLabel(preview.direction)}
                  </span>
                )}
              </div>
              {/* Direction picker when not yet determined (e.g. XML files) */}
              {(preview.direction === 'both' || preview.direction == null) && direction !== 'output' && direction !== 'input' && (
                <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-amber-700 font-medium mb-1">⚠️ Cần chọn chiều hóa đơn</p>
                  <div className="flex gap-2">
                    <button onClick={() => setDirection('output')}
                      className="flex-1 text-xs border border-gray-300 rounded-lg py-1.5 hover:bg-blue-50 hover:border-blue-400">
                      ↑ Đầu ra (bán hàng)
                    </button>
                    <button onClick={() => setDirection('input')}
                      className="flex-1 text-xs border border-gray-300 rounded-lg py-1.5 hover:bg-green-50 hover:border-green-400">
                      ↓ Đầu vào (mua hàng)
                    </button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-green-50 rounded-lg p-2">
                  <p className="text-lg font-bold text-green-700">{preview.validRows}</p>
                  <p className="text-xs text-gray-500">Hợp lệ</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="text-lg font-bold text-gray-600">{preview.duplicateRows}</p>
                  <p className="text-xs text-gray-500">Trùng lặp</p>
                </div>
                <div className={`rounded-lg p-2 ${preview.errorRows > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <p className={`text-lg font-bold ${preview.errorRows > 0 ? 'text-red-600' : 'text-gray-400'}`}>{preview.errorRows}</p>
                  <p className="text-xs text-gray-500">Lỗi</p>
                </div>
              </div>
            </div>

            {/* ZIP file breakdown */}
            {preview.zipFiles && preview.zipFiles.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
                  File trong ZIP ({preview.zipFiles.length} file XML)
                </p>
                <div className="space-y-1.5">
                  {preview.zipFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-gray-700 truncate max-w-[200px]" title={f.filename}>
                        📄 {f.filename}
                      </span>
                      {f.error ? (
                        <span className="text-red-500">❌ {f.error}</span>
                      ) : (
                        <span className="text-green-600">
                          ✅ {f.invoiceCount} HĐ
                          {f.errorCount > 0 && <span className="text-red-500 ml-1">({f.errorCount} lỗi)</span>}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Preview table */}
            <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
              <p className="px-4 pt-3 text-xs font-semibold text-gray-500 uppercase">Xem trước ({Math.min(5, preview.preview.length)} dòng đầu)</p>
              <table className="w-full min-w-[500px] text-xs mt-2">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400 bg-gray-50">
                    <th className="text-left px-4 py-2">Số HĐ</th>
                    <th className="text-left px-4 py-2">Ngày</th>
                    <th className="text-left px-4 py-2">Đối tác</th>
                    <th className="text-right px-4 py-2">Tổng tiền</th>
                    <th className="text-center px-4 py-2">Chiều</th>
                    <th className="text-center px-4 py-2">TT</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.map((r, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="px-4 py-2 font-mono">{r.invoice_number ?? '—'}</td>
                      <td className="px-4 py-2 text-gray-500">{r.invoice_date ?? '—'}</td>
                      <td className="px-4 py-2 truncate max-w-[120px]">
                        {r.direction === 'input' ? r.seller_name : r.buyer_name ?? r.seller_name ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{formatVND(r.total_amount ?? 0)}</td>
                      <td className="px-4 py-2 text-center">
                        {dirLabel(r.direction ?? (direction === 'output' || direction === 'input' ? direction : null))}
                      </td>
                      <td className={`px-4 py-2 text-center ${statusColor(r.status ?? 'valid')}`}>{r.status ?? 'valid'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Errors */}
            {preview.errors.length > 0 && (
              <div className="bg-red-50 border border-red-100 rounded-xl p-4">
                <p className="text-sm font-medium text-red-700 mb-2">⚠️ {preview.errors.length} lỗi phát hiện</p>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {preview.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-600">
                      Dòng {e.row} · {e.field}: {e.message}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Import progress */}
            {importing && (
              <div className="space-y-2">
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${importProgress}%` }} />
                </div>
                <p className="text-xs text-center text-gray-500">
                  Đang nhập... {importProgress}%
                  {preview && importProgress > 0 && importProgress < 100 && (
                    <span> ({Math.round((preview.validRows * importProgress) / 100)}/{preview.validRows} HĐ)</span>
                  )}
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button onClick={() => { setPreview(null); setError(null); }}
                className="flex-1 border border-gray-300 rounded-xl py-3 text-sm text-gray-700" disabled={importing}>
                Hủy
              </button>
              <button onClick={executeImport} disabled={importing || preview.validRows === 0}
                className="flex-1 bg-blue-600 text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50">
                {importing ? 'Đang nhập...' : `Nhập ${preview.validRows ?? 0} hóa đơn hợp lệ`}
              </button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
