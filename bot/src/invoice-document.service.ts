/**
 * InvoiceDocumentService — lưu bản gốc hoá đơn và render bản thể hiện PDF
 *
 * Gói ZIP từ GDT (/query/invoices/export-xml) chứa đầy đủ bản gốc:
 *   invoice.xml   — dữ liệu đã ký số của người bán + chữ ký cấp mã CQT
 *   invoice.html  — bản thể hiện khổ A4 do nhà cung cấp HĐĐT phát hành
 *   details.js    — dữ liệu render cho invoice.html (tham chiếu tương đối)
 *   *.jpg         — nền hoá đơn, dấu kiểm tra chữ ký
 *
 * GDT không cấp file PDF, nên PDF được render từ chính invoice.html bằng
 * Chromium headless — giữ nguyên bố cục, dấu, chữ ký của nhà cung cấp.
 *
 * File lưu ngoài DB:
 *   <INVOICE_STORAGE_DIR>/<company_id>/<invoice_id>/original.zip
 *   <INVOICE_STORAGE_DIR>/<company_id>/<invoice_id>/invoice.pdf
 *   <INVOICE_STORAGE_DIR>/<company_id>/<invoice_id>/src/…   (html + assets để render lại)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { logger } from './logger';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface StoredInvoiceDocs {
  /** đường dẫn tương đối tới ZIP gốc */
  zipPath:  string;
  zipSize:  number;
  /** XML hoá đơn gốc (đã ký số) */
  xml:      Buffer | null;
  /** đường dẫn tương đối tới PDF bản thể hiện (null nếu render lỗi) */
  pdfPath:  string | null;
  pdfSize:  number | null;
  pdfError: string | null;
}

/** Thư mục gốc lưu file hoá đơn — dùng chung giữa bot (ghi) và backend (đọc) */
export function storageRoot(): string {
  return process.env['INVOICE_STORAGE_DIR'] ?? '/opt/INVONESOURCE/storage/invoices';
}

/** Thời gian tối đa cho một lần render PDF */
const RENDER_TIMEOUT_MS = Number(process.env['PDF_RENDER_TIMEOUT_MS'] ?? 60_000);

// ─── ZIP ─────────────────────────────────────────────────────────────────────

/**
 * Giải nén toàn bộ entry của gói ZIP.
 *
 * Đọc Central Directory trước: ZIP của GDT dùng data descriptor nên kích thước
 * trong local file header bằng 0, chỉ Central Directory mới có số liệu đúng.
 */
export function extractZipEntries(buf: Buffer): ZipEntry[] {
  const out: ZipEntry[] = [];
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return out;

  // Tìm End Of Central Directory (quét ngược, comment tối đa 64KB)
  let eocd = -1;
  const lowest = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;

  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);

  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize  = buf.readUInt32LE(off + 20);
    const fnLen  = buf.readUInt16LE(off + 28);
    const exLen  = buf.readUInt16LE(off + 30);
    const cmLen  = buf.readUInt16LE(off + 32);
    const lho    = buf.readUInt32LE(off + 42);
    const name   = buf.subarray(off + 46, off + 46 + fnLen).toString('utf8');

    try {
      const lfn   = buf.readUInt16LE(lho + 26);
      const lex   = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lfn + lex;
      const raw   = buf.subarray(start, start + csize);
      const data  = method === 0 ? raw : zlib.inflateRawSync(raw);
      // Chặn path traversal từ tên entry (zip-slip)
      const safe = path.basename(name);
      if (safe && safe !== '.' && safe !== '..') out.push({ name: safe, data });
    } catch (err) {
      logger.warn('[InvoiceDoc] Không giải nén được entry', {
        name, error: err instanceof Error ? err.message : String(err),
      });
    }
    off += 46 + fnLen + exLen + cmLen;
  }
  return out;
}

// ─── Render PDF ──────────────────────────────────────────────────────────────

/**
 * Bảo đảm HTML khai báo UTF-8 trước khi đưa vào Chromium.
 *
 * Cổng nhà cung cấp trả về MẢNH HTML: không <head>, không khai báo bộ mã. Chromium phải
 * tự đoán, và với hoá đơn ít dấu tiếng Việt nó đoán ra windows-1252 — cả tờ hoá đơn biến
 * thành "HÃ³a Ä'Æ¡n GiÃ¡ Trá»‹ Gia TÄƒng". Khai thẳng UTF-8 thì không còn chỗ cho phỏng đoán.
 *
 * HTML nào đã tự khai bộ mã (bản thể hiện đầy đủ của cổng thuế, mảnh VNPT đã bọc sẵn) thì
 * giữ nguyên — không ghi đè khai báo của nhà cung cấp.
 */
export function ensureUtf8Document(html: string): string {
  if (/<meta[^>]+charset/i.test(html)) return html;

  const meta = '<meta charset="utf-8">';
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + meta + html.slice(at);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${meta}</head>`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/**
 * Render invoice.html (kèm assets cùng thư mục) thành PDF khổ A4.
 * Trả về Buffer PDF; ném lỗi nếu Chromium không khả dụng.
 */
export async function renderHtmlToPdf(htmlFilePath: string): Promise<Buffer> {
  // import động: chỉ nạp Playwright khi thật sự cần render
  const { chromium } = await import('playwright');

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.goto(`file://${htmlFilePath}`, {
      waitUntil: 'networkidle',
      timeout: RENDER_TIMEOUT_MS,
    });
    // invoice.html dựng nội dung bằng details.js sau khi load — chờ DOM ổn định
    await page.waitForTimeout(700);

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '6mm', bottom: '6mm', left: '6mm', right: '6mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ─── Lưu trữ ─────────────────────────────────────────────────────────────────

/**
 * Lưu gói bản gốc và render PDF.
 *
 * Không ném lỗi khi render PDF thất bại: XML gốc vẫn được giữ, pdfError trả về
 * để worker ghi nhận và người dùng vẫn tải được XML.
 */
export async function storeInvoiceDocuments(
  companyId: string,
  invoiceId: string,
  zipBuffer: Buffer,
  options: { renderPdf?: boolean } = {},
): Promise<StoredInvoiceDocs> {
  const relDir = path.join(companyId, invoiceId);
  const absDir = path.join(storageRoot(), relDir);
  const srcDir = path.join(absDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // 1. Giữ nguyên gói ZIP gốc
  const zipRel = path.join(relDir, 'original.zip');
  fs.writeFileSync(path.join(storageRoot(), zipRel), zipBuffer);

  // 2. Bung toàn bộ entry ra thư mục src/ để render lại được bất cứ lúc nào
  const entries = extractZipEntries(zipBuffer);
  let xml: Buffer | null = null;
  let htmlName: string | null = null;

  for (const e of entries) {
    fs.writeFileSync(path.join(srcDir, e.name), e.data);
    const lower = e.name.toLowerCase();
    if (lower.endsWith('.xml')) xml = e.data;
    if (lower.endsWith('.html') || lower.endsWith('.htm')) htmlName = e.name;
  }

  const result: StoredInvoiceDocs = {
    zipPath: zipRel.split(path.sep).join('/'),
    zipSize: zipBuffer.byteLength,
    xml,
    pdfPath: null,
    pdfSize: null,
    pdfError: null,
  };

  if (options.renderPdf === false) return result;

  if (!htmlName) {
    result.pdfError = 'Gói bản gốc không có bản thể hiện HTML';
    logger.warn('[InvoiceDoc] Không tìm thấy invoice.html trong gói ZIP', {
      invoiceId, entries: entries.map(e => e.name),
    });
    return result;
  }

  try {
    const pdf = await renderHtmlToPdf(path.join(srcDir, htmlName));
    const pdfRel = path.join(relDir, 'invoice.pdf');
    fs.writeFileSync(path.join(storageRoot(), pdfRel), pdf);
    result.pdfPath = pdfRel.split(path.sep).join('/');
    result.pdfSize = pdf.byteLength;
    logger.info('[InvoiceDoc] Đã render bản thể hiện PDF', {
      invoiceId, bytes: pdf.byteLength,
    });
  } catch (err) {
    result.pdfError = err instanceof Error ? err.message : String(err);
    logger.error('[InvoiceDoc] Render PDF thất bại', {
      invoiceId, error: result.pdfError,
    });
  }

  return result;
}
