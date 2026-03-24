import { Response } from 'express';
import { AppError } from '../utils/AppError';

/**
 * Send a successful API response
 */
export function sendSuccess<T>(res: Response, data: T, message?: string, statusCode = 200): void {
  res.status(statusCode).json({
    success: true,
    data,
    ...(message ? { message } : {}),
  });
}

/**
 * Send a paginated API response
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  total: number,
  page: number,
  pageSize: number
): void {
  res.status(200).json({
    success: true,
    data,
    meta: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}

/**
 * Send an error response using AppError
 */
export function sendError(res: Response, error: AppError): void {
  res.status(error.statusCode).json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

/**
 * Send a generic error response (non-AppError)
 */
export function sendGenericError(
  res: Response,
  message: string,
  statusCode = 500,
  code = 'INTERNAL_ERROR'
): void {
  res.status(statusCode).json({
    success: false,
    error: { code, message },
  });
}
