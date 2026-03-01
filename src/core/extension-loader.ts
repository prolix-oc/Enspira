/**
 * Extension Loader - Loads extensions from disk and creates contexts
 * Handles manifest validation, dependency resolution, and storage initialization
 * @module core/extension-loader
 */

import { readdir, readFile, stat, access } from 'fs/promises';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type {
  Extension,
  ExtensionManifest,
  ExtensionContext,
  ExtensionLoadOptions,
  ExtensionLoadResult,
  ExtensionStorage,
  ReadonlyConfig,
} from '@/types/extension.types.js';
import { getLogger, type Logger } from './logger.js';
import { retrieveConfigValue } from './config.js';
import { getEventBus, type EventBus } from './event-bus.js';
import { getExtensionRegistry, type ExtensionRegistry } from './extension-registry.js';

// ==================== CONSTANTS ====================

/** Default extensions directory */
const DEFAULT_EXTENSIONS_DIR = './extensions/installed';

/** Required manifest fields */
const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'version', 'author', 'description', 'main'];

/** Manifest file name */
const MANIFEST_FILE = 'manifest.json';

// ==================== EXTENSION LOADER CLASS ====================

/**
 * Loader for extensions from disk
 */
export class ExtensionLoader {
  private logger: Logger;
  private eventBus: EventBus;
  private registry: ExtensionRegistry;
  private extensionsDir: string;
  private storageFactory: ExtensionStorageFactory;

  constructor(options: ExtensionLoaderOptions = {}) {
    this.logger = getLogger();
    this.eventBus = options.eventBus || getEventBus();
    this.registry = options.registry || getExtensionRegistry();
    this.extensionsDir = options.extensionsDir || DEFAULT_EXTENSIONS_DIR;
    this.storageFactory = options.storageFactory || new DefaultStorageFactory();
  }

  // ==================== LOADING ====================

  /**
   * Load all extensions from the extensions directory
   */
  async loadAll(): Promise<ExtensionLoadResult[]> {
    const results: ExtensionLoadResult[] = [];

    try {
      const extensionDirs = await this.discoverExtensions();
      this.logger.info('ExtensionLoader', `Found ${extensionDirs.length} extensions to load`);

      for (const dir of extensionDirs) {
        const result = await this.load(dir);
        results.push(result);
      }
    } catch (error) {
      this.logger.error('ExtensionLoader', `Error loading extensions: ${error}`);
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;
    this.logger.info('ExtensionLoader', `Loaded ${successful} extensions, ${failed} failed`);

    return results;
  }

  /**
   * Load a single extension from a directory
   */
  async load(extensionPath: string, options: ExtensionLoadOptions = {}): Promise<ExtensionLoadResult> {
    const fullPath = resolve(extensionPath);

    try {
      // Read and validate manifest
      const manifest = await this.loadManifest(fullPath);

      // Check version compatibility
      if (!options.skipVersionCheck) {
        await this.checkVersionCompatibility(manifest);
      }

      // Load the extension module
      const extension = await this.loadExtensionModule(fullPath, manifest);

      // Create context
      const context = await this.createContext(manifest, fullPath, options.config);

      // Register with registry
      await this.registry.register(extension, fullPath, options);

      // If registration enabled it, update context
      const loaded = this.registry.get(manifest.id);
      if (loaded) {
        loaded.context = context;
      }

      this.logger.info('ExtensionLoader', `Loaded extension: ${manifest.id} v${manifest.version}`);

      return {
        success: true,
        extensionId: manifest.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('ExtensionLoader', `Failed to load extension from ${fullPath}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Reload an extension from disk
   */
  async reload(extensionId: string): Promise<ExtensionLoadResult> {
    const loaded = this.registry.get(extensionId);
    if (!loaded) {
      return {
        success: false,
        error: `Extension ${extensionId} is not loaded`,
      };
    }

    const path = loaded.path;
    const wasEnabled = loaded.state === 'enabled';

    // Unregister
    await this.registry.unregister(extensionId);

    // Clear module cache for hot reload
    this.clearModuleCache(path);

    // Reload
    const result = await this.load(path, { autoEnable: wasEnabled });

    return result;
  }

  // ==================== MANIFEST ====================

  /**
   * Load and validate manifest from extension directory
   */
  async loadManifest(extensionPath: string): Promise<ExtensionManifest> {
    const manifestPath = join(extensionPath, MANIFEST_FILE);

    try {
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      this.validateManifest(manifest);

      return manifest as ExtensionManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Manifest not found: ${manifestPath}`);
      }
      throw new Error(`Invalid manifest: ${error}`);
    }
  }

  /**
   * Validate manifest structure
   */
  validateManifest(manifest: unknown): asserts manifest is ExtensionManifest {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Manifest must be an object');
    }

    const obj = manifest as Record<string, unknown>;

    // Check required fields
    for (const field of REQUIRED_MANIFEST_FIELDS) {
      if (!obj[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Validate id format (reverse domain notation recommended)
    if (typeof obj.id !== 'string' || !/^[\w.-]+$/.test(obj.id)) {
      throw new Error(`Invalid extension ID: ${obj.id}`);
    }

    // Validate version (semver)
    if (typeof obj.version !== 'string' || !/^\d+\.\d+\.\d+/.test(obj.version)) {
      throw new Error(`Invalid version format: ${obj.version}`);
    }

    // Validate permissions if present
    if (obj.permissions) {
      if (!Array.isArray(obj.permissions)) {
        throw new Error('Permissions must be an array');
      }
      const validPermissions = ['events:read', 'events:modify', 'config:read', 'user:read', 'response:inject'];
      for (const perm of obj.permissions) {
        if (!validPermissions.includes(perm)) {
          throw new Error(`Invalid permission: ${perm}`);
        }
      }
    }
  }

  /**
   * Check version compatibility
   */
  async checkVersionCompatibility(manifest: ExtensionManifest): Promise<void> {
    // Get Enspira version from package.json or config
    const enspiraVersion = (await retrieveConfigValue<string>('version')) || '1.0.0';
    const requiredVersion = manifest.enspiraVersion;

    if (!requiredVersion) return;

    // Simple version check (could be enhanced with semver library)
    if (requiredVersion.startsWith('>=')) {
      const minVersion = requiredVersion.slice(2);
      if (!this.isVersionGte(enspiraVersion, minVersion)) {
        throw new Error(
          `Extension requires Enspira ${requiredVersion}, but current version is ${enspiraVersion}`
        );
      }
    }
  }

  // ==================== MODULE LOADING ====================

  /**
   * Load extension module from disk
   */
  private async loadExtensionModule(
    extensionPath: string,
    manifest: ExtensionManifest
  ): Promise<Extension> {
    const mainPath = join(extensionPath, manifest.main);

    try {
      // Check if main file exists
      await access(mainPath);

      // Convert to file URL for ESM import
      const moduleUrl = pathToFileURL(mainPath).href;

      // Dynamic import
      const module = await import(moduleUrl);

      // Get extension from default export or module itself
      const extension = module.default || module;

      if (!extension || typeof extension !== 'object') {
        throw new Error('Extension must export an object');
      }

      // Ensure manifest is attached
      if (!extension.manifest) {
        extension.manifest = manifest;
      }

      return extension as Extension;
    } catch (error) {
      throw new Error(`Failed to load extension module: ${error}`);
    }
  }

  /**
   * Clear module from cache for hot reload
   */
  private clearModuleCache(extensionPath: string): void {
    // For ESM modules, there's no direct cache clearing
    // The dynamic import with a different URL would reload
    // For CommonJS, we'd need to clear require.cache
    this.logger.debug('ExtensionLoader', `Module cache clear requested for ${extensionPath}`);
  }

  // ==================== CONTEXT CREATION ====================

  /**
   * Create extension context
   */
  private async createContext(
    manifest: ExtensionManifest,
    extensionPath: string,
    configOverrides?: Record<string, unknown>
  ): Promise<ExtensionContext> {
    const extensionId = manifest.id;

    // Create scoped logger
    const logger = this.logger; // Could create a scoped logger if needed

    // Create readonly config wrapper
    const config = this.createReadonlyConfig(manifest, configOverrides);

    // Create event bus client
    const eventBus = this.eventBus.createClient(extensionId);

    // Create storage
    const storage = await this.storageFactory.create(extensionId);

    return {
      logger,
      config,
      eventBus,
      storage,
      manifest,
      extensionPath,
    };
  }

  /**
   * Create readonly config wrapper for extension
   * Note: Config access is limited to overrides in worker context
   * since retrieveConfigValue is async
   */
  private createReadonlyConfig(
    manifest: ExtensionManifest,
    overrides?: Record<string, unknown>
  ): ReadonlyConfig {
    // Cache for config values loaded at extension init time
    const configCache = new Map<string, unknown>();

    return {
      get: <T>(path: string): T | undefined => {
        // Check overrides first
        if (overrides && path in overrides) {
          return overrides[path] as T;
        }

        // Check cache
        if (configCache.has(path)) {
          return configCache.get(path) as T;
        }

        // Config access is async - return undefined for sync access
        // Extensions should use overrides for config they need
        return undefined;
      },
      has: (path: string): boolean => {
        if (overrides && path in overrides) {
          return true;
        }
        return configCache.has(path);
      },
    };
  }

  // ==================== DISCOVERY ====================

  /**
   * Discover extension directories
   */
  private async discoverExtensions(): Promise<string[]> {
    const extensionDirs: string[] = [];

    try {
      const entries = await readdir(this.extensionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const extensionPath = join(this.extensionsDir, entry.name);
        const manifestPath = join(extensionPath, MANIFEST_FILE);

        // Check if manifest exists
        try {
          await access(manifestPath);
          extensionDirs.push(extensionPath);
        } catch {
          // No manifest, skip
          this.logger.debug('ExtensionLoader', `Skipping ${entry.name}: no manifest`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug('ExtensionLoader', `Extensions directory not found: ${this.extensionsDir}`);
        return [];
      }
      throw error;
    }

    return extensionDirs;
  }

  // ==================== UTILITIES ====================

  /**
   * Check if version A >= version B
   */
  private isVersionGte(a: string, b: string): boolean {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const va = partsA[i] || 0;
      const vb = partsB[i] || 0;
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return true;
  }

  /**
   * Set extensions directory
   */
  setExtensionsDir(dir: string): void {
    this.extensionsDir = resolve(dir);
  }

  /**
   * Get extensions directory
   */
  getExtensionsDir(): string {
    return this.extensionsDir;
  }
}

// ==================== STORAGE FACTORY ====================

/**
 * Factory interface for creating extension storage
 */
export interface ExtensionStorageFactory {
  create(extensionId: string): Promise<ExtensionStorage>;
}

/**
 * Default in-memory storage factory (for development/testing)
 * In production, this should be replaced with SQLite storage
 */
class DefaultStorageFactory implements ExtensionStorageFactory {
  private stores: Map<string, Map<string, unknown>> = new Map();

  async create(extensionId: string): Promise<ExtensionStorage> {
    if (!this.stores.has(extensionId)) {
      this.stores.set(extensionId, new Map());
    }
    const store = this.stores.get(extensionId)!;

    return {
      get: <T>(key: string) => store.get(key) as T | undefined,
      set: <T>(key: string, value: T) => { store.set(key, value); },
      delete: (key: string) => store.delete(key),
      has: (key: string) => store.has(key),
      keys: (prefix?: string) => {
        const allKeys = Array.from(store.keys());
        if (!prefix) return allKeys;
        return allKeys.filter((k) => k.startsWith(prefix));
      },
      clear: () => { store.clear(); },
    };
  }
}

// ==================== TYPES ====================

export interface ExtensionLoaderOptions {
  extensionsDir?: string;
  eventBus?: EventBus;
  registry?: ExtensionRegistry;
  storageFactory?: ExtensionStorageFactory;
}

// ==================== SINGLETON INSTANCE ====================

let loaderInstance: ExtensionLoader | null = null;

/**
 * Get or create the global extension loader instance
 */
export function getExtensionLoader(): ExtensionLoader {
  if (!loaderInstance) {
    loaderInstance = new ExtensionLoader();
  }
  return loaderInstance;
}

/**
 * Create a new extension loader instance
 */
export function createExtensionLoader(options?: ExtensionLoaderOptions): ExtensionLoader {
  return new ExtensionLoader(options);
}

/**
 * Reset the global extension loader instance (for testing)
 */
export function resetExtensionLoader(): void {
  loaderInstance = null;
}
