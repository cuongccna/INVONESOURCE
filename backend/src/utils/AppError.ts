/**
 * Base application error class.
 * All custom errors should extend this.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Connector-specific error — wraps plugin errors with plugin id context.
 * Auto-prefixes message: "[misa] Failed to authenticate: ..."
 */
export class ConnectorError extends AppError {
  readonly pluginId: string;
  readonly originalError?: unknown;

  constructor(pluginId: string, message: string, originalError?: unknown) {
    super(`[${pluginId}] ${message}`, 502, 'CONNECTOR_ERROR');
    this.name = 'ConnectorError';
    this.pluginId = pluginId;
    this.originalError = originalError;
    Object.setPrototypeOf(this, ConnectorError.prototype);
  }
}

/**
 * Authentication error (401)
 */
export class AuthError extends AppError {
  constructor(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    super(message, 401, code);
    this.name = 'AuthError';
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/**
 * Authorization error (403)
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
    Object.setPrototypeOf(this, ForbiddenError.prototype);
  }
}

/**
 * Not found error (404)
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}
