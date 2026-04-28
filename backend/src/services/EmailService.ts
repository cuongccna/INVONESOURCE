import { Resend } from 'resend';
import { env } from '../config/env';

let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!env.RESEND_API_KEY) {
    throw new Error('[EmailService] RESEND_API_KEY is not configured. Add it to your .env file.');
  }
  if (!resendClient) {
    resendClient = new Resend(env.RESEND_API_KEY);
  }
  return resendClient;
}

function buildPasswordResetHtml(fullName: string, resetUrl: string): string {
  const displayName = fullName || 'bạn';
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Đặt Lại Mật Khẩu — INVONE</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f9;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 100%);padding:36px 40px;text-align:center;">
              <div style="display:inline-block;background:rgba(255,255,255,0.15);border-radius:10px;padding:10px 20px;margin-bottom:12px;">
                <span style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:1px;">📄 INVONE</span>
              </div>
              <div style="color:rgba(255,255,255,0.85);font-size:13px;margin-top:4px;letter-spacing:0.5px;">
                Nền tảng Quản lý Hóa Đơn Điện Tử
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 28px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#111827;">
                Đặt lại mật khẩu
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
                Xin chào <strong>${displayName}</strong>,
              </p>
              <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">
                Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản INVONE của bạn.
                Nhấn vào nút bên dưới để tạo mật khẩu mới:
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:8px 0 32px;">
                    <a href="${resetUrl}"
                       style="display:inline-block;background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 100%);color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:8px;letter-spacing:0.3px;">
                      Đặt Lại Mật Khẩu →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:14px 18px;margin-bottom:28px;">
                <p style="margin:0;font-size:13px;color:#854d0e;line-height:1.5;">
                  ⏱ Link này <strong>chỉ có hiệu lực trong 24 giờ</strong> kể từ khi email được gửi.
                  Sau thời gian đó, bạn cần gửi yêu cầu mới.
                </p>
              </div>

              <!-- Fallback URL -->
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
                Nếu nút không hoạt động, sao chép và dán liên kết sau vào trình duyệt:
              </p>
              <p style="margin:0 0 28px;font-size:12px;word-break:break-all;">
                <a href="${resetUrl}" style="color:#2563eb;text-decoration:underline;">${resetUrl}</a>
              </p>

              <!-- Security notice -->
              <div style="border-top:1px solid #e5e7eb;padding-top:24px;">
                <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
                  🔒 Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.
                  Tài khoản của bạn vẫn an toàn và mật khẩu không thay đổi.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:24px 40px;text-align:center;">
              <p style="margin:0 0 6px;font-size:12px;color:#9ca3af;">
                Email này được gửi tự động từ hệ thống INVONE.
                Vui lòng không trả lời email này.
              </p>
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                © ${new Date().getFullYear()} INVONE — Nền tảng Hóa Đơn Điện Tử Việt Nam
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export const EmailService = {
  async sendPasswordResetEmail(to: string, resetUrl: string, fullName: string): Promise<void> {
    const client = getResendClient();
    const fromEmail = env.RESEND_FROM_EMAIL ?? 'support@autopostvn.cloud';

    const { error } = await client.emails.send({
      from: `INVONE <${fromEmail}>`,
      to: [to],
      subject: 'Đặt lại mật khẩu INVONE của bạn',
      html: buildPasswordResetHtml(fullName, resetUrl),
    });

    if (error) {
      throw new Error(`[EmailService] Resend error: ${error.message}`);
    }
  },
};
