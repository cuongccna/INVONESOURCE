import { RequestHandler } from 'express';
import { pool } from '../db/pool';
import { ForbiddenError } from '../utils/AppError';
import type { UserRole, ViewMode } from './auth';

/**
 * requireCompany middleware — multi-company + view-mode support.
 *
 * 1. Reads `X-View-Mode` header (single | group | portfolio). Defaults to 'single'.
 * 2. Reads `X-Organization-Id` header for group view.
 * 3. Reads `X-Company-Id` header and verifies access (single mode).
 *
 * Must run AFTER authenticate (req.user must already be set).
 */
export const requireCompany: RequestHandler = async (req, _res, next) => {
  if (!req.user) return next();

  // Parse view-mode headers (safe defaults)
  const rawMode = (req.headers['x-view-mode'] as string | undefined) ?? 'single';
  const viewMode: ViewMode = (['single', 'group', 'portfolio'] as const).includes(rawMode as ViewMode)
    ? (rawMode as ViewMode)
    : 'single';

  req.user.viewMode = viewMode;
  req.user.organizationId = (req.headers['x-organization-id'] as string | undefined) ?? null;

  // For group/portfolio we skip per-company RBAC; data services enforce user ownership
  if (viewMode !== 'single') return next();

  const headerCompanyId = req.headers['x-company-id'] as string | undefined;

  console.debug(
    `[requireCompany] userId=${req.user.companyId ? req.user.userId : 'n/a'}` +
    ` jwtCompanyId=${req.user.companyId ?? 'null'}` +
    ` headerCompanyId=${headerCompanyId ?? 'null'}` +
    ` match=${headerCompanyId === req.user.companyId}` +
    ` url=${req.method} ${req.originalUrl}`
  );

  // If header is absent (or same as JWT claim), validate that the JWT companyId
  // is still active for this user.  Stale JWTs can carry a soft-deleted company.
  if (!headerCompanyId || headerCompanyId === req.user.companyId) {
    try {
      const { rows } = await pool.query<{ role: UserRole }>(
        `SELECT uc.role
         FROM user_companies uc
         JOIN companies c ON c.id = uc.company_id
         WHERE uc.user_id = $1 AND uc.company_id = $2 AND c.deleted_at IS NULL`,
        [req.user.userId, req.user.companyId]
      );
      if (rows.length) {
        req.user.role = rows[0].role;
        return next();
      }
      // JWT companyId is stale (deleted) → fall back to user's first valid company
      const { rows: fallback } = await pool.query<{ company_id: string; role: UserRole }>(
        `SELECT uc.company_id, uc.role
         FROM user_companies uc
         JOIN companies c ON c.id = uc.company_id
         WHERE uc.user_id = $1 AND c.deleted_at IS NULL
         ORDER BY c.name ASC
         LIMIT 1`,
        [req.user.userId]
      );
      if (!fallback.length) throw new ForbiddenError('No active company found for this user');
      req.user.companyId = fallback[0].company_id;
      req.user.role = fallback[0].role;
    } catch (err) {
      return next(err);
    }
    return next();
  }

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
    //console.debug(`[requireCompany] switched to header company → ${req.user.companyId}`);
  } catch (err) {
    return next(err);
  }

  next();
};
