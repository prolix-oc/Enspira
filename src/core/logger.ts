/**
 * Centralized logging system with file and UI output support
 * @module core/logger
 */

import moment from 'moment';
import fs from 'fs/promises';
import path from 'path';

/** Log message severity levels */
export type LogLevel = 'info' | 'error' | 'warn' | 'debug';

/** Blessed screen interface for terminal UI */
export interface BlessedScreen {
  render(): void;
}

/** Blessed log box interface for terminal UI */
export interface BlessedLogBox {
  pushLine(line: string): void;
}

/** Logger configuration options */
export interface LoggerOptions {
  /** Enable terminal UI logging via blessed */
  withUI?: boolean;
  /** Blessed log box widget for UI output */
  logBox?: BlessedLogBox | null;
  /** Blessed screen for rendering updates */
  screen?: BlessedScreen | null;
  /** Directory for log files (default: ./logs) */
  logDir?: string;
}

/** Logger interface for application-wide logging */
export interface Logger {
  /** Generic log with source context */
  log(source: string, message: string | object, type?: LogLevel): void;
  /** System-level log message */
  system(message: string | object): void;
  /** Error log with source context */
  error(source: string, message: string | object): void;
  /** Warning log with source context */
  warn(source: string, message: string | object): void;
  /** Info log with source context */
  info(source: string, message: string | object): void;
  /** Debug log with source context */
  debug(source: string, message: string | object): void;
  /** Write trace data to a specific file */
  trace(trace: string, dest: string): Promise<void>;
}

/** Console-style wrapper interface */
export interface LogConsole {
  log(message: string | object): void;
  info(message: string | object): void;
  warn(message: string | object): void;
  error(message: string | object): void;
  debug(message: string | object): void;
}

// Global type augmentation for shared logger
declare global {
  // eslint-disable-next-line no-var
  var logger: Logger | undefined;
  // eslint-disable-next-line no-var
  var _sharedObjects: { logger?: Logger } | undefined;
}

/** Default log directory */
const DEFAULT_LOG_DIR = './logs';

/**
 * Ensures the log directory exists
 */
async function ensureLogDir(logDir: string): Promise<void> {
  try {
    await fs.mkdir(logDir, { recursive: true });
  } catch {
    // Directory likely already exists
  }
}

/**
 * Creates a logger instance with optional terminal UI support
 *
 * @param options - Logger configuration
 * @returns Configured logger instance
 *
 * @example
 * ```ts
 * // Basic logger without UI
 * const logger = createLogger();
 * logger.info('MyModule', 'Application started');
 *
 * // Logger with blessed terminal UI
 * const uiLogger = createLogger({
 *   withUI: true,
 *   logBox: myLogBox,
 *   screen: myScreen
 * });
 * ```
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const {
    withUI = false,
    logBox = null,
    screen = null,
    logDir = DEFAULT_LOG_DIR,
  } = options;

  // Ensure log directory exists (fire and forget)
  void ensureLogDir(logDir);

  const getTimestamp = (): string => moment().format('MM/DD/YY [at] HH:mm');

  const formatLogMessage = (source: string, message: string | object): string => {
    const timestamp = getTimestamp();
    const formattedMessage =
      typeof message === 'string' ? message : JSON.stringify(message);
    return `{gray-fg}${timestamp}{/} [${source}] ${formattedMessage}`;
  };

  const logToScreen = (source: string, message: string | object): void => {
    if (withUI && logBox && screen) {
      const formattedLog = formatLogMessage(source, message);
      logBox.pushLine(formattedLog);
      screen.render();
    }
  };

  const logToFile = async (
    source: string,
    message: string | object,
    type: LogLevel
  ): Promise<void> => {
    try {
      const timestamp = getTimestamp();
      const formattedMessage =
        typeof message === 'string' ? message : JSON.stringify(message);
      const logEntry = `${timestamp} [${source}] [${type}] ${formattedMessage}\n`;

      // Append to daily log file
      const today = moment().format('YYYY-MM-DD');
      await fs.appendFile(path.join(logDir, `${today}.log`), logEntry);

      // Also append to type-specific log for errors and warnings
      if (type === 'error' || type === 'warn') {
        await fs.appendFile(path.join(logDir, `${type}.log`), logEntry);
      }
    } catch (err) {
      // If we can't log to file, at least try to show it on screen
      if (withUI && logBox && screen) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logBox.pushLine(`{red-fg}Error writing to log file: ${errorMessage}{/}`);
        screen.render();
      }
    }
  };

  const writeTrace = async (trace: string, dest: string): Promise<void> => {
    try {
      await fs.writeFile(path.join(logDir, dest), trace + '\n');
    } catch (err) {
      if (withUI && logBox && screen) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logBox.pushLine(`{red-fg}Error writing trace to file: ${errorMessage}{/}`);
        screen.render();
      }
    }
  };

  const logMessage = (
    source: string,
    message: string | object,
    type: LogLevel = 'info'
  ): void => {
    // Log to UI
    logToScreen(source, message);

    // Log to file (fire and forget to avoid blocking)
    void logToFile(source, message, type);
  };

  return {
    log: (source: string, message: string | object, type: LogLevel = 'info') =>
      logMessage(source, message, type),
    system: (message: string | object) => logMessage('System', message, 'info'),
    error: (source: string, message: string | object) => logMessage(source, message, 'error'),
    warn: (source: string, message: string | object) => logMessage(source, message, 'warn'),
    info: (source: string, message: string | object) => logMessage(source, message, 'info'),
    debug: (source: string, message: string | object) => logMessage(source, message, 'debug'),
    trace: writeTrace,
  };
}

/**
 * Gets the global logger instance, creating a fallback if necessary
 *
 * @returns The global logger or a new basic logger
 */
export function getLogger(): Logger {
  if (global._sharedObjects?.logger) {
    return global._sharedObjects.logger;
  }

  if (global.logger) {
    return global.logger;
  }

  // Fallback logger without UI
  return createLogger();
}

/**
 * Ensures the global logger is initialized and available
 *
 * @returns The global logger instance
 */
export function ensureGlobalLogger(): Logger {
  if (!global.logger && global._sharedObjects?.logger) {
    global.logger = global._sharedObjects.logger;
  }

  return global.logger ?? getLogger();
}

/**
 * Sets up the global logger with the provided instance
 *
 * @param loggerInstance - Logger to set as global
 */
export function setGlobalLogger(loggerInstance: Logger): void {
  global.logger = loggerInstance;

  if (!global._sharedObjects) {
    global._sharedObjects = {};
  }
  global._sharedObjects.logger = loggerInstance;
}

/** Shared logger instance for module imports */
export const logger: Logger = getLogger();

// Ensure the global logger is available on module load
ensureGlobalLogger();

/**
 * Console-style wrapper for direct logging
 * Maps standard console methods to the logger
 */
export const logConsole: LogConsole = {
  log: (message: string | object) => logger.info('Console', message),
  info: (message: string | object) => logger.info('Console', message),
  warn: (message: string | object) => logger.warn('Console', message),
  error: (message: string | object) => logger.error('Console', message),
  debug: (message: string | object) => logger.debug('Console', message),
};

export default logger;
