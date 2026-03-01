/**
 * Enspira Extension SDK - Type Exports
 * Re-exports all types needed for extension development
 * @module extensions/sdk/types
 */

// Re-export all extension types for extension developers
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
} from '../../types/extension.types.js';
