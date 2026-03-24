import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import { env } from '../config/env';
import { v4 as uuidv4 } from 'uuid';

/**
 * Middleware: attach requestId to every request for tracing
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  res.locals['requestId'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

/**
 * Global Express error handler.
 * Never exposes stack traces in production.
 * Logs with requestId, userId, companyId context.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = res.locals['requestId'] as string;
  const userId = res.locals['userId'] as string | undefined;
  const companyId = res.locals['companyId'] as string | undefined;

  if (err instanceof AppError && err.isOperational) {
    // Known operational error — log at warn level
    console.warn(
      JSON.stringify({
        level: 'warn',
        requestId,
        userId,
        companyId,
        code: err.code,
        message: err.message,
        statusCode: err.statusCode,
      })
    );

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  // Unexpected error — log at error level with full context
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      userId,
      companyId,
      message: err.message,
      name: err.name,
      // Only include stack in development
      stack: env.NODE_ENV === 'development' ? err.stack : undefined,
    })
  );

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message:
        env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : err.message,
    },
  });
}

/**
 * 404 handler for unmatched routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
}
