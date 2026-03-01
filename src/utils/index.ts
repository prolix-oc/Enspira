/**
 * Utilities barrel export for Enspira
 * Import from '@/utils' for all utility functions
 * @module utils
 */

// Re-export all utilities
export * from './cache.js';
export * from './errors.js';
export * from './files.js';
export * from './strings.js';
export * from './api-client.js';

// Import commonly used utilities for convenient grouped access
import {
  createCache,
  type Cache,
  type CacheOptions,
  type CacheStats,
} from './cache.js';

import {
  ApplicationError,
  withErrorHandling,
  createErrorHandler,
  isApplicationError,
  wrapError,
  type ErrorCode,
  type ErrorHandlingOptions,
} from './errors.js';

import {
  getTemplate,
  readMultipleFiles,
  safeWriteJSON,
  safeReadJSON,
  clearTemplateCache,
  fileExists,
  ensureDirectory,
} from './files.js';

import {
  replacePlaceholders,
  escapeRegExp,
  transformTtsText,
  truncateWithEllipsis,
  capitalize,
  toKebabCase,
  toCamelCase,
  normalizeWhitespace,
} from './strings.js';

import {
  createApiClient,
  makeRequestWithRetry,
  submitFormData,
  fetchWithRetry,
  postWithRetry,
  type ApiClientOptions,
  type RetryOptions,
} from './api-client.js';

/**
 * Grouped utility exports for convenient namespace access
 *
 * @example
 * ```ts
 * import { utils } from '@/utils';
 *
 * const cache = utils.cache.createCache({ maxSize: 100 });
 * const template = await utils.file.getTemplate('/path/to/template.txt');
 * ```
 */
export const utils = {
  /** File system utilities */
  file: {
    getTemplate,
    readMultipleFiles,
    safeWriteJSON,
    safeReadJSON,
    clearTemplateCache,
    fileExists,
    ensureDirectory,
  },

  /** HTTP client utilities */
  api: {
    createApiClient,
    makeRequestWithRetry,
    submitFormData,
    fetchWithRetry,
    postWithRetry,
  },

  /** In-memory cache utilities */
  cache: {
    createCache,
  },

  /** String manipulation utilities */
  string: {
    replacePlaceholders,
    escapeRegExp,
    transformTtsText,
    truncateWithEllipsis,
    capitalize,
    toKebabCase,
    toCamelCase,
    normalizeWhitespace,
  },

  /** Error handling utilities */
  error: {
    ApplicationError,
    withErrorHandling,
    createErrorHandler,
    isApplicationError,
    wrapError,
  },
} as const;

// Type exports for convenience
export type {
  Cache,
  CacheOptions,
  CacheStats,
  ErrorCode,
  ErrorHandlingOptions,
  ApiClientOptions,
  RetryOptions,
};

export default utils;
