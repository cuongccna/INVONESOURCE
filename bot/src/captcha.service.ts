/**
 * BOT-SEC-03 — 2Captcha service
 * Solves image/reCAPTCHA/hCaptcha via 2captcha.com API.
 * Polls every 3 seconds, timeout 120 seconds. Auto-reportBad on failure.
 */
import axios from 'axios';
import { logger } from './logger';

const API_URL     = 'https://2captcha.com';
const POLL_MS     = 3000;
const TIMEOUT_MS  = 120_000;

export class CaptchaService {
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['TWO_CAPTCHA_API_KEY'] ?? '';
    if (!this.apiKey) throw new Error('TWO_CAPTCHA_API_KEY is not set');
  }

  /** Submit base64 image captcha and poll for result */
  async solve(imageBase64: string): Promise<{ text: string; captchaId: string }> {
    const submitRes = await axios.post<string>(`${API_URL}/in.php`, null, {
      params: {
        key:    this.apiKey,
        method: 'base64',
        body:   imageBase64,
        json:   1,
      },
      responseType: 'json',
      timeout: 30_000,
    });

    const submitted = (submitRes.data as unknown) as { status: number; request: string };
    if (!submitted.status || !submitted.request) {
      throw new Error(`2captcha submit failed: ${JSON.stringify(submitted)}`);
    }
    const captchaId = submitted.request;
    logger.debug('[Captcha] Submitted captcha', { captchaId });

    return this._poll(captchaId);
  }

  /** Fetch image from URL (with optional cookies) then solve */
  async solveFromUrl(imageUrl: string, cookies = ''): Promise<{ text: string; captchaId: string }> {
    const imgRes = await axios.get<Buffer>(imageUrl, {
      responseType: 'arraybuffer',
      headers: cookies ? { Cookie: cookies } : {},
      timeout: 15_000,
    });
    const base64 = Buffer.from(imgRes.data).toString('base64');
    return this.solve(base64);
  }

  /** Report a bad captcha answer to get a refund */
  async reportBad(captchaId: string): Promise<void> {
    try {
      await axios.get(`${API_URL}/res.php`, {
        params: { key: this.apiKey, action: 'reportbad', id: captchaId },
        timeout: 10_000,
      });
      logger.warn('[Captcha] Reported bad captcha', { captchaId });
    } catch (err) {
      logger.error('[Captcha] reportBad failed', { err });
    }
  }

  private async _poll(captchaId: string): Promise<{ text: string; captchaId: string }> {
    const deadline = Date.now() + TIMEOUT_MS;
    await _sleep(10_000); // Initial wait — 2captcha needs ~10s to process

    while (Date.now() < deadline) {
      await _sleep(POLL_MS);
      const res = await axios.get<{ status: number; request: string }>(`${API_URL}/res.php`, {
        params: { key: this.apiKey, action: 'get', id: captchaId, json: 1 },
        timeout: 15_000,
        responseType: 'json',
      });

      const body = res.data;
      if (body.status === 1) {
        logger.debug('[Captcha] Solved', { captchaId, text: body.request });
        return { text: body.request, captchaId };
      }
      if (body.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2captcha error: ${body.request}`);
      }
    }
    throw new Error('Captcha solve timeout (120s)');
  }
}

function _sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
