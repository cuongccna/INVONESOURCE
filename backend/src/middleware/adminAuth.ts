/**
 * Admin-only middleware (GROUP 44 — LIC-03)
 *
 * Validates is_platform_admin from DB on each request — NOT from JWT.
 * This ensures revocation takes effect immediately (no 1-hour JWT TTL lag).
 *
 * Chain: authenticate (JWT) → requireAdmin (DB check)
 */
import { RequestHandler } from 'express';
import { pool } from '../db/pool';
import { AuthError, ForbiddenError } from '../utils/AppError';

export const requireAdmin: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user?.userId) throw new AuthError();

    const { rows } = await pool.query<{ is_platform_admin: boolean }>(
      `SELECT is_platform_admin FROM users WHERE id = $1 AND is_active = true`,
      [req.user.userId],
    );

    if (!rows.length || !rows[0]!.is_platform_admin) {
      throw new ForbiddenError('Chỉ Admin hệ thống mới có quyền truy cập');
    }

    next();
  } catch (err) {
    next(err);
  }
};
