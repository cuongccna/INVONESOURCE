import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
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
  /** Per-login session id — used for single-session enforcement.
   *  When a new login occurs, previous sessions are invalidated immediately. */
  sessionId?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ── Session enforcement Redis ────────────────────────────────────────────────
// Redis key: user:session:{userId} → sessionId (set on login, TTL = 7d)
// When a new login happens, the key updates → old JWTs with stale sessionId are rejected.

const SESSION_KEY_PREFIX = 'user:session:';

let _sessionRedis: Redis | null = null;
function getSessionRedis(): Redis {
  if (!_sessionRedis) {
    _sessionRedis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableReadyCheck: false,
    });
    _sessionRedis.connect().catch(() => {
      // Redis unavailable — session check will be skipped (graceful degradation)
    });
  }
  return _sessionRedis;
}

/** Store the active session id for a user. Called on login. */
export async function setActiveSession(userId: string, sessionId: string): Promise<void> {
  try {
    const redis = getSessionRedis();
    await redis.set(`${SESSION_KEY_PREFIX}${userId}`, sessionId, 'EX', 7 * 24 * 3600);
  } catch {
    // Redis down — silently skip, login still works
  }
}

/** Check if the given sessionId is still the active one. */
async function isSessionActive(userId: string, sessionId: string): Promise<boolean> {
  try {
    const redis = getSessionRedis();
    const active = await redis.get(`${SESSION_KEY_PREFIX}${userId}`);
    // If no key exists (Redis cleared, first login, etc.) → allow
    if (!active) return true;
    return active === sessionId;
  } catch {
    // Redis down → allow (graceful degradation, never block on Redis failure)
    return true;
  }
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (typeof req.query.token === 'string' && req.query.token) {
    // Fallback for EventSource/SSE which cannot send custom headers
    token = req.query.token;
  }

  if (!token) {
    return next(new AuthError('Missing or invalid authorization header'));
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    // ── Single-session enforcement ────────────────────────────────────────
    // If the JWT has a sessionId, verify it's still the active session.
    // Old JWTs (before this feature) have no sessionId → skip check (backward compat).
    if (payload.sessionId) {
      const active = await isSessionActive(payload.userId, payload.sessionId);
      if (!active) {
        return next(new AuthError('Phiên đăng nhập đã hết hạn do đăng nhập từ thiết bị khác', 'SESSION_REVOKED'));
      }
    }

    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof AuthError) return next(err);
    next(new AuthError('Token is invalid or expired'));
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
