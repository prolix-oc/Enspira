/**
 * Enspira Extension SDK - Helper Functions
 * Utility functions to simplify extension development
 * @module extensions/sdk/helpers
 */

import type {
  Extension,
  ExtensionManifest,
  ExtensionContext,
  EnspiraEvent,
  EnspiraResponse,
  EnspiraEventType,
  DefineExtensionConfig,
} from './types.js';

// ==================== EXTENSION DEFINITION ====================

/**
 * Helper function to define an extension with proper typing
 * This is the recommended way to create extensions
 *
 * @example
 * ```typescript
 * import { defineExtension } from '@enspira/sdk';
 *
 * export default defineExtension({
 *   manifest: require('./manifest.json'),
 *
 *   async onLoad(context) {
 *     context.logger.info('MyExtension', 'Extension loaded!');
 *   },
 *
 *   async onEvent(event) {
 *     if (event.type === 'twitch:follow') {
 *       console.log(`New follower: ${event.user?.name}`);
 *     }
 *   }
 * });
 * ```
 */
export function defineExtension(config: DefineExtensionConfig): Extension {
  return {
    manifest: config.manifest,
    onLoad: config.onLoad,
    onUnload: config.onUnload,
    onEnable: config.onEnable,
    onDisable: config.onDisable,
    onEvent: config.onEvent,
    beforeEvent: config.beforeEvent,
    afterResponse: config.afterResponse,
  };
}

// ==================== EVENT HELPERS ====================

/**
 * Check if an event is of a specific type
 *
 * @example
 * ```typescript
 * if (isEventType(event, 'twitch:follow')) {
 *   // event.data is typed for follow events
 * }
 * ```
 */
export function isEventType<T extends EnspiraEventType>(
  event: EnspiraEvent,
  type: T
): event is EnspiraEvent & { type: T } {
  return event.type === type;
}

/**
 * Check if an event is a Twitch event
 */
export function isTwitchEvent(event: EnspiraEvent): boolean {
  return event.type.startsWith('twitch:');
}

/**
 * Check if an event is a system event
 */
export function isSystemEvent(event: EnspiraEvent): boolean {
  return event.type.startsWith('system:');
}

/**
 * Check if an event is an AI event
 */
export function isAIEvent(event: EnspiraEvent): boolean {
  return event.type.startsWith('ai:');
}

/**
 * Check if an event is from an extension
 */
export function isExtensionEvent(event: EnspiraEvent): boolean {
  return event.type.startsWith('extension:');
}

/**
 * Extract Twitch user from event data
 */
export function getTwitchUser(event: EnspiraEvent): { id: string; name: string } | null {
  if (event.user) {
    return { id: event.user.id, name: event.user.name };
  }

  // Try to extract from data
  const data = event.data;
  if (typeof data.user === 'string' && typeof data.userId === 'string') {
    return { id: data.userId, name: data.user };
  }
  if (typeof data.user_id === 'string' && typeof data.user_name === 'string') {
    return { id: data.user_id, name: data.user_name };
  }

  return null;
}

// ==================== STORAGE HELPERS ====================

/**
 * Create a typed storage wrapper
 *
 * @example
 * ```typescript
 * interface MyData {
 *   count: number;
 *   lastSeen: string;
 * }
 *
 * const storage = createTypedStorage<MyData>(context.storage);
 * storage.set('count', 42);
 * const count = storage.get('count'); // number | undefined
 * ```
 */
export function createTypedStorage<T extends Record<string, unknown>>(
  storage: ExtensionContext['storage']
): TypedStorage<T> {
  return {
    get: <K extends keyof T>(key: K): T[K] | undefined => {
      return storage.get(key as string) as T[K] | undefined;
    },
    set: <K extends keyof T>(key: K, value: T[K]): void => {
      storage.set(key as string, value);
    },
    delete: (key: keyof T): boolean => {
      return storage.delete(key as string);
    },
    has: (key: keyof T): boolean => {
      return storage.has(key as string);
    },
  };
}

export interface TypedStorage<T extends Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K] | undefined;
  set<K extends keyof T>(key: K, value: T[K]): void;
  delete(key: keyof T): boolean;
  has(key: keyof T): boolean;
}

// ==================== RESPONSE HELPERS ====================

/**
 * Create a simple text response
 */
export function createResponse(text: string, options: ResponseOptions = {}): EnspiraResponse {
  return {
    text,
    audioUrl: options.audioUrl,
    expression: options.expression,
    metadata: options.metadata,
  };
}

export interface ResponseOptions {
  audioUrl?: string;
  expression?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Modify a response's text
 */
export function modifyResponseText(
  response: EnspiraResponse,
  modifier: (text: string) => string
): EnspiraResponse {
  return {
    ...response,
    text: modifier(response.text),
  };
}

/**
 * Append to response metadata
 */
export function addResponseMetadata(
  response: EnspiraResponse,
  metadata: Record<string, unknown>
): EnspiraResponse {
  return {
    ...response,
    metadata: {
      ...response.metadata,
      ...metadata,
    },
  };
}

// ==================== LOGGING HELPERS ====================

/**
 * Create a scoped logger for a specific category
 *
 * @example
 * ```typescript
 * const log = createScopedLogger(context.logger, 'MyExtension');
 * log.info('Starting up...');
 * log.error('Something went wrong!');
 * ```
 */
export function createScopedLogger(
  logger: ExtensionContext['logger'],
  category: string
): ScopedLogger {
  return {
    log: (message: string) => logger.log(category, message),
    info: (message: string) => logger.info(category, message),
    warn: (message: string) => logger.warn(category, message),
    error: (message: string) => logger.error(category, message),
    debug: (message: string) => logger.debug(category, message),
  };
}

export interface ScopedLogger {
  log(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

// ==================== TIMING HELPERS ====================

/**
 * Debounce a function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Throttle a function
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  };
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== VALIDATION HELPERS ====================

/**
 * Validate that required permissions are present
 */
export function hasPermission(
  manifest: ExtensionManifest,
  permission: string
): boolean {
  return manifest.permissions?.includes(permission as any) ?? false;
}

/**
 * Validate manifest has all required fields
 */
export function validateManifest(manifest: unknown): manifest is ExtensionManifest {
  if (!manifest || typeof manifest !== 'object') return false;

  const obj = manifest as Record<string, unknown>;
  const required = ['id', 'name', 'version', 'author', 'description', 'main'];

  for (const field of required) {
    if (!obj[field] || typeof obj[field] !== 'string') {
      return false;
    }
  }

  return true;
}
