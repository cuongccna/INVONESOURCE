/**
 * Header bắt buộc mà web hoadondientu.gdt.gov.vn tự gắn cho MỌI request API.
 *
 * Bundle JS của cổng GDT có interceptor axios:
 *   headers["request-id"] = uuid()
 *   headers.Action        = encodeURIComponent(localStorage.action || "")
 *   headers["End-Point"]  = window.location.pathname
 *
 * Từ 09/2026 lớp chống bot của GDT trả 403
 *   {"message":"Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn."}
 * cho request thiếu `request-id` — kể cả khi tài khoản, captcha và proxy đều đúng.
 */
import { randomUUID } from 'crypto';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';

/** Trang web mà trình duyệt đang đứng khi gọi endpoint này. */
export function gdtEndPointFor(url: string): string {
  if (url.includes('/query/') || url.includes('/sco-query/')) return '/tra-cuu/tra-cuu-hoa-don';
  return '/';
}

/** Header trình duyệt cho một request — dùng khi gọi GDT không qua axios instance. */
export function gdtBrowserHeaders(url: string): Record<string, string> {
  return {
    'request-id': randomUUID(),
    'Action':     '',
    'End-Point':  gdtEndPointFor(url),
  };
}

/** 403 từ lớp chống bot của GDT (khác 403 của proxy hay của tài khoản). */
export function isGdtWafBlock(status: number | undefined, body: unknown): boolean {
  if (status !== 403) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return /hành vi không hợp lệ|bị chặn/i.test(text);
}

/** Gắn interceptor sinh `request-id` mới cho từng request (giống trình duyệt). */
export function attachGdtBrowserHeaders(instance: AxiosInstance): void {
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const h = config.headers;
    const url = config.url ?? '';
    if (!h.get('request-id')) h.set('request-id', randomUUID());
    if (h.get('Action') == null)    h.set('Action', '');
    if (!h.get('End-Point'))        h.set('End-Point', gdtEndPointFor(url));
    return config;
  });
}
