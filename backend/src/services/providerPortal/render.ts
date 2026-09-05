/**
 * Render bản thể hiện HTML của nhà cung cấp thành PDF khổ A4.
 *
 * Nhiều cổng tra cứu không đưa PDF sẵn mà dựng HTML đúng mẫu và đúng logo của họ. Dựng lại
 * bằng Chromium cho ra file đồng nhất với phần còn lại của hệ thống (bot cũng render bản
 * thể hiện của cổng thuế theo cách này).
 *
 * Trình duyệt được dùng lại giữa các lần render và tự khởi động lại nếu bị đóng, vì mở
 * Chromium tốn khoảng một giây — người dùng đang đứng chờ ngay trên giao diện.
 */
import type { Browser } from 'puppeteer';

const RENDER_TIMEOUT_MS = Number(process.env['PDF_RENDER_TIMEOUT_MS'] ?? 60_000);

let shared: Browser | null = null;

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

async function browser(): Promise<Browser> {
  if (shared) {
    try {
      if (shared.connected) return shared;
    } catch {
      shared = null;
    }
  }
  const { default: puppeteer } = await import('puppeteer');
  const executablePath = process.env['CHROMIUM_PATH'] || undefined;
  const isLinux = process.platform === 'linux';
  shared = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(isLinux ? ['--disable-dev-shm-usage', '--no-zygote'] : []),
      '--disable-gpu',
    ],
  });
  return shared;
}

/**
 * HTML → PDF. Nội dung nạp thẳng vào trang (không ghi file tạm) và KHÔNG cho phép tải
 * tài nguyên ngoài trừ ảnh: bản thể hiện của nhà cung cấp là HTML từ bên thứ ba, không có
 * lý do gì để nó chạy script hay gọi ra mạng trong tiến trình API.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const page = await (await browser()).newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setViewport({ width: 1240, height: 1754 });
    await page.setContent(ensureUtf8Document(html), { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '6mm', bottom: '6mm', left: '6mm', right: '6mm' },
    });
    const buf = Buffer.from(pdf);
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('Render bản thể hiện không ra PDF hợp lệ');
    }
    return buf;
  } finally {
    await page.close().catch(() => undefined);
  }
}
