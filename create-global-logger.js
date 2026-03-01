/**
 * Shim file for backwards compatibility with remaining JS files
 * Re-exports logger from the new TypeScript location
 */

export { logger, createLogger } from './src/core/logger.js';
