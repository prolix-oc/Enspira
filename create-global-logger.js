import { getLogger } from './logger.js';

// Export the shared logger instance so it can be imported by other modules
export const logger = getLogger();

// Define a function to ensure the global logger is set up
export function ensureGlobalLogger() {
  if (!global.logger && global._sharedObjects && global._sharedObjects.logger) {
    global.logger = global._sharedObjects.logger;
  }
  
  return global.logger || logger;
}

// Ensure the global logger is available
ensureGlobalLogger();

// For modules that need direct console access, provide a console wrapper
export const logConsole = {
  log: (message) => logger.log("Console", message),
  info: (message) => logger.info(message),
  warn: (message) => logger.warn(message),
  error: (message) => logger.error("Console", message),
  debug: (message) => logger.debug(message)
};