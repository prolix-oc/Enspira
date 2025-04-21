import { logger } from '../create-global-logger.js';

/**
 * Standard error structure for consistent error handling
 */
export class ApplicationError extends Error {
  constructor(message, options = {}) {
    super(message);
    
    const {
      code = 'INTERNAL_ERROR',
      statusCode = 500,
      context = 'Application',
      details = null,
      cause = null,
      logLevel = 'error'
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
   * Creates a formatted response object
   * @returns {object} - Response error object
   */
  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        timestamp: this.timestamp.toISOString()
      }
    };
  }
}

/**
 * Executes function with standard error handling
 * @param {function} fn - Function to execute
 * @param {object} [options] - Error handling options
 * @returns {Promise<any>} - Function result or error
 */
export async function withErrorHandling(fn, options = {}) {
  const {
    context = 'Application',
    defaultValue = null,
    rethrow = false,
    errorFormatter = null,
    logError = true,
    captureAll = false
  } = options;
  
  try {
    return await fn();
  } catch (error) {
    if (logError) {
      if (error instanceof ApplicationError) {
        // Already logged during creation
      } else {
        logger.error(context, `${error.message}`);
      }
    }
    
    if (rethrow) {
      // Format error if requested
      if (errorFormatter && typeof errorFormatter === 'function') {
        throw errorFormatter(error);
      }
      
      // Convert to ApplicationError if not already
      if (!(error instanceof ApplicationError) && captureAll) {
        throw new ApplicationError(error.message, {
          context,
          cause: error,
          details: {
            originalError: {
              name: error.name,
              stack: error.stack
            }
          }
        });
      }
      
      throw error;
    }
    
    return defaultValue;
  }
}

/**
 * Creates an error handler for specific contexts
 * @param {string} context - Error context name
 * @returns {function} - Configured error handler
 */
export function createErrorHandler(context) {
  return async (fn, options = {}) => {
    return withErrorHandling(fn, {
      context,
      ...options
    });
  };
}