'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../../../lib/apiClient';

interface RecipeRow {
  id:         string;
  name:       string;
  version:    number;
  is_active:  boolean;
  recipe:     Record<string, unknown>;
  notes:      string | null;
  updated_at: string;
  updated_by: string | null;
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 60) return `${diff}m trước`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h trước`;
  return `${Math.floor(h / 24)}d trước`;
}

export default function CrawlerRecipesPage() {
  const [recipes, setRecipes]         = useState<RecipeRow[]>([]);
  const [selected, setSelected]       = useState<string | null>(null);
  const [editorText, setEditorText]   = useState('');
  const [notesText, setNotesText]     = useState('');
  const [jsonValid, setJsonValid]      = useState(true);
  const [jsonError, setJsonError]      = useState('');
  const [saving, setSaving]           = useState(false);
  const [saveMsg, setSaveMsg]         = useState<{ ok: boolean; text: string } | null>(null);
  const [showRef, setShowRef]         = useState(false);
  const originalRef = useRef<string>('');

  // ── Load recipe list ──────────────────────────────────────────────────────

  const loadList = useCallback(() => {
    apiClient.get<{ data: RecipeRow[] }>('/crawler-recipes')
      .then(r => setRecipes(r.data.data ?? []))
      .catch(console.error);
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  // ── Select a recipe to edit ───────────────────────────────────────────────

  function selectRecipe(row: RecipeRow) {
    const pretty = JSON.stringify(row.recipe, null, 2);
    setSelected(row.name);
    setEditorText(pretty);
    setNotesText(row.notes ?? '');
    setJsonValid(true);
    setJsonError('');
    setSaveMsg(null);
    originalRef.current = pretty;
  }

  // ── Editor onChange ───────────────────────────────────────────────────────

  function onEditorChange(val: string) {
    setEditorText(val);
    try {
      JSON.parse(val);
      setJsonValid(true);
      setJsonError('');
    } catch (e) {
      setJsonValid(false);
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  }

  // ── Save (PUT) ────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!selected || !jsonValid) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const recipe = JSON.parse(editorText) as Record<string, unknown>;
      await apiClient.put(`/crawler-recipes/${selected}`, { recipe, notes: notesText || undefined });
      setSaveMsg({ ok: true, text: 'Đã lưu thành công. Bot sẽ nhận cấu hình mới trong vòng 30 giây.' });
      loadList();
    } catch {
      setSaveMsg({ ok: false, text: 'Lưu thất bại. Vui lòng thử lại.' });
    } finally {
      setSaving(false);
    }
  }

  // ── Reset editor to last saved state ─────────────────────────────────────

  function handleReset() {
    setEditorText(originalRef.current);
    setJsonValid(true);
    setJsonError('');
    setSaveMsg(null);
  }

  // ── Activate / Deactivate ─────────────────────────────────────────────────

  async function handleToggleActive(name: string, currentlyActive: boolean) {
    const action = currentlyActive ? 'deactivate' : 'activate';
    try {
      await apiClient.post(`/crawler-recipes/${name}/${action}`, {});
      loadList();
    } catch {
      // ignore
    }
  }

  const selectedRow = recipes.find(r => r.name === selected);

  return (
    <div className="h-full flex flex-col">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Crawler Recipes</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Cấu hình GDT API (endpoints, field mappings, timing) — bot nhận config mới trong vòng 30 giây.
        </p>
      </div>

      <div className="flex-1 flex gap-5 min-h-0">

        {/* ── Left: recipe list ── */}
        <div className="w-56 flex-shrink-0 flex flex-col gap-1">
          {recipes.length === 0 && (
            <p className="text-xs text-gray-400 px-2">Chưa có recipe nào.</p>
          )}
          {recipes.map(row => (
            <button
              key={row.name}
              onClick={() => selectRecipe(row)}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors text-sm ${
                selected === row.name
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                  : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span className="font-medium">{row.name}</span>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-xs bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">
                  v{row.version}
                </span>
                <span className={`text-xs rounded px-1.5 py-0.5 ${
                  row.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                }`}>
                  {row.is_active ? 'active' : 'inactive'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">{timeAgo(row.updated_at)}</p>
            </button>
          ))}
        </div>

        {/* ── Right: editor panel ── */}
        <div className="flex-1 flex flex-col min-w-0">
          {!selected ? (
            <div className="flex items-center justify-center flex-1 text-gray-400 text-sm">
              Chọn một recipe để chỉnh sửa
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <div className="flex items-center justify-between mb-3 gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-800 text-sm">{selected}</span>
                  {selectedRow && (
                    <>
                      <span className="text-xs bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">
                        v{selectedRow.version}
                      </span>
                      <button
                        onClick={() => handleToggleActive(selected, selectedRow.is_active)}
                        className={`text-xs rounded px-2 py-0.5 border transition-colors ${
                          selectedRow.is_active
                            ? 'border-red-200 text-red-600 hover:bg-red-50'
                            : 'border-green-200 text-green-700 hover:bg-green-50'
                        }`}
                      >
                        {selectedRow.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleReset}
                    className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
                  >
                    Reset
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving || !jsonValid}
                    className="text-xs px-3 py-1.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Đang lưu…' : 'Lưu'}
                  </button>
                </div>
              </div>

              {/* Notes */}
              <input
                type="text"
                value={notesText}
                onChange={e => setNotesText(e.target.value)}
                placeholder="Ghi chú (tuỳ chọn)…"
                className="mb-2 w-full border border-gray-200 rounded px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />

              {/* JSON editor */}
              <textarea
                value={editorText}
                onChange={e => onEditorChange(e.target.value)}
                spellCheck={false}
                className={`flex-1 font-mono text-xs w-full rounded border p-3 resize-none focus:outline-none focus:ring-1 ${
                  jsonValid
                    ? 'border-gray-200 focus:ring-indigo-400'
                    : 'border-red-400 focus:ring-red-400 bg-red-50'
                }`}
                style={{ minHeight: '320px' }}
              />

              {/* Validation error */}
              {!jsonValid && (
                <p className="mt-1 text-xs text-red-600">{jsonError}</p>
              )}

              {/* Save status */}
              {saveMsg && (
                <p className={`mt-2 text-xs ${saveMsg.ok ? 'text-green-600' : 'text-red-600'}`}>
                  {saveMsg.text}
                </p>
              )}

              {/* Field reference */}
              <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowRef(v => !v)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100"
                >
                  <span>Hướng dẫn: Khi GDT thay đổi API</span>
                  <span className="text-gray-400">{showRef ? '▲' : '▼'}</span>
                </button>
                {showRef && (
                  <div className="px-4 py-3 text-xs text-gray-600 space-y-2 bg-white">
                    <p><strong>GDT đổi URL / port:</strong> Sửa <code>api.baseUrl</code> và <code>api.baseUrlHttp</code></p>
                    <p><strong>GDT đổi đường dẫn endpoint:</strong> Sửa các key trong <code>api.endpoints</code></p>
                    <div className="bg-gray-50 rounded p-2 space-y-1">
                      <p className="font-medium text-gray-700">Các endpoint hiện tại:</p>
                      <table className="w-full">
                        <tbody className="divide-y divide-gray-100">
                          {([
                            ['captcha',             '/captcha',                                    'Lấy captcha SVG'],
                            ['auth',                '/security-taxpayer/authenticate',             'Đăng nhập → JWT token'],
                            ['sold',                '/query/invoices/sold',                        'Danh sách hóa đơn bán ra (JSON)'],
                            ['purchase',            '/query/invoices/purchase',                    'Danh sách hóa đơn mua vào (JSON)'],
                            ['detail',              '/query/invoices/detail',                      '✅ Chi tiết 1 hóa đơn + line items (~6KB JSON) — ưu tiên'],
                            ['exportXml',           '/query/invoices/export-xml',                  'Tải XML ZIP (~400KB) — fallback khi detail fail'],
                            ['exportExcel',         '/query/invoices/export-excel',                'Tải XLSX bán ra'],
                            ['exportExcelPurchase', '/query/invoices/export-excel-sold',           'Tải XLSX mua vào'],
                          ] as [string, string, string][]).map(([key, path, desc]) => (
                            <tr key={key}>
                              <td className="py-0.5 pr-2 font-mono text-indigo-700 whitespace-nowrap">{key}</td>
                              <td className="py-0.5 pr-2 font-mono text-gray-500 whitespace-nowrap">{path}</td>
                              <td className="py-0.5 text-gray-500">{desc}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p><strong>GDT đổi tên trường JSON:</strong> Tìm field tương ứng trong <code>fields</code> và thêm tên mới vào đầu mảng</p>
                    <p><strong>GDT thêm tab mua vào mới:</strong> Thêm filter vào <code>api.query.purchaseFilters</code> (VD: <code>&quot;ttxly==9&quot;</code>)</p>
                    <p><strong>GDT thay đổi mã trạng thái:</strong> Sửa <code>statusMap</code> (key = mã số dạng chuỗi, value = valid/cancelled/replaced/adjusted)</p>
                    <p><strong>Tăng timeout / retry:</strong> Sửa <code>timing.requestTimeoutMs</code>, <code>timing.binaryTimeoutMs</code>, <code>timing.maxRetries</code></p>
                    <div className="mt-2 border-t border-gray-200 pt-2">
                      <p className="font-medium text-gray-700 mb-1">Cách chạy migration DB (khi có script SQL mới):</p>
                      <pre className="bg-gray-900 text-green-400 rounded p-2 text-xs overflow-x-auto whitespace-pre">{`# Trên VPS — chạy 1 lần sau khi git pull
cd /opt/INVONESOURCE
node -e "
require('dotenv').config();
const {Client}=require('pg');
const fs=require('fs');
const db=new Client({connectionString:process.env.DATABASE_URL});
db.connect().then(async()=>{
  await db.query(fs.readFileSync('scripts/022_crawler_recipes.sql','utf8'));
  console.log('Done');
  await db.end();
});
"

# Hoặc dùng script có sẵn (local):
node scripts/apply-026.js  # thay 026 bằng số migration cần chạy`}</pre>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
