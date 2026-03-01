/**
 * Custom error classes and error handling utilities
 * @module utils/errors
 */

import { logger } from '../core/logger.js';

/** Error code types for consistent error categorization */
export type ErrorCode =
  | 'INTERNAL_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'DATABASE_ERROR'
  | 'EXTERNAL_API_ERROR'
  | string;

/** Log levels for error logging */
export type LogLevel = 'log' | 'warn' | 'error';

/** Options for ApplicationError construction */
export interface ApplicationErrorOptions {
  /** Error code for categorization */
  code?: ErrorCode;
  /** HTTP status code */
  statusCode?: number;
  /** Context for logging (e.g., 'Database', 'API', 'Auth') */
  context?: string;
  /** Additional error details */
  details?: Record<string, unknown> | null;
  /** Original error that caused this error */
  cause?: Error | null;
  /** Log level for automatic logging */
  logLevel?: LogLevel;
}

/** Formatted error response for API responses */
export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown> | null;
    timestamp: string;
  };
}

/**
 * Standard error class for consistent error handling across the application
 */
export class ApplicationError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly context: string;
  readonly details: Record<string, unknown> | null;
  override readonly cause: Error | null;
  readonly timestamp: Date;

  constructor(message: string, options: ApplicationErrorOptions = {}) {
    super(message);

    const {
      code = 'INTERNAL_ERROR',
      statusCode = 500,
      context = 'Application',
      details = null,
      cause = null,
      logLevel = 'error',
    } = options;

    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
    this.details = details;
    this.cause = cause;
    this.timestamp = new Date();

    // Log automatically on creation
    logger[logLevel](context, message);

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Creates a formatted response object for API responses
   */
  toResponse(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        timestamp: this.timestamp.toISOString(),
      },
    };
  }
}

/** Options for withErrorHandling wrapper */
export interface ErrorHandlingOptions<T> {
  /** Context for logging */
  context?: string;
  /** Value to return on error (if not rethrowing) */
  defaultValue?: T;
  /** Whether to rethrow the error after logging */
  rethrow?: boolean;
  /** Custom error formatter */
  errorFormatter?: ((error: Error) => Error) | null;
  /** Whether to log the error */
  logError?: boolean;
  /** Convert all errors to ApplicationError */
  captureAll?: boolean;
}

/**
 * Executes function with standard error handling
 * @param fn - Function to execute
 * @param options - Error handling options
 * @returns Function result or default value
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  options: ErrorHandlingOptions<T> = {}
): Promise<T> {
  const {
    context = 'Application',
    defaultValue = null as T,
    rethrow = false,
    errorFormatter = null,
    logError = true,
    captureAll = false,
  } = options;

  try {
    return await fn();
  } catch (error) {
    if (logError) {
      if (!(error instanceof ApplicationError)) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(context, message);
      }
      // ApplicationError already logs during construction
    }

    if (rethrow) {
      // Format error if requested
      if (errorFormatter && typeof errorFormatter === 'function') {
        throw errorFormatter(error as Error);
      }

      // Convert to ApplicationError if not already
      if (!(error instanceof ApplicationError) && captureAll) {
        const originalError = error as Error;
        throw new ApplicationError(originalError.message, {
          context,
          cause: originalError,
          details: {
            originalError: {
              name: originalError.name,
              stack: originalError.stack,
            },
          },
        });
      }

      throw error;
    }

    return defaultValue;
  }
}

/** Error handler function type */
export type ErrorHandler<T> = (
  fn: () => Promise<T>,
  options?: Omit<ErrorHandlingOptions<T>, 'context'>
) => Promise<T>;

/**
 * Creates an error handler for specific contexts
 * @param context - Error context name
 * @returns Configured error handler function
 */
export function createErrorHandler<T = unknown>(context: string): ErrorHandler<T> {
  return async (
    fn: () => Promise<T>,
    options: Omit<ErrorHandlingOptions<T>, 'context'> = {}
  ): Promise<T> => {
    return withErrorHandling(fn, {
      context,
      ...options,
    });
  };
}

/**
 * Type guard to check if an error is an ApplicationError
 */
export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}

/**
 * Wraps an unknown error into an ApplicationError
 */
export function wrapError(
  error: unknown,
  options: ApplicationErrorOptions = {}
): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }

  const originalError = error instanceof Error ? error : new Error(String(error));
  return new ApplicationError(originalError.message, {
    ...options,
    cause: originalError,
  });
}
