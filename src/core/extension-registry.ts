/**
 * Extension Registry - Manages loaded extensions and their lifecycle
 * Provides registration, enabling/disabling, and state management
 * @module core/extension-registry
 */

import type {
  Extension,
  ExtensionState,
  LoadedExtension,
  ExtensionContext,
  ExtensionRegistryStats,
  ExtensionLoadOptions,
  EnspiraEvent,
  EnspiraResponse,
} from '@/types/extension.types.js';
import { getLogger, type Logger } from './logger.js';
import { getEventBus, type EventBus } from './event-bus.js';

// ==================== CONSTANTS ====================

/** Maximum number of extensions that can be loaded */
const MAX_EXTENSIONS = 50;

// ==================== EXTENSION REGISTRY CLASS ====================

/**
 * Registry for managing extension lifecycle
 */
export class ExtensionRegistry {
  private logger: Logger;
  private eventBus: EventBus;
  private extensions: Map<string, LoadedExtension> = new Map();
  private isShuttingDown = false;

  constructor(eventBus?: EventBus) {
    this.logger = getLogger();
    this.eventBus = eventBus || getEventBus();
  }

  // ==================== REGISTRATION ====================

  /**
   * Register an extension with the registry
   * @param extension - Extension instance to register
   * @param path - Path to extension directory
   * @param options - Load options
   * @returns Extension ID
   */
  async register(
    extension: Extension,
    path: string,
    options: ExtensionLoadOptions = {}
  ): Promise<string> {
    const extensionId = extension.manifest.id;

    // Check limits
    if (this.extensions.size >= MAX_EXTENSIONS) {
      throw new Error(`Maximum extensions reached (${MAX_EXTENSIONS})`);
    }

    // Check for duplicate
    if (this.extensions.has(extensionId)) {
      throw new Error(`Extension ${extensionId} is already registered`);
    }

    const loadedExtension: LoadedExtension = {
      extension,
      state: 'loading',
      path,
      loadedAt: new Date(),
    };

    this.extensions.set(extensionId, loadedExtension);
    this.logger.info('ExtensionRegistry', `Registered extension: ${extensionId}`);

    // Mark as loaded
    loadedExtension.state = 'loaded';

    // Auto-enable if requested
    if (options.autoEnable !== false) {
      try {
        await this.enable(extensionId);
      } catch (error) {
        loadedExtension.state = 'error';
        loadedExtension.error = String(error);
        this.logger.error('ExtensionRegistry', `Failed to auto-enable ${extensionId}: ${error}`);
      }
    }

    // Publish system event
    const event = this.eventBus.createEvent('system:extension.loaded', 'internal', {
      extensionId,
      name: extension.manifest.name,
      version: extension.manifest.version,
    });
    await this.eventBus.publish(event);

    return extensionId;
  }

  /**
   * Unregister an extension from the registry
   * @param extensionId - Extension ID to unregister
   */
  async unregister(extensionId: string): Promise<void> {
    const loaded = this.extensions.get(extensionId);
    if (!loaded) {
      throw new Error(`Extension ${extensionId} is not registered`);
    }

    // Disable first if enabled
    if (loaded.state === 'enabled') {
      await this.disable(extensionId);
    }

    // Call onUnload if defined
    if (loaded.extension.onUnload) {
      try {
        await loaded.extension.onUnload();
      } catch (error) {
        this.logger.error('ExtensionRegistry', `Error in onUnload for ${extensionId}: ${error}`);
      }
    }

    // Clean up event bus subscriptions
    this.eventBus.unsubscribeAll(extensionId);

    // Remove from registry
    loaded.state = 'unloaded';
    this.extensions.delete(extensionId);
    this.logger.info('ExtensionRegistry', `Unregistered extension: ${extensionId}`);

    // Publish system event
    const event = this.eventBus.createEvent('system:extension.unloaded', 'internal', {
      extensionId,
    });
    await this.eventBus.publish(event);
  }

  // ==================== ENABLE/DISABLE ====================

  /**
   * Enable an extension
   * @param extensionId - Extension ID to enable
   * @param context - Extension context to provide
   */
  async enable(extensionId: string, context?: ExtensionContext): Promise<void> {
    const loaded = this.extensions.get(extensionId);
    if (!loaded) {
      throw new Error(`Extension ${extensionId} is not registered`);
    }

    if (loaded.state === 'enabled') {
      this.logger.debug('ExtensionRegistry', `Extension ${extensionId} is already enabled`);
      return;
    }

    if (loaded.state !== 'loaded' && loaded.state !== 'disabled') {
      throw new Error(`Extension ${extensionId} is in state ${loaded.state}, cannot enable`);
    }

    try {
      // Create context if not provided
      const extensionContext = context || this.createDefaultContext(loaded);

      // Call onLoad if first time enabling
      if (!loaded.context && loaded.extension.onLoad) {
        await loaded.extension.onLoad(extensionContext);
      }

      // Call onEnable
      if (loaded.extension.onEnable) {
        await loaded.extension.onEnable();
      }

      // Subscribe to events based on manifest
      this.setupEventSubscriptions(loaded, extensionContext);

      loaded.context = extensionContext;
      loaded.state = 'enabled';
      loaded.enabledAt = new Date();

      this.logger.info('ExtensionRegistry', `Enabled extension: ${extensionId}`);
    } catch (error) {
      loaded.state = 'error';
      loaded.error = String(error);
      this.logger.error('ExtensionRegistry', `Failed to enable ${extensionId}: ${error}`);
      throw error;
    }
  }

  /**
   * Disable an extension
   * @param extensionId - Extension ID to disable
   */
  async disable(extensionId: string): Promise<void> {
    const loaded = this.extensions.get(extensionId);
    if (!loaded) {
      throw new Error(`Extension ${extensionId} is not registered`);
    }

    if (loaded.state === 'disabled') {
      this.logger.debug('ExtensionRegistry', `Extension ${extensionId} is already disabled`);
      return;
    }

    if (loaded.state !== 'enabled') {
      throw new Error(`Extension ${extensionId} is in state ${loaded.state}, cannot disable`);
    }

    try {
      // Call onDisable
      if (loaded.extension.onDisable) {
        await loaded.extension.onDisable();
      }

      // Unsubscribe from events
      this.eventBus.unsubscribeAll(extensionId);

      loaded.state = 'disabled';
      this.logger.info('ExtensionRegistry', `Disabled extension: ${extensionId}`);
    } catch (error) {
      loaded.state = 'error';
      loaded.error = String(error);
      this.logger.error('ExtensionRegistry', `Failed to disable ${extensionId}: ${error}`);
      throw error;
    }
  }

  // ==================== GETTERS ====================

  /**
   * Get a loaded extension by ID
   */
  get(extensionId: string): LoadedExtension | undefined {
    return this.extensions.get(extensionId);
  }

  /**
   * Get all loaded extensions
   */
  getAll(): LoadedExtension[] {
    return Array.from(this.extensions.values());
  }

  /**
   * Get extensions by state
   */
  getByState(state: ExtensionState): LoadedExtension[] {
    return this.getAll().filter((ext) => ext.state === state);
  }

  /**
   * Check if an extension is registered
   */
  has(extensionId: string): boolean {
    return this.extensions.has(extensionId);
  }

  /**
   * Get extension IDs
   */
  getIds(): string[] {
    return Array.from(this.extensions.keys());
  }

  // ==================== EVENT FORWARDING ====================

  /**
   * Forward an event to all enabled extensions that have onEvent handlers
   */
  async forwardEvent(event: EnspiraEvent): Promise<void> {
    if (this.isShuttingDown) return;

    const enabledExtensions = this.getByState('enabled');

    for (const loaded of enabledExtensions) {
      if (!loaded.extension.onEvent) continue;

      // Check if extension subscribed to this event type
      const manifest = loaded.extension.manifest;
      if (manifest.events && !manifest.events.includes(event.type)) {
        continue;
      }

      try {
        await loaded.extension.onEvent(event);
      } catch (error) {
        this.logger.error(
          'ExtensionRegistry',
          `Error in onEvent for ${manifest.id}: ${error}`
        );
      }
    }
  }

  /**
   * Run beforeEvent middleware on enabled extensions
   */
  async runBeforeEvent(event: EnspiraEvent): Promise<EnspiraEvent | null> {
    let currentEvent: EnspiraEvent | null = event;

    const enabledExtensions = this.getByState('enabled');

    for (const loaded of enabledExtensions) {
      if (!loaded.extension.beforeEvent) continue;

      // Check for events:modify permission
      const permissions = loaded.extension.manifest.permissions || [];
      if (!permissions.includes('events:modify')) continue;

      try {
        currentEvent = await loaded.extension.beforeEvent(currentEvent!);
        if (!currentEvent) {
          this.logger.debug(
            'ExtensionRegistry',
            `Event cancelled by extension ${loaded.extension.manifest.id}`
          );
          return null;
        }
      } catch (error) {
        this.logger.error(
          'ExtensionRegistry',
          `Error in beforeEvent for ${loaded.extension.manifest.id}: ${error}`
        );
      }
    }

    return currentEvent;
  }

  /**
   * Run afterResponse middleware on enabled extensions
   */
  async runAfterResponse(
    event: EnspiraEvent,
    response: EnspiraResponse
  ): Promise<EnspiraResponse> {
    let currentResponse = response;

    const enabledExtensions = this.getByState('enabled');

    for (const loaded of enabledExtensions) {
      if (!loaded.extension.afterResponse) continue;

      // Check for events:modify permission
      const permissions = loaded.extension.manifest.permissions || [];
      if (!permissions.includes('events:modify')) continue;

      try {
        currentResponse = await loaded.extension.afterResponse(event, currentResponse);
      } catch (error) {
        this.logger.error(
          'ExtensionRegistry',
          `Error in afterResponse for ${loaded.extension.manifest.id}: ${error}`
        );
      }
    }

    return currentResponse;
  }

  // ==================== LIFECYCLE ====================

  /**
   * Shutdown all extensions
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.info('ExtensionRegistry', 'Shutting down all extensions');

    const extensionIds = this.getIds();
    for (const id of extensionIds) {
      try {
        await this.unregister(id);
      } catch (error) {
        this.logger.error('ExtensionRegistry', `Error unregistering ${id}: ${error}`);
      }
    }
  }

  /**
   * Reload an extension (unload and reload from disk)
   */
  async reload(extensionId: string): Promise<void> {
    const loaded = this.extensions.get(extensionId);
    if (!loaded) {
      throw new Error(`Extension ${extensionId} is not registered`);
    }

    const path = loaded.path;
    const wasEnabled = loaded.state === 'enabled';

    // Unregister
    await this.unregister(extensionId);

    // The extension loader will need to reload from disk
    // This is handled by the extension loader, not the registry
    this.logger.info('ExtensionRegistry', `Extension ${extensionId} unregistered for reload`);

    // Return info for loader to use
    return;
  }

  // ==================== STATISTICS ====================

  /**
   * Get registry statistics
   */
  getStats(): ExtensionRegistryStats {
    const byState: Record<ExtensionState, number> = {
      loading: 0,
      loaded: 0,
      enabled: 0,
      disabled: 0,
      error: 0,
      unloaded: 0,
    };

    let totalSubscriptions = 0;

    for (const loaded of this.extensions.values()) {
      byState[loaded.state]++;
    }

    const eventBusStats = this.eventBus.getStats();
    totalSubscriptions = eventBusStats.activeSubscriptions;

    return {
      total: this.extensions.size,
      byState,
      totalSubscriptions,
    };
  }

  // ==================== PRIVATE HELPERS ====================

  /**
   * Create a default context for an extension
   */
  private createDefaultContext(loaded: LoadedExtension): ExtensionContext {
    // This is a placeholder - the real context creation happens in extension-loader
    // with proper storage, config, etc.
    return {
      logger: this.logger,
      config: {
        get: () => undefined,
        has: () => false,
      },
      eventBus: this.eventBus.createClient(loaded.extension.manifest.id),
      storage: {
        get: () => undefined,
        set: () => {},
        delete: () => false,
        has: () => false,
        keys: () => [],
        clear: () => {},
      },
      manifest: loaded.extension.manifest,
      extensionPath: loaded.path,
    };
  }

  /**
   * Set up event subscriptions based on manifest
   */
  private setupEventSubscriptions(
    loaded: LoadedExtension,
    context: ExtensionContext
  ): void {
    const manifest = loaded.extension.manifest;
    const extensionId = manifest.id;

    if (!loaded.extension.onEvent) return;

    // Subscribe to specified events or all events
    if (manifest.events && manifest.events.length > 0) {
      for (const eventType of manifest.events) {
        this.eventBus.subscribe(
          extensionId,
          eventType as any, // Event types from manifest may be custom
          async (event) => {
            if (loaded.extension.onEvent) {
              await loaded.extension.onEvent(event);
            }
          }
        );
      }
    } else {
      // Subscribe to all events
      this.eventBus.subscribe(extensionId, '*', async (event) => {
        if (loaded.extension.onEvent) {
          await loaded.extension.onEvent(event);
        }
      });
    }
  }
}

// ==================== SINGLETON INSTANCE ====================

let registryInstance: ExtensionRegistry | null = null;

/**
 * Get or create the global extension registry instance
 */
export function getExtensionRegistry(): ExtensionRegistry {
  if (!registryInstance) {
    registryInstance = new ExtensionRegistry();
  }
  return registryInstance;
}

/**
 * Create a new extension registry instance (for testing)
 */
export function createExtensionRegistry(eventBus?: EventBus): ExtensionRegistry {
  return new ExtensionRegistry(eventBus);
}

/**
 * Reset the global extension registry instance (for testing)
 */
export function resetExtensionRegistry(): void {
  if (registryInstance) {
    registryInstance.shutdown().catch(() => {});
  }
  registryInstance = null;
}
