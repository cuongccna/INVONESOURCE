/**
 * SSE Authentication Middleware (SEC-01)
 *
 * EventSource cannot send custom headers (Authorization: Bearer), so
 * historically JWT was passed in query params which leaks session data.
 *
 * Solution: Short-lived SSE tokens (30s TTL) stored in Redis.
 *   1. Frontend calls POST /api/sync/sse-token to get a single-use token.
 *   2. Frontend appends ?sseToken=xxx to EventSource URL.
 *   3. This middleware validates the SSE token from Redis and injects req.user.
 */

import { RequestHandler, Request } from 'express';
import Redis from 'ioredis';
import { env } from '../config/env';
import { AuthError } from '../utils/AppError';
import type { JwtPayload } from './auth';

const SSE_TOKEN_PREFIX = 'sse:token:';

let _redis: Redis | null = null;
export function getSseRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return _redis;
}

/**
 * Extract and validate an SSE short-lived token from query params.
 * If valid, injects req.user. If missing/invalid, calls next(error).
 *
 * This is intended to be used BEFORE the main authenticate middleware
 * on SSE routes only.
 */
export const sseTokenAuth: RequestHandler = async (req, _res, next) => {
  const sseToken = typeof req.query.sseToken === 'string' ? req.query.sseToken : null;

  if (!sseToken) {
    return next(new AuthError('Missing SSE token'));
  }

  try {
    const redis = getSseRedis();
    const raw = await redis.get(`${SSE_TOKEN_PREFIX}${sseToken}`);

    if (!raw) {
      return next(new AuthError('SSE token expired or invalid'));
    }

    // Single-use: delete immediately after read
    await redis.del(`${SSE_TOKEN_PREFIX}${sseToken}`);

    const payload = JSON.parse(raw) as {
      userId: string;
      companyId: string | null;
      viewMode?: string;
      organizationId?: string | null;
    };

    // Populate req.user for downstream middleware (requireCompany etc.)
    (req as Request & { user: JwtPayload }).user = {
      userId: payload.userId,
      email: '', // minimal — SSE doesn't need email
      role: 'VIEWER', // conservative default; actual access checked per-route
      companyId: payload.companyId ?? undefined,
      viewMode: (payload.viewMode as JwtPayload['viewMode']) ?? 'single',
      organizationId: payload.organizationId ?? null,
    };

    next();
  } catch (err) {
    next(new AuthError('SSE token verification failed'));
  }
};

/**
 * Generate an SSE token payload and store in Redis.
 * Returns the raw token string.
 */
export async function createSseToken(
  userId: string,
  companyId: string | null,
  ttlSeconds = 30,
): Promise<string> {
  const crypto = await import('crypto');
  const rawToken = crypto.randomBytes(32).toString('hex');
  const payload = {
    userId,
    companyId,
    viewMode: 'single',
    organizationId: null,
  };

  const redis = getSseRedis();
  await redis.set(
    `${SSE_TOKEN_PREFIX}${rawToken}`,
    JSON.stringify(payload),
    'EX',
    ttlSeconds,
  );

  return rawToken;
}
