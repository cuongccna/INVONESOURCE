/**
 * BOT-SEC-04 — GDT Authentication Service
 *
 * Handles login to hoadondientu.gdt.gov.vn using Playwright.
 *
 * NOTE: The actual login form selectors and endpoint are determined at
 * integration time by inspecting the GDT portal with browser DevTools.
 * Placeholder selectors are marked with [TODO: inspect portal].
 *
 * Flow:
 *   1. Navigate to login page
 *   2. Fill username + password
 *   3. Solve CAPTCHA (image in canvas/img element) via 2Captcha
 *   4. Submit, detect OTP screen
 *   5. Return session cookies
 *
 * Circuit breaker: 3 consecutive captcha failures → stop, report them all.
 */
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import { CaptchaService } from './captcha.service';
import { logger } from './logger';

export interface GdtCredentials {
  username: string;   // MST / tax code used as username on GDT portal
  password: string;
}

export interface GdtSession {
  cookies:     string;   // serialised cookie header value
  contextState: unknown; // Playwright serialised storage state JSON
  expiresAt:   Date;
  requiresOtp: boolean;
}

const GDT_BASE = 'https://hoadondientu.gdt.gov.vn';

// [TODO: inspect portal] — these selectors need verification via DevTools
const SELECTORS = {
  usernameInput:  '#username',
  passwordInput:  '#password',
  captchaImage:   'img.captcha-image, canvas#captchaCanvas',
  captchaInput:   '#captchaCode, input[name="captchaCode"]',
  submitButton:   'button[type="submit"], input[type="submit"]',
  otpInput:       '#otp, input[name="otp"]',
  otpSubmit:      'button.btn-otp, button[type="submit"]',
  errorMessage:   '.error-message, .alert-danger, .text-danger',
  loggedInMark:   'nav.sidebar, .dashboard-container, #user-info',
};

export class GdtAuthService {
  private captchaService: CaptchaService;

  constructor() {
    this.captchaService = new CaptchaService();
  }

  async login(
    credentials: GdtCredentials,
    proxyUrl?: string | null
  ): Promise<GdtSession> {
    const browser = await this._launchBrowser(proxyUrl);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    const page = await context.newPage();

    try {
      await page.goto(`${GDT_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      let captchaAttempts = 0;
      let lastCaptchaId: string | null = null;

      while (captchaAttempts < 3) {
        await page.waitForSelector(SELECTORS.usernameInput, { timeout: 15_000 });

        // Fill form
        await page.fill(SELECTORS.usernameInput, credentials.username);
        await page.fill(SELECTORS.passwordInput, credentials.password);

        // Solve captcha
        const captchaBase64 = await this._getCaptchaBase64(page);
        if (captchaBase64) {
          try {
            const { text, captchaId } = await this.captchaService.solve(captchaBase64);
            lastCaptchaId = captchaId;
            logger.debug('[GdtAuth] Captcha solved', { captchaId, text });
            await page.fill(SELECTORS.captchaInput, text);
          } catch (err) {
            logger.warn('[GdtAuth] Captcha service error', { err });
            captchaAttempts++;
            continue;
          }
        }

        // Submit
        await page.click(SELECTORS.submitButton);
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 });

        // Check result
        const error = await page.$(SELECTORS.errorMessage);
        if (error) {
          const msg = await error.textContent();
          if (msg?.toLowerCase().includes('captcha') || msg?.toLowerCase().includes('mã xác nhận')) {
            logger.warn('[GdtAuth] Wrong captcha, retrying', { attempt: captchaAttempts + 1 });
            if (lastCaptchaId) await this.captchaService.reportBad(lastCaptchaId);
            captchaAttempts++;
            continue; // Reload page and retry
          }
          throw new Error(`GDT login error: ${msg?.trim()}`);
        }

        // Check for OTP screen
        const otpEl = await page.$(SELECTORS.otpInput);
        if (otpEl) {
          logger.info('[GdtAuth] OTP screen detected');
          const cookies = await this._serializeCookies(context);
          const storageState = await context.storageState();
          await browser.close();
          return {
            cookies,
            contextState: storageState,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min OTP window
            requiresOtp: true,
          };
        }

        // Check logged in
        const dashboard = await page.$(SELECTORS.loggedInMark);
        if (dashboard) {
          logger.info('[GdtAuth] Login successful');
          const cookies = await this._serializeCookies(context);
          const storageState = await context.storageState();
          await browser.close();
          return {
            cookies,
            contextState: storageState,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h session
            requiresOtp: false,
          };
        }

        // Unknown state — assume success and continue
        logger.warn('[GdtAuth] Login result unclear, proceeding');
        const cookies = await this._serializeCookies(context);
        const storageState = await context.storageState();
        await browser.close();
        return {
          cookies,
          contextState: storageState,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          requiresOtp: false,
        };
      }

      throw new Error('Failed to solve captcha after 3 attempts');
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  /** Submit OTP code on a session that requiresOtp=true */
  async submitOtp(session: GdtSession, otp: string): Promise<GdtSession> {
    const browser = await this._launchBrowser(null);
    const context = await browser.newContext({
      storageState: session.contextState as import('playwright').BrowserContextOptions['storageState'],
    });
    const page = await context.newPage();

    try {
      await page.goto(`${GDT_BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.fill(SELECTORS.otpInput, otp);
      await page.click(SELECTORS.otpSubmit);
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });

      const cookies = await this._serializeCookies(context);
      const storageState = await context.storageState();
      await browser.close();

      return {
        cookies,
        contextState: storageState,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        requiresOtp: false,
      };
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  isExpired(session: GdtSession): boolean {
    return session.expiresAt <= new Date();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async _launchBrowser(proxyUrl?: string | null): Promise<Browser> {
    return chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    });
  }

  private async _getCaptchaBase64(page: Page): Promise<string | null> {
    // Try to capture captcha image as base64
    const captchaEl = await page.$(SELECTORS.captchaImage);
    if (!captchaEl) return null;

    // Screenshot the captcha element
    const buf = await captchaEl.screenshot({ type: 'png' });
    return buf.toString('base64');
  }

  private async _serializeCookies(context: BrowserContext): Promise<string> {
    const cookies = await context.cookies();
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }
}
