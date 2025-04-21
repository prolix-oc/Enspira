// Barrel file to easily export all utilities
export * from './file-utils.js';
export * from './api-utils.js';
export * from './cache-utils.js';
export * from './string-utils.js';
export * from './error-utils.js';

// Import commonly used utilities for quick access
import { getTemplate, readMultipleFiles, safeWriteJSON } from './file-utils.js';
import { makeRequestWithRetry, createApiClient } from './api-utils.js';
import { createCache } from './cache-utils.js';
import { replacePlaceholders, transformTtsText } from './string-utils.js';
import { withErrorHandling, ApplicationError } from './error-utils.js';

// Export common combinations
export const utils = {
  file: {
    getTemplate,
    readMultipleFiles,
    safeWriteJSON
  },
  api: {
    makeRequestWithRetry,
    createApiClient
  },
  cache: {
    createCache
  },
  string: {
    replacePlaceholders,
    transformTtsText
  },
  error: {
    withErrorHandling,
    ApplicationError
  }
};

export default utils;