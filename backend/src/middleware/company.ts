import { RequestHandler } from 'express';
import { pool } from '../db/pool';
import { ForbiddenError } from '../utils/AppError';
import type { UserRole } from './auth';

/**
 * requireCompany middleware — multi-company support.
 *
 * Reads the optional `X-Company-Id` request header. If it differs from the
 * company embedded in the JWT, the user's access to that company is verified
 * and req.user.companyId + req.user.role are updated for this request.
 *
 * Must run AFTER authenticate (req.user must already be set).
 * Safe to skip if no X-Company-Id header is sent.
 */
export const requireCompany: RequestHandler = async (req, _res, next) => {
  if (!req.user) return next();

  const headerCompanyId = req.headers['x-company-id'] as string | undefined;
  if (!headerCompanyId || headerCompanyId === req.user.companyId) return next();

  try {
    const { rows } = await pool.query<{ role: UserRole }>(
      `SELECT uc.role
       FROM user_companies uc
       JOIN companies c ON c.id = uc.company_id
       WHERE uc.user_id = $1 AND uc.company_id = $2 AND c.deleted_at IS NULL`,
      [req.user.userId, headerCompanyId]
    );
    if (!rows.length) throw new ForbiddenError('No access to this company');

    req.user.companyId = headerCompanyId;
    req.user.role = rows[0].role;
  } catch (err) {
    return next(err);
  }

  next();
};
