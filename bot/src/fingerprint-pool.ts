/**
 * Fingerprint Pool — BOT-ENT-04
 *
 * Provides consistent browser profiles (UA + headers + viewport) per session.
 * A single session MUST use the same profile for all requests to avoid WAF detection.
 *
 * Profiles are derived from real browsers observed on Vietnamese ISPs.
 */

export interface BrowserProfile {
  id:                 string;
  userAgent:          string;
  acceptLanguage:     string;
  accept:             string;
  secChUa:            string;       // empty string for Firefox
  secChUaPlatform:    string;
  secChUaMobile:      string;
  viewportWidth:      number;
  viewportHeight:     number;
  timezone:           string;
}

export const BROWSER_PROFILES: BrowserProfile[] = [
  {
    id: 'chrome-122-win-1080',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    secChUa: '"Not A(Brand";v="99", "Google Chrome";v="122", "Chromium";v="122"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
    viewportWidth: 1920, viewportHeight: 1080,
    timezone: 'Asia/Ho_Chi_Minh',
  },
  {
    id: 'chrome-121-win-768',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    acceptLanguage: 'vi-VN,vi;q=0.9,en;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    secChUa: '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
    viewportWidth: 1366, viewportHeight: 768,
    timezone: 'Asia/Ho_Chi_Minh',
  },
  {
    id: 'chrome-120-mac',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    secChUa: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    secChUaPlatform: '"macOS"',
    secChUaMobile: '?0',
    viewportWidth: 1440, viewportHeight: 900,
    timezone: 'Asia/Ho_Chi_Minh',
  },
  {
    id: 'edge-122-win',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    acceptLanguage: 'vi,en-US;q=0.9,en;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    secChUa: '"Chromium";v="122", "Not(A:Brand";v="24", "Microsoft Edge";v="122"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
    viewportWidth: 1536, viewportHeight: 864,
    timezone: 'Asia/Ho_Chi_Minh',
  },
  {
    id: 'firefox-123-win',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    acceptLanguage: 'vi-VN,vi;q=0.8,en-US;q=0.5,en;q=0.3',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    secChUa: '',  // Firefox does not send sec-ch-ua
    secChUaPlatform: '',
    secChUaMobile: '',
    viewportWidth: 1366, viewportHeight: 768,
    timezone: 'Asia/Ho_Chi_Minh',
  },
  {
    id: 'chrome-119-win-900',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    secChUa: '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
    viewportWidth: 1280, viewportHeight: 900,
    timezone: 'Asia/Ho_Chi_Minh',
  },
];

/**
 * Deterministically pick the same profile for a given session ID.
 * Uses a simple hash so the same session always gets the same profile.
 */
export function getProfileForSession(sessionId: string): BrowserProfile {
  const hash = sessionId
    .split('')
    .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) & 0x7fffffff, 0);
  return BROWSER_PROFILES[hash % BROWSER_PROFILES.length]!;
}

/**
 * Build the full HTTP headers object for a given profile.
 * Chrome profiles get the full sec-ch-ua security header set;
 * Firefox profiles omit those headers to match real Firefox behaviour.
 */
export function getSessionHeaders(profile: BrowserProfile): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':      profile.userAgent,
    'Accept':          profile.accept,
    'Accept-Language': profile.acceptLanguage,
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
    'Referer':         'https://hoadondientu.gdt.gov.vn/',
    'Origin':          'https://hoadondientu.gdt.gov.vn',
  };

  if (profile.secChUa) {
    headers['sec-ch-ua']          = profile.secChUa;
    headers['sec-ch-ua-platform'] = profile.secChUaPlatform;
    headers['sec-ch-ua-mobile']   = profile.secChUaMobile;
    headers['Sec-Fetch-Dest']     = 'document';
    headers['Sec-Fetch-Mode']     = 'navigate';
    headers['Sec-Fetch-Site']     = 'same-origin';
  }

  return headers;
}
