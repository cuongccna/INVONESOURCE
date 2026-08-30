/**
 * Lớp HTTP dùng chung cho mọi plugin tra cứu.
 *
 * Adapter không được tự gọi axios: đi qua đây thì timeout, User-Agent, giới hạn kích thước
 * và số lần chuyển hướng luôn được áp dụng — một plugin viết ẩu cũng không thể treo worker
 * hay nuốt hết bộ nhớ.
 */
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { CaptchaService } from '../../captcha.service';
import type { LookupHttp } from './types';

/** PDF hoá đơn thực tế 100–800KB; chặn ở 25MB để một cổng hỏng không nuốt hết RAM */
const MAX_BYTES = Number(process.env['PROVIDER_LOOKUP_MAX_BYTES'] ?? 25 * 1024 * 1024);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

export function createLookupHttp(timeoutMs: number): LookupHttp {
  // Hộp cookie riêng cho MỖI lần tra cứu: cổng dạng ASP.NET gắn captcha vào session,
  // nên ảnh captcha và lần POST tra cứu phải đi cùng một session.
  const jar = new Map<string, string>();
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
    const host = safeHost(url);
    const hint = typeof body === 'string' ? ` — ${body.slice(0, 120)}` : '';
    throw new Error(`${host} trả về HTTP ${status}${hint}`);
  };

  return {
    async getJson<T>(url: string, opts?: { headers?: Record<string, string> }): Promise<T> {
      const res = await axios.get(url, { ...base(opts?.headers), responseType: 'json' });
      absorb(res);
      check(url, res.status, typeof res.data === 'string' ? res.data : undefined);
      return res.data as T;
    },

    async getText(url: string, opts?: { headers?: Record<string, string> }): Promise<string> {
      const res = await axios.get(url, { ...base(opts?.headers), responseType: 'text' });
      absorb(res);
      check(url, res.status);
      return String(res.data);
    },

    async postForm(url, fields, opts): Promise<string> {
      const body = new URLSearchParams(fields).toString();
      const res = await axios.post(url, body, {
        ...base({ 'Content-Type': 'application/x-www-form-urlencoded', ...(opts?.headers ?? {}) }),
        responseType: 'text',
      });
      absorb(res);
      check(url, res.status);
      return String(res.data);
    },

    async solveCaptcha(imageBase64, hints): Promise<string> {
      if (!process.env['TWO_CAPTCHA_API_KEY']) {
        throw new Error('Chưa cấu hình TWO_CAPTCHA_API_KEY nên không giải được captcha của cổng');
      }
      const { text } = await new CaptchaService().solve(imageBase64, {
        minLen: hints?.minLen ?? 4, maxLen: hints?.maxLen ?? 6, regsense: 0,
      });
      const answer = (text ?? '').trim();
      if (!answer) throw new Error('Dịch vụ giải captcha trả về rỗng');
      return answer;
    },

    async postJson<T>(url: string, body: unknown, opts?: { headers?: Record<string, string> }): Promise<T> {
      const res = await axios.post(url, body, {
        ...base({ 'Content-Type': 'application/json', ...(opts?.headers ?? {}) }),
        responseType: 'json',
      });
      absorb(res);
      check(url, res.status, typeof res.data === 'string' ? res.data : undefined);
      return res.data as T;
    },

    async getBinary(url: string, opts?: { headers?: Record<string, string> }): Promise<Buffer> {
      const res = await axios.get(url, { ...base(opts?.headers), responseType: 'arraybuffer' });
      absorb(res);
      check(url, res.status);
      const buf = Buffer.from(res.data as ArrayBuffer);
      if (buf.byteLength > MAX_BYTES) {
        throw new Error(`File từ ${safeHost(url)} vượt giới hạn ${MAX_BYTES} byte`);
      }
      return buf;
    },
  };
}

/** Chỉ lấy hostname để đưa vào thông điệp lỗi — tránh lộ mã tra cứu vào log */
function safeHost(url: string): string {
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
