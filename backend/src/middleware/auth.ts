import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AuthError, ForbiddenError } from '../utils/AppError';

export type UserRole = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER';

export type ViewMode = 'single' | 'group' | 'portfolio';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  companyId?: string;
  viewMode?: ViewMode;
  organizationId?: string | null;
  /** true when user is a platform superadmin — used by frontend to gate /admin layout only.
   *  Backend admin routes re-validate from DB (requireAdmin middleware). */
  is_platform_admin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export const authenticate: RequestHandler = (req, _res, next) => {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (typeof req.query.token === 'string' && req.query.token) {
    // Fallback for EventSource/SSE which cannot send custom headers
    token = req.query.token;
  }

  if (!token) {
    throw new AuthError('Missing or invalid authorization header');
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    throw new AuthError('Token is invalid or expired');
  }
};

export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) throw new AuthError();
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError('Insufficient permissions for this action');
    }
    next();
  };
