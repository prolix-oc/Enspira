/**
 * Extension Runner - Runs inside worker thread to execute extension code
 * This file is loaded by worker threads and handles extension lifecycle
 * @module core/extension-runner
 */

import { parentPort, workerData } from 'worker_threads';
import { pathToFileURL } from 'url';
import { join } from 'path';
import type {
  Extension,
  ExtensionManifest,
  ExtensionContext,
  EnspiraEvent,
  ExtensionStorage,
  EventBusClient,
  ReadonlyConfig,
  WorkerMessage,
} from '@/types/extension.types.js';

// ==================== RUNNER STATE ====================

interface RunnerState {
  extension: Extension | null;
  manifest: ExtensionManifest;
  extensionPath: string;
  isEnabled: boolean;
  storage: Map<string, unknown>;
}

const state: RunnerState = {
  extension: null,
  manifest: workerData.manifest,
  extensionPath: workerData.extensionPath,
  isEnabled: false,
  storage: new Map(),
};

// ==================== LOGGING ====================

/**
 * Send log message to parent
 */
function log(level: string, category: string, text: string): void {
  sendMessage({
    type: 'log',
    payload: { level, category, text },
  });
}

// ==================== MESSAGING ====================

/**
 * Send message to parent thread
 */
function sendMessage(message: WorkerMessage): void {
  parentPort?.postMessage(message);
}

/**
 * Send response to a request
 */
function sendResponse(id: string, payload?: unknown, error?: string): void {
  sendMessage({
    type: 'response',
    id,
    payload,
    error,
  });
}

// ==================== CONTEXT CREATION ====================

/**
 * Create extension context for the worker
 */
function createContext(): ExtensionContext {
  const logger = {
    log: (category: string, text: string) => log('log', category, text),
    info: (category: string, text: string) => log('info', category, text),
    warn: (category: string, text: string) => log('warn', category, text),
    error: (category: string, text: string) => log('error', category, text),
    debug: (category: string, text: string) => log('debug', category, text),
  } as any; // Simplified logger for worker

  const config: ReadonlyConfig = {
    get: <T>(path: string): T | undefined => {
      // Config access would need to be proxied through parent
      // For now, return undefined (config access is limited in workers)
      return undefined;
    },
    has: (path: string): boolean => false,
  };

  const eventBus: EventBusClient = {
    subscribe: (eventType, handler) => {
      // Subscriptions are managed by parent thread
      // Events are forwarded to onEvent handler
      return () => {};
    },
    emit: async (type, data) => {
      sendMessage({
        type: 'emit',
        payload: { type, data },
      });
    },
  };

  const storage: ExtensionStorage = {
    get: <T>(key: string): T | undefined => state.storage.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => { state.storage.set(key, value); },
    delete: (key: string): boolean => state.storage.delete(key),
    has: (key: string): boolean => state.storage.has(key),
    keys: (prefix?: string): string[] => {
      const allKeys = Array.from(state.storage.keys());
      if (!prefix) return allKeys;
      return allKeys.filter((k) => k.startsWith(prefix));
    },
    clear: (): void => { state.storage.clear(); },
  };

  return {
    logger,
    config,
    eventBus,
    storage,
    manifest: state.manifest,
    extensionPath: state.extensionPath,
  };
}

// ==================== EXTENSION LOADING ====================

/**
 * Load the extension module
 */
async function loadExtension(): Promise<void> {
  try {
    const mainPath = join(state.extensionPath, state.manifest.main);
    const moduleUrl = pathToFileURL(mainPath).href;

    log('debug', 'ExtensionRunner', `Loading extension from ${mainPath}`);

    const module = await import(moduleUrl);
    state.extension = module.default || module;

    if (!state.extension) {
      throw new Error('Extension module did not export an extension');
    }

    // Ensure manifest is attached
    if (!state.extension.manifest) {
      state.extension.manifest = state.manifest;
    }

    // Create context and call onLoad
    const context = createContext();
    if (state.extension.onLoad) {
      await state.extension.onLoad(context);
    }

    log('info', 'ExtensionRunner', `Extension ${state.manifest.id} loaded successfully`);
  } catch (error) {
    log('error', 'ExtensionRunner', `Failed to load extension: ${error}`);
    sendMessage({
      type: 'error',
      error: String(error),
    });
    throw error;
  }
}

// ==================== MESSAGE HANDLING ====================

/**
 * Handle incoming messages from parent
 */
async function handleMessage(message: WorkerMessage): Promise<void> {
  try {
    switch (message.type) {
      case 'event':
        await handleEvent(message.payload as EnspiraEvent);
        break;

      case 'enable':
        await handleEnable();
        if (message.id) sendResponse(message.id);
        break;

      case 'disable':
        await handleDisable();
        if (message.id) sendResponse(message.id);
        break;

      case 'unload':
        await handleUnload();
        if (message.id) sendResponse(message.id);
        break;

      case 'storage:get':
        const getKey = (message.payload as { key: string }).key;
        const getValue = state.storage.get(getKey);
        if (message.id) sendResponse(message.id, getValue);
        break;

      case 'storage:set':
        const { key: setKey, value } = message.payload as { key: string; value: unknown };
        state.storage.set(setKey, value);
        if (message.id) sendResponse(message.id);
        break;

      case 'storage:delete':
        const delKey = (message.payload as { key: string }).key;
        const deleted = state.storage.delete(delKey);
        if (message.id) sendResponse(message.id, deleted);
        break;

      default:
        log('warn', 'ExtensionRunner', `Unknown message type: ${message.type}`);
    }
  } catch (error) {
    log('error', 'ExtensionRunner', `Error handling message ${message.type}: ${error}`);
    if (message.id) {
      sendResponse(message.id, undefined, String(error));
    }
  }
}

/**
 * Handle incoming event
 */
async function handleEvent(event: EnspiraEvent): Promise<void> {
  if (!state.extension || !state.isEnabled) return;

  // Check if extension subscribed to this event type
  const manifest = state.extension.manifest;
  if (manifest.events && manifest.events.length > 0) {
    if (!manifest.events.includes(event.type)) {
      return;
    }
  }

  try {
    if (state.extension.onEvent) {
      await state.extension.onEvent(event);
    }
  } catch (error) {
    log('error', 'ExtensionRunner', `Error handling event ${event.type}: ${error}`);
  }
}

/**
 * Handle enable request
 */
async function handleEnable(): Promise<void> {
  if (!state.extension) {
    throw new Error('Extension not loaded');
  }

  if (state.isEnabled) {
    return;
  }

  if (state.extension.onEnable) {
    await state.extension.onEnable();
  }

  state.isEnabled = true;
  log('info', 'ExtensionRunner', `Extension ${state.manifest.id} enabled`);
}

/**
 * Handle disable request
 */
async function handleDisable(): Promise<void> {
  if (!state.extension) {
    throw new Error('Extension not loaded');
  }

  if (!state.isEnabled) {
    return;
  }

  if (state.extension.onDisable) {
    await state.extension.onDisable();
  }

  state.isEnabled = false;
  log('info', 'ExtensionRunner', `Extension ${state.manifest.id} disabled`);
}

/**
 * Handle unload request
 */
async function handleUnload(): Promise<void> {
  if (!state.extension) {
    return;
  }

  // Disable first if enabled
  if (state.isEnabled) {
    await handleDisable();
  }

  // Call onUnload
  if (state.extension.onUnload) {
    await state.extension.onUnload();
  }

  state.extension = null;
  log('info', 'ExtensionRunner', `Extension ${state.manifest.id} unloaded`);
}

// ==================== INITIALIZATION ====================

/**
 * Initialize the extension runner
 */
async function init(): Promise<void> {
  if (!parentPort) {
    console.error('ExtensionRunner must be run as a worker thread');
    process.exit(1);
  }

  // Set up message handler
  parentPort.on('message', handleMessage);

  try {
    // Load the extension
    await loadExtension();

    // Enable by default
    await handleEnable();

    // Signal ready
    sendMessage({ type: 'ready' });
  } catch (error) {
    log('error', 'ExtensionRunner', `Initialization failed: ${error}`);
    sendMessage({
      type: 'error',
      error: String(error),
    });
    process.exit(1);
  }
}

// ==================== ERROR HANDLING ====================

process.on('uncaughtException', (error) => {
  log('error', 'ExtensionRunner', `Uncaught exception: ${error}`);
  sendMessage({
    type: 'error',
    error: String(error),
  });
});

process.on('unhandledRejection', (reason) => {
  log('error', 'ExtensionRunner', `Unhandled rejection: ${reason}`);
  sendMessage({
    type: 'error',
    error: String(reason),
  });
});

// ==================== START ====================

init().catch((error) => {
  console.error('ExtensionRunner init failed:', error);
  process.exit(1);
});
