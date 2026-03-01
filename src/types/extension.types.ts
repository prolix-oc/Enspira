/**
 * Extension system type definitions for Enspira
 * Provides types for third-party extensions to integrate with the event system
 * @module types/extension
 */

import type { Logger } from '../core/logger.js';

// ==================== PERMISSIONS ====================

/**
 * Permissions that an extension can request
 */
export type ExtensionPermission =
  | 'events:read'      // Receive events from the event bus
  | 'events:modify'    // Modify events before processing (middleware)
  | 'config:read'      // Read Enspira configuration values
  | 'user:read'        // Read user data from the database
  | 'response:inject'; // Inject responses into chat output

// ==================== MANIFEST ====================

/**
 * Extension manifest - describes the extension and its requirements
 * Loaded from manifest.json in the extension directory
 */
export interface ExtensionManifest {
  /** Unique identifier in reverse-domain format: "com.example.my-extension" */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Semantic version string: "1.0.0" */
  version: string;
  /** Extension author name or organization */
  author: string;
  /** Brief description of the extension's purpose */
  description: string;
  /** Minimum Enspira version required: ">=2.0.0" */
  enspiraVersion: string;
  /** Main entry point file relative to extension root */
  main: string;
  /** Optional list of event types to subscribe to (defaults to all) */
  events?: string[];
  /** Permissions requested by this extension */
  permissions?: ExtensionPermission[];
  /** Optional extension configuration schema */
  configSchema?: ExtensionConfigSchema;
  /** Optional dependencies on other extensions */
  dependencies?: ExtensionDependency[];
}

/**
 * JSON Schema definition for extension configuration
 */
export interface ExtensionConfigSchema {
  type: 'object';
  properties: Record<string, ExtensionConfigProperty>;
  required?: string[];
}

/**
 * Property definition in extension config schema
 */
export interface ExtensionConfigProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: unknown;
  enum?: unknown[];
}

/**
 * Dependency on another extension
 */
export interface ExtensionDependency {
  id: string;
  version: string;
}

// ==================== EVENTS ====================

/**
 * Event types that can be published through the event bus
 */
export type EnspiraEventType =
  // Twitch events
  | 'twitch:chat'
  | 'twitch:follow'
  | 'twitch:subscribe'
  | 'twitch:gift'
  | 'twitch:cheer'
  | 'twitch:raid'
  | 'twitch:stream.online'
  | 'twitch:stream.offline'
  | 'twitch:redemption'
  | 'twitch:hype.start'
  | 'twitch:hype.update'
  | 'twitch:hype.end'
  // System events
  | 'system:startup'
  | 'system:shutdown'
  | 'system:config.changed'
  | 'system:extension.loaded'
  | 'system:extension.unloaded'
  // AI events
  | 'ai:response.generating'
  | 'ai:response.generated'
  | 'ai:response.sent'
  // Extension custom events (extensible via template literal)
  | `extension:${string}`;

/**
 * Source of an event
 */
export type EnspiraEventSource = 'twitch' | 'api' | 'internal' | 'extension';

/**
 * User information attached to events
 */
export interface EnspiraEventUser {
  /** User's unique identifier */
  id: string;
  /** User's display name */
  name: string;
  /** Roles: 'broadcaster', 'moderator', 'subscriber', 'vip', etc. */
  roles: string[];
}

/**
 * Event metadata
 */
export interface EnspiraEventMeta {
  /** ID of extension that originated this event (for extension events) */
  extensionId?: string;
  /** Whether the event has been processed by the core */
  processed?: boolean;
  /** Whether a response was generated for this event */
  responseGenerated?: boolean;
  /** Timestamp when event was received */
  receivedAt?: Date;
  /** Any additional custom metadata */
  [key: string]: unknown;
}

/**
 * Core event structure for the extension system
 */
export interface EnspiraEvent {
  /** Unique event identifier (UUID) */
  id: string;
  /** When the event occurred */
  timestamp: Date;
  /** Event type from EnspiraEventType union */
  type: EnspiraEventType;
  /** Where the event originated */
  source: EnspiraEventSource;
  /** Event-specific data payload */
  data: Record<string, unknown>;
  /** User associated with the event (if applicable) */
  user?: EnspiraEventUser;
  /** Event metadata */
  meta?: EnspiraEventMeta;
}

/**
 * Response structure that can be modified by extensions
 */
export interface EnspiraResponse {
  /** Text content of the response */
  text: string;
  /** URL to generated TTS audio (if applicable) */
  audioUrl?: string;
  /** Expression/emotion to display */
  expression?: string;
  /** Additional response metadata */
  metadata?: Record<string, unknown>;
}

// ==================== STORAGE ====================

/**
 * Key-value storage interface for extensions
 * Each extension gets isolated SQLite storage
 */
export interface ExtensionStorage {
  /**
   * Get a value from storage
   * @param key - Storage key
   * @returns The stored value or undefined
   */
  get<T = unknown>(key: string): T | undefined;

  /**
   * Set a value in storage
   * @param key - Storage key
   * @param value - Value to store (will be JSON serialized)
   */
  set<T = unknown>(key: string, value: T): void;

  /**
   * Delete a value from storage
   * @param key - Storage key
   * @returns true if the key existed and was deleted
   */
  delete(key: string): boolean;

  /**
   * Check if a key exists in storage
   * @param key - Storage key
   */
  has(key: string): boolean;

  /**
   * List all keys, optionally filtered by prefix
   * @param prefix - Optional key prefix to filter by
   */
  keys(prefix?: string): string[];

  /**
   * Clear all data from storage
   */
  clear(): void;
}

// ==================== EVENT BUS CLIENT ====================

/**
 * Unsubscribe function returned when subscribing to events
 */
export type Unsubscribe = () => void;

/**
 * Event handler function signature
 */
export type EventHandler = (event: EnspiraEvent) => Promise<void> | void;

/**
 * Client interface for extensions to interact with the event bus
 */
export interface EventBusClient {
  /**
   * Subscribe to events of a specific type
   * @param eventType - Event type to subscribe to, or '*' for all events
   * @param handler - Handler function to call when event is received
   * @returns Unsubscribe function
   */
  subscribe(eventType: EnspiraEventType | '*', handler: EventHandler): Unsubscribe;

  /**
   * Publish a custom extension event
   * @param type - Event type (must start with 'extension:')
   * @param data - Event data payload
   */
  emit(type: `extension:${string}`, data: Record<string, unknown>): Promise<void>;
}

// ==================== EXTENSION CONTEXT ====================

/**
 * Read-only configuration interface for extensions
 */
export interface ReadonlyConfig {
  /**
   * Get a configuration value by path
   * @param path - Dot-notation path to config value
   * @returns The config value or undefined
   */
  get<T = unknown>(path: string): T | undefined;

  /**
   * Check if a configuration path exists
   * @param path - Dot-notation path to check
   */
  has(path: string): boolean;
}

/**
 * Context provided to extensions during lifecycle
 */
export interface ExtensionContext {
  /** Logger instance scoped to this extension */
  logger: Logger;
  /** Read-only access to Enspira configuration */
  config: ReadonlyConfig;
  /** Event bus client for subscribing and emitting events */
  eventBus: EventBusClient;
  /** Isolated key-value storage for this extension */
  storage: ExtensionStorage;
  /** Extension's own manifest */
  manifest: ExtensionManifest;
  /** Path to extension's installation directory */
  extensionPath: string;
}

// ==================== EXTENSION INTERFACE ====================

/**
 * Main extension interface that extension developers implement
 */
export interface Extension {
  /** Extension manifest (loaded from manifest.json) */
  manifest: ExtensionManifest;

  // ========== Lifecycle Hooks ==========

  /**
   * Called when the extension is loaded
   * Initialize resources, subscribe to events, etc.
   * @param context - Extension context with logger, config, storage, etc.
   */
  onLoad?(context: ExtensionContext): Promise<void>;

  /**
   * Called when the extension is unloaded
   * Clean up resources, unsubscribe from events, etc.
   */
  onUnload?(): Promise<void>;

  /**
   * Called when the extension is enabled (after being disabled)
   */
  onEnable?(): Promise<void>;

  /**
   * Called when the extension is disabled (but still loaded)
   */
  onDisable?(): Promise<void>;

  // ========== Event Handlers ==========

  /**
   * Called for each event the extension is subscribed to
   * @param event - The event to process
   */
  onEvent?(event: EnspiraEvent): Promise<void>;

  // ========== Middleware (requires 'events:modify' permission) ==========

  /**
   * Called before an event is processed by the core
   * Can modify the event or return null to cancel it
   * @param event - The event before processing
   * @returns Modified event, or null to cancel
   */
  beforeEvent?(event: EnspiraEvent): Promise<EnspiraEvent | null>;

  /**
   * Called after a response is generated but before it's sent
   * Can modify the response
   * @param event - The original event
   * @param response - The generated response
   * @returns Modified response
   */
  afterResponse?(event: EnspiraEvent, response: EnspiraResponse): Promise<EnspiraResponse>;
}

// ==================== LOADED EXTENSION ====================

/**
 * Extension state in the registry
 */
export type ExtensionState = 'loading' | 'loaded' | 'enabled' | 'disabled' | 'error' | 'unloaded';

/**
 * A loaded extension with runtime state
 */
export interface LoadedExtension {
  /** The extension instance */
  extension: Extension;
  /** Current state */
  state: ExtensionState;
  /** Extension context (set after onLoad) */
  context?: ExtensionContext;
  /** Path to extension directory */
  path: string;
  /** Worker thread ID (if isolated) */
  workerId?: number;
  /** Error message if state is 'error' */
  error?: string;
  /** When the extension was loaded */
  loadedAt: Date;
  /** When the extension was last enabled */
  enabledAt?: Date;
}

// ==================== EVENT BUS INTERNALS ====================

/**
 * Middleware handler that can intercept and modify events
 */
export type MiddlewareHandler = (
  event: EnspiraEvent,
  next: (event: EnspiraEvent | null) => Promise<void>
) => Promise<void>;

/**
 * Response middleware handler
 */
export type ResponseMiddlewareHandler = (
  event: EnspiraEvent,
  response: EnspiraResponse,
  next: (response: EnspiraResponse) => Promise<EnspiraResponse>
) => Promise<EnspiraResponse>;

/**
 * Event bus subscription entry
 */
export interface EventSubscription {
  /** Extension ID that created this subscription */
  extensionId: string;
  /** Event type subscribed to */
  eventType: EnspiraEventType | '*';
  /** Handler function */
  handler: EventHandler;
  /** When subscription was created */
  createdAt: Date;
}

/**
 * Event bus statistics
 */
export interface EventBusStats {
  /** Total events published */
  eventsPublished: number;
  /** Events published by type */
  eventsByType: Record<string, number>;
  /** Total active subscriptions */
  activeSubscriptions: number;
  /** Subscriptions by extension */
  subscriptionsByExtension: Record<string, number>;
  /** Average event processing time in ms */
  avgProcessingTime: number;
}

// ==================== EXTENSION REGISTRY ====================

/**
 * Options for loading an extension
 */
export interface ExtensionLoadOptions {
  /** Auto-enable after loading */
  autoEnable?: boolean;
  /** Skip version compatibility check */
  skipVersionCheck?: boolean;
  /** Custom configuration overrides */
  config?: Record<string, unknown>;
}

/**
 * Result of loading an extension
 */
export interface ExtensionLoadResult {
  success: boolean;
  extensionId?: string;
  error?: string;
}

/**
 * Extension registry statistics
 */
export interface ExtensionRegistryStats {
  /** Total extensions loaded */
  total: number;
  /** Extensions by state */
  byState: Record<ExtensionState, number>;
  /** Total event subscriptions across all extensions */
  totalSubscriptions: number;
}

// ==================== WORKER THREAD MESSAGES ====================

/**
 * Message types for worker thread communication
 */
export type WorkerMessageType =
  | 'init'
  | 'event'
  | 'enable'
  | 'disable'
  | 'unload'
  | 'storage:get'
  | 'storage:set'
  | 'storage:delete'
  | 'emit'
  | 'log'
  | 'error'
  | 'ready'
  | 'response';

/**
 * Message sent to/from worker threads
 */
export interface WorkerMessage {
  type: WorkerMessageType;
  id?: string;
  payload?: unknown;
  error?: string;
}

/**
 * Initialization message for worker thread
 */
export interface WorkerInitMessage extends WorkerMessage {
  type: 'init';
  payload: {
    extensionPath: string;
    manifest: ExtensionManifest;
    config: Record<string, unknown>;
  };
}

/**
 * Event message for worker thread
 */
export interface WorkerEventMessage extends WorkerMessage {
  type: 'event';
  payload: EnspiraEvent;
}

// ==================== CONFIGURATION ====================

/**
 * Extension system configuration in config.json
 */
export interface ExtensionsConfig {
  /** Whether extensions are enabled */
  enabled: boolean;
  /** Directory containing installed extensions */
  directory: string;
  /** Auto-load extensions on startup */
  autoload: boolean;
  /** Run extensions in isolated worker threads */
  sandbox: boolean;
  /** Permission configuration */
  permissions: {
    /** Default permissions granted to all extensions */
    default: ExtensionPermission[];
    /** Permissions that require explicit user approval */
    requireApproval: ExtensionPermission[];
  };
}

// ==================== SDK HELPERS ====================

/**
 * Configuration for defineExtension helper
 */
export interface DefineExtensionConfig {
  /** Extension manifest */
  manifest: ExtensionManifest;
  /** Lifecycle: called when extension loads */
  onLoad?: (context: ExtensionContext) => Promise<void>;
  /** Lifecycle: called when extension unloads */
  onUnload?: () => Promise<void>;
  /** Lifecycle: called when extension is enabled */
  onEnable?: () => Promise<void>;
  /** Lifecycle: called when extension is disabled */
  onDisable?: () => Promise<void>;
  /** Event handler */
  onEvent?: (event: EnspiraEvent) => Promise<void>;
  /** Middleware: called before event processing */
  beforeEvent?: (event: EnspiraEvent) => Promise<EnspiraEvent | null>;
  /** Middleware: called after response generation */
  afterResponse?: (event: EnspiraEvent, response: EnspiraResponse) => Promise<EnspiraResponse>;
}
