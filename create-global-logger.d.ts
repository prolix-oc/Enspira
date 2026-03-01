/**
 * Type declarations for the global logger module
 * This is a temporary declaration file until logger.js is migrated to TypeScript
 */

/** Log message type */
export type LogType = 'info' | 'error' | 'warn' | 'debug';

/** Logger interface matching logger.js implementation */
export interface Logger {
  /** Generic log with source context */
  log(source: string, message: string | object, type?: LogType): void;
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
  /** Write trace to file */
  trace(trace: string, dest: string): Promise<void>;
}

/** Console wrapper interface */
export interface LogConsole {
  log(message: string | object): void;
  info(message: string | object): void;
  warn(message: string | object): void;
  error(message: string | object): void;
  debug(message: string | object): void;
}

/** Shared logger instance */
export const logger: Logger;

/** Ensure global logger is initialized */
export function ensureGlobalLogger(): Logger;

/** Console wrapper for direct logging */
export const logConsole: LogConsole;
