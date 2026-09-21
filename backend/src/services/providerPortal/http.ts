/**
 * Lớp HTTP dùng chung cho mọi driver cổng tra cứu.
 *
 * Driver không được tự gọi axios: đi qua đây thì timeout, User-Agent, giới hạn kích thước
 * và số lần chuyển hướng luôn được áp dụng — một driver viết ẩu cũng không thể treo tiến
 * trình API hay nuốt hết bộ nhớ.
 *
 * Hộp cookie xuất/nhập được, vì luồng có mã xác thực chia làm hai request cách nhau bởi
 * thao tác của người dùng: ảnh captcha gắn với phiên của cổng, nên lần POST tra cứu phải
 * mang đúng cookie của lần lấy ảnh.
 */
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { PortalHttp } from './types';

/** PDF hoá đơn thực tế 100–800KB; chặn ở 25MB để một cổng hỏng không nuốt hết RAM */
const MAX_BYTES = Number(process.env['PROVIDER_LOOKUP_MAX_BYTES'] ?? 25 * 1024 * 1024);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

export function createPortalHttp(
  timeoutMs: number,
  initialCookies?: Record<string, string>,
): PortalHttp {
  const jar = new Map<string, string>(Object.entries(initialCookies ?? {}));

  const cookieHeader = (): string =>
    Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');

  const absorb = (res: AxiosResponse): void => {
    const sc = res.headers['set-cookie'];
    if (!Array.isArray(sc)) return;
    for (const line of sc) {
      const pair = String(line).split(';')[0] ?? '';
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  };

  const base = (extra?: Record<string, string>): AxiosRequestConfig => ({
    timeout: timeoutMs,
    maxRedirects: 3,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
      ...extra,
    },
    // Tự kiểm tra status để thông điệp lỗi nói rõ cổng trả về gì
    validateStatus: () => true,
  });

  const check = (url: string, status: number, body?: unknown): void => {
    if (status >= 200 && status < 300) return;
    const hint = typeof body === 'string' ? ` — ${body.slice(0, 120)}` : '';
    throw new Error(`${safeHost(url)} trả về HTTP ${status}${hint}`);
  };

  return {
    async getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
      const res = await axios.get(url, { ...base(headers), responseType: 'json' });
      absorb(res);
      check(url, res.status, typeof res.data === 'string' ? res.data : undefined);
      return res.data as T;
    },

    async getText(url: string, headers?: Record<string, string>): Promise<string> {
      const res = await axios.get(url, { ...base(headers), responseType: 'text' });
      absorb(res);
      check(url, res.status);
      return String(res.data);
    },

    async getBinary(url: string, headers?: Record<string, string>): Promise<Buffer> {
      const res = await axios.get(url, { ...base(headers), responseType: 'arraybuffer' });
      absorb(res);
      check(url, res.status);
      return sized(Buffer.from(res.data as ArrayBuffer), url);
    },

    async postJson<T>(url: string, body: unknown, headers?: Record<string, string>): Promise<T> {
      const res = await axios.post(url, body, {
        ...base({ 'Content-Type': 'application/json', ...(headers ?? {}) }),
        responseType: 'json',
      });
      absorb(res);
      check(url, res.status, typeof res.data === 'string' ? res.data : undefined);
      return res.data as T;
    },

    async postQuery<T>(url: string, params: Record<string, string>, headers?: Record<string, string>): Promise<T> {
      const res = await axios.post(url, undefined, {
        ...base(headers), params, responseType: 'json',
      });
      absorb(res);
      check(url, res.status, typeof res.data === 'string' ? res.data : undefined);
      return res.data as T;
    },

    async postForm(url: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<string> {
      const res = await axios.post(url, new URLSearchParams(fields).toString(), {
        ...base({ 'Content-Type': 'application/x-www-form-urlencoded', ...(headers ?? {}) }),
        responseType: 'text',
      });
      absorb(res);
      check(url, res.status);
      return String(res.data);
    },

    async postFormJson<T>(url: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<T> {
      const res = await axios.post(url, new URLSearchParams(fields).toString(), {
        ...base({
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          ...(headers ?? {}),
        }),
        responseType: 'text',
      });
      absorb(res);
      check(url, res.status);
      // Vài cổng trả JSON nhưng khai Content-Type là text/html — parse tay cho chắc
      const text = String(res.data);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`${safeHost(url)} không trả về JSON hợp lệ`);
      }
    },

    async postFormNoRedirect(
      url: string, fields: Record<string, string>, headers?: Record<string, string>,
    ): Promise<{ status: number; location: string | null; body: string }> {
      const res = await axios.post(url, new URLSearchParams(fields).toString(), {
        ...base({ 'Content-Type': 'application/x-www-form-urlencoded', ...(headers ?? {}) }),
        maxRedirects: 0,
        responseType: 'text',
      });
      absorb(res);
      const loc = res.headers['location'];
      return {
        status: res.status,
        location: typeof loc === 'string' ? loc : null,
        body: typeof res.data === 'string' ? res.data : String(res.data ?? ''),
      };
    },

    exportCookies(): Record<string, string> {
      return Object.fromEntries(jar.entries());
    },
  };
}

function sized(buf: Buffer, url: string): Buffer {
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`File từ ${safeHost(url)} vượt giới hạn ${MAX_BYTES} byte`);
  }
  return buf;
}

/** Chỉ lấy hostname để đưa vào thông điệp lỗi — tránh lộ mã tra cứu vào log */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'cổng tra cứu';
  }
}

/** PDF hợp lệ bắt đầu bằng %PDF- — chặn trường hợp cổng trả trang HTML báo lỗi */
export function assertPdf(buf: Buffer, where: string): Buffer {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`${where} không trả về PDF (nhận ${buf.byteLength} byte không đúng định dạng)`);
  }
  return buf;
}
