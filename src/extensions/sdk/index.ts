/**
 * Enspira Extension SDK
 *
 * This is the public API for extension developers.
 * Import from '@enspira/sdk' in your extension code.
 *
 * @module extensions/sdk
 *
 * @example
 * ```typescript
 * import {
 *   defineExtension,
 *   isEventType,
 *   createScopedLogger,
 *   type EnspiraEvent,
 *   type ExtensionContext
 * } from '@enspira/sdk';
 *
 * export default defineExtension({
 *   manifest: require('./manifest.json'),
 *
 *   async onLoad(context) {
 *     const log = createScopedLogger(context.logger, 'MyExtension');
 *     log.info('Extension loaded successfully!');
 *   },
 *
 *   async onEvent(event) {
 *     if (isEventType(event, 'twitch:follow')) {
 *       console.log(`New follower: ${event.user?.name}`);
 *     }
 *   }
 * });
 * ```
 */

// ==================== TYPE EXPORTS ====================

// Re-export all types
export type {
  // Permissions
  ExtensionPermission,

  // Manifest
  ExtensionManifest,
  ExtensionConfigSchema,
  ExtensionConfigProperty,
  ExtensionDependency,

  // Events
  EnspiraEventType,
  EnspiraEventSource,
  EnspiraEventUser,
  EnspiraEventMeta,
  EnspiraEvent,
  EnspiraResponse,

  // Context
  ExtensionStorage,
  Unsubscribe,
  EventHandler,
  EventBusClient,
  ReadonlyConfig,
  ExtensionContext,

  // Extension interface
  Extension,
  ExtensionState,
  LoadedExtension,

  // SDK helpers
  DefineExtensionConfig,
} from './types.js';

// ==================== HELPER EXPORTS ====================

// Export all helper functions
export {
  // Extension definition
  defineExtension,

  // Event helpers
  isEventType,
  isTwitchEvent,
  isSystemEvent,
  isAIEvent,
  isExtensionEvent,
  getTwitchUser,

  // Storage helpers
  createTypedStorage,
  type TypedStorage,

  // Response helpers
  createResponse,
  modifyResponseText,
  addResponseMetadata,
  type ResponseOptions,

  // Logging helpers
  createScopedLogger,
  type ScopedLogger,

  // Timing helpers
  debounce,
  throttle,
  sleep,

  // Validation helpers
  hasPermission,
  validateManifest,
} from './helpers.js';

// ==================== VERSION ====================

/**
 * SDK version - matches Enspira version
 */
export const SDK_VERSION = '2.0.0';

/**
 * Minimum Enspira version required for this SDK
 */
export const MIN_ENSPIRA_VERSION = '2.0.0';
