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

  // PostgreSQL constraint violations — convert to user-friendly 409/422
  const pgErr = err as unknown as Record<string, unknown>;
  const pgCode = pgErr['code'];
  const pgConstraint = pgErr['constraint'] as string | undefined;
  const pgTable = pgErr['table'] as string | undefined;
  const pgDetail = pgErr['detail'] as string | undefined;
  if (typeof pgCode === 'string') {
    if (pgCode === '23505') {
      // Unique constraint violation
      let message = 'Dữ liệu đã tồn tại, vui lòng kiểm tra lại';
      if (pgConstraint?.includes('tax_code')) {
        message = 'Mã số thuế này đã được đăng ký trong hệ thống';
      } else if (pgConstraint?.includes('email')) {
        message = 'Email này đã được đăng ký';
      } else if (pgConstraint?.includes('invoice_number') || pgConstraint?.includes('uq_invoice')) {
        message = 'Hóa đơn đã tồn tại (trùng số hóa đơn)';
      }
      console.warn(JSON.stringify({ level: 'warn', requestId, code: '23505', constraint: pgConstraint, table: pgTable }));
      res.status(409).json({ success: false, error: { code: 'DUPLICATE', message } });
      return;
    }
    if (pgCode === '23503') {
      // Foreign key violation — log full detail for debugging
      console.error(JSON.stringify({ level: 'error', requestId, code: '23503', constraint: pgConstraint, table: pgTable, detail: pgDetail, message: err.message }));
      res.status(422).json({ success: false, error: { code: 'REFERENCE_ERROR', message: `Lỗi ràng buộc dữ liệu${pgTable ? ` (bảng: ${pgTable})` : ''} — liên hệ admin` } });
      return;
    }
    if (pgCode === '23502') {
      // Not null violation
      res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Thiếu thông tin bắt buộc' } });
      return;
    }
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
