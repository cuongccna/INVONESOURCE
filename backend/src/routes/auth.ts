import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { z } from 'zod';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { AuthError, ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendError } from '../utils/response';
import { authenticate } from '../middleware/auth';

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    const { email, password } = parsed.data;

    const userResult = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.full_name,
              uc.role, uc.company_id
       FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id
       WHERE u.email = $1 AND u.is_active = true
       LIMIT 1`,
      [email]
    );
    const user = userResult.rows[0];
    if (!user) throw new AuthError('Invalid email or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new AuthError('Invalid email or password');

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role ?? 'VIEWER', companyId: user.company_id },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const refreshToken = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), user.id, hashToken(refreshToken), expiresAt]
    );

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      expires: expiresAt,
    });

    sendSuccess(res, {
      accessToken,
      user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, companyId: user.company_id },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.refreshToken as string | undefined;
    if (!token) throw new AuthError('No refresh token');

    const tokenResult = await pool.query(
      `SELECT rt.user_id, rt.expires_at, u.email,
              uc.role, uc.company_id
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       LEFT JOIN user_companies uc ON uc.user_id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.expires_at > NOW() AND rt.revoked_at IS NULL`,
      [hashToken(token)]
    );

    const row = tokenResult.rows[0];
    if (!row) throw new AuthError('Invalid or expired refresh token');

    const accessToken = jwt.sign(
      { userId: row.user_id, email: row.email, role: row.role ?? 'VIEWER', companyId: row.company_id },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    sendSuccess(res, { accessToken });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.refreshToken as string | undefined;
    if (token) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`,
        [hashToken(token)]
      );
    }
    res.clearCookie('refreshToken');
    sendSuccess(res, null, 'Logged out successfully');
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.phone, uc.role, uc.company_id
       FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id
       WHERE u.id = $1`,
      [req.user!.userId]
    );
    const user = result.rows[0];
    if (!user) throw new NotFoundError('User not found');
    sendSuccess(res, user);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/me — update profile (name, phone)
router.patch('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fullName, phone } = z.object({
      fullName: z.string().min(1).max(100).optional(),
      phone: z.string().max(20).optional().nullable(),
    }).parse(req.body);

    const result = await pool.query(
      `UPDATE users
       SET full_name = COALESCE($1, full_name),
           phone     = COALESCE($2, phone),
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, full_name, phone`,
      [fullName ?? null, phone ?? null, req.user!.userId]
    );
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8, 'Mật khẩu mới phải có ít nhất 8 ký tự'),
    }).parse(req.body);

    const result = await pool.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [req.user!.userId]
    );
    const user = result.rows[0];
    if (!user) throw new NotFoundError('User not found');

    const valid = await bcrypt.compare(currentPassword, user.password_hash as string);
    if (!valid) throw new AuthError('Mật khẩu hiện tại không đúng');

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, req.user!.userId]
    );

    // Revoke all refresh tokens to force re-login on other devices
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.user!.userId]
    );

    sendSuccess(res, null, 'Đổi mật khẩu thành công');
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);

    const userResult = await pool.query(
      `SELECT id FROM users WHERE email = $1 AND is_active = true`,
      [email]
    );
    // Always respond with success to avoid leaking user enumeration
    if (userResult.rows.length === 0) {
      sendSuccess(res, null, 'Nếu email tồn tại, bạn sẽ nhận được hướng dẫn');
      return;
    }

    const userId = userResult.rows[0].id as string;
    const rawToken = uuidv4();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Invalidate any existing unused tokens for this user
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [userId]
    );

    await pool.query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), userId, tokenHash, expiresAt]
    );

    // In production: send email with reset link; in dev: return token directly
    const isDev = env.NODE_ENV !== 'production';
    sendSuccess(res, isDev ? { resetToken: rawToken } : null, 'Nếu email tồn tại, bạn sẽ nhận được hướng dẫn');
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = z.object({
      token: z.string().min(1),
      newPassword: z.string().min(8, 'Mật khẩu phải có ít nhất 8 ký tự'),
    }).parse(req.body);

    const tokenHash = hashToken(token);

    const tokenResult = await pool.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL`,
      [tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      throw new AuthError('Token không hợp lệ hoặc đã hết hạn');
    }

    const { id: tokenId, user_id: userId } = tokenResult.rows[0] as { id: string; user_id: string };

    const newHash = await bcrypt.hash(newPassword, 12);

    // Update password and mark token as used in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [newHash, userId]
      );
      await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
        [tokenId]
      );
      // Revoke all refresh tokens to force re-login
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    sendSuccess(res, null, 'Đặt lại mật khẩu thành công');
  } catch (err) {
    next(err);
  }
});

export default router;
