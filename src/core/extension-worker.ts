/**
 * Extension Worker - Manages worker threads for isolated extension execution
 * Provides message passing interface between main thread and extension workers
 * @module core/extension-worker
 */

import { Worker, type MessagePort } from 'worker_threads';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  ExtensionManifest,
  EnspiraEvent,
  WorkerMessage,
  WorkerInitMessage,
  WorkerEventMessage,
} from '@/types/extension.types.js';
import { getLogger, type Logger } from './logger.js';

// Get current directory for worker script path
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==================== CONSTANTS ====================

/** Default worker initialization timeout */
const INIT_TIMEOUT_MS = 10000;

/** Default event processing timeout */
const EVENT_TIMEOUT_MS = 5000;

/** Worker script path */
const WORKER_SCRIPT = join(__dirname, 'extension-runner.js');

// ==================== EXTENSION WORKER CLASS ====================

/**
 * Wrapper for a worker thread running an extension
 */
export class ExtensionWorker {
  private logger: Logger;
  private worker: Worker | null = null;
  private extensionId: string;
  private extensionPath: string;
  private manifest: ExtensionManifest;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private isReady = false;
  private isTerminating = false;
  private eventHandlers: Map<string, (data: unknown) => void> = new Map();

  constructor(
    extensionPath: string,
    manifest: ExtensionManifest,
    config: Record<string, unknown> = {}
  ) {
    this.logger = getLogger();
    this.extensionPath = extensionPath;
    this.manifest = manifest;
    this.extensionId = manifest.id;
  }

  // ==================== LIFECYCLE ====================

  /**
   * Start the worker thread
   */
  async start(): Promise<void> {
    if (this.worker) {
      throw new Error('Worker already started');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.terminate();
        reject(new Error(`Worker initialization timeout for ${this.extensionId}`));
      }, INIT_TIMEOUT_MS);

      try {
        this.worker = new Worker(WORKER_SCRIPT, {
          workerData: {
            extensionPath: this.extensionPath,
            manifest: this.manifest,
          },
        });

        this.worker.on('message', (message: WorkerMessage) => {
          this.handleMessage(message);

          // Handle ready message
          if (message.type === 'ready') {
            clearTimeout(timeoutId);
            this.isReady = true;
            resolve();
          }
        });

        this.worker.on('error', (error) => {
          this.logger.error('ExtensionWorker', `Worker error for ${this.extensionId}: ${error}`);
          clearTimeout(timeoutId);
          this.isReady = false;
          reject(error);
        });

        this.worker.on('exit', (code) => {
          this.logger.debug('ExtensionWorker', `Worker exited for ${this.extensionId} with code ${code}`);
          this.isReady = false;
          this.worker = null;

          // Reject any pending requests
          for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('Worker exited'));
          }
          this.pendingRequests.clear();
        });
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Terminate the worker thread
   */
  async terminate(): Promise<void> {
    if (!this.worker || this.isTerminating) {
      return;
    }

    this.isTerminating = true;

    // Send unload message and wait briefly
    try {
      await this.sendRequest({ type: 'unload' }, 1000);
    } catch {
      // Ignore timeout, proceed with termination
    }

    // Terminate worker
    await this.worker.terminate();
    this.worker = null;
    this.isReady = false;
    this.isTerminating = false;
    this.pendingRequests.clear();

    this.logger.debug('ExtensionWorker', `Terminated worker for ${this.extensionId}`);
  }

  // ==================== MESSAGING ====================

  /**
   * Send an event to the worker
   */
  async sendEvent(event: EnspiraEvent): Promise<void> {
    if (!this.isReady || !this.worker) {
      throw new Error(`Worker not ready for ${this.extensionId}`);
    }

    const message: WorkerEventMessage = {
      type: 'event',
      payload: event,
    };

    // Fire and forget for events (no response expected)
    this.worker.postMessage(message);
  }

  /**
   * Send a request and wait for response
   */
  async sendRequest(
    message: Omit<WorkerMessage, 'id'>,
    timeout: number = EVENT_TIMEOUT_MS
  ): Promise<unknown> {
    if (!this.worker) {
      throw new Error(`Worker not started for ${this.extensionId}`);
    }

    const id = randomUUID();
    const fullMessage: WorkerMessage = { ...message, id };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${this.extensionId}`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          reject(error);
        },
      });

      this.worker!.postMessage(fullMessage);
    });
  }

  /**
   * Handle incoming message from worker
   */
  private handleMessage(message: WorkerMessage): void {
    // Handle response to pending request
    if (message.id && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id)!;

      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.payload);
      }
      return;
    }

    // Handle log messages
    if (message.type === 'log') {
      const { level, category, text } = message.payload as { level: string; category: string; text: string };
      switch (level) {
        case 'debug':
          this.logger.debug(category, text);
          break;
        case 'info':
          this.logger.info(category, text);
          break;
        case 'warn':
          this.logger.warn(category, text);
          break;
        case 'error':
          this.logger.error(category, text);
          break;
        default:
          this.logger.log(category, text);
      }
      return;
    }

    // Handle error messages
    if (message.type === 'error') {
      this.logger.error('ExtensionWorker', `Extension ${this.extensionId} error: ${message.error}`);
      return;
    }

    // Handle custom event handlers
    const handler = this.eventHandlers.get(message.type);
    if (handler) {
      handler(message.payload);
    }
  }

  /**
   * Register a handler for a specific message type
   */
  on(type: string, handler: (data: unknown) => void): void {
    this.eventHandlers.set(type, handler);
  }

  /**
   * Remove a handler for a specific message type
   */
  off(type: string): void {
    this.eventHandlers.delete(type);
  }

  // ==================== CONTROL ====================

  /**
   * Enable the extension
   */
  async enable(): Promise<void> {
    await this.sendRequest({ type: 'enable' });
  }

  /**
   * Disable the extension
   */
  async disable(): Promise<void> {
    await this.sendRequest({ type: 'disable' });
  }

  // ==================== STORAGE ====================

  /**
   * Get a value from extension storage
   */
  async storageGet<T>(key: string): Promise<T | undefined> {
    const result = await this.sendRequest({
      type: 'storage:get',
      payload: { key },
    });
    return result as T | undefined;
  }

  /**
   * Set a value in extension storage
   */
  async storageSet<T>(key: string, value: T): Promise<void> {
    await this.sendRequest({
      type: 'storage:set',
      payload: { key, value },
    });
  }

  /**
   * Delete a value from extension storage
   */
  async storageDelete(key: string): Promise<boolean> {
    const result = await this.sendRequest({
      type: 'storage:delete',
      payload: { key },
    });
    return result as boolean;
  }

  // ==================== GETTERS ====================

  /**
   * Check if worker is ready
   */
  get ready(): boolean {
    return this.isReady;
  }

  /**
   * Get extension ID
   */
  get id(): string {
    return this.extensionId;
  }

  /**
   * Get worker thread ID
   */
  get threadId(): number | undefined {
    return this.worker?.threadId;
  }
}

// ==================== TYPES ====================

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

// ==================== WORKER POOL ====================

/**
 * Pool for managing multiple extension workers
 */
export class ExtensionWorkerPool {
  private logger: Logger;
  private workers: Map<string, ExtensionWorker> = new Map();

  constructor() {
    this.logger = getLogger();
  }

  /**
   * Create and start a worker for an extension
   */
  async create(
    extensionPath: string,
    manifest: ExtensionManifest,
    config?: Record<string, unknown>
  ): Promise<ExtensionWorker> {
    const extensionId = manifest.id;

    if (this.workers.has(extensionId)) {
      throw new Error(`Worker already exists for ${extensionId}`);
    }

    const worker = new ExtensionWorker(extensionPath, manifest, config);
    await worker.start();

    this.workers.set(extensionId, worker);
    this.logger.info('ExtensionWorkerPool', `Created worker for ${extensionId}`);

    return worker;
  }

  /**
   * Get a worker by extension ID
   */
  get(extensionId: string): ExtensionWorker | undefined {
    return this.workers.get(extensionId);
  }

  /**
   * Terminate a worker
   */
  async terminate(extensionId: string): Promise<void> {
    const worker = this.workers.get(extensionId);
    if (!worker) return;

    await worker.terminate();
    this.workers.delete(extensionId);
    this.logger.info('ExtensionWorkerPool', `Terminated worker for ${extensionId}`);
  }

  /**
   * Terminate all workers
   */
  async terminateAll(): Promise<void> {
    const promises = Array.from(this.workers.keys()).map((id) => this.terminate(id));
    await Promise.allSettled(promises);
  }

  /**
   * Broadcast an event to all workers
   */
  async broadcast(event: EnspiraEvent): Promise<void> {
    const promises = Array.from(this.workers.values()).map((worker) =>
      worker.sendEvent(event).catch((error) => {
        this.logger.error('ExtensionWorkerPool', `Broadcast error to ${worker.id}: ${error}`);
      })
    );
    await Promise.allSettled(promises);
  }

  /**
   * Get all worker IDs
   */
  getIds(): string[] {
    return Array.from(this.workers.keys());
  }

  /**
   * Get worker count
   */
  get size(): number {
    return this.workers.size;
  }
}

// ==================== SINGLETON INSTANCE ====================

let workerPoolInstance: ExtensionWorkerPool | null = null;

/**
 * Get or create the global worker pool instance
 */
export function getWorkerPool(): ExtensionWorkerPool {
  if (!workerPoolInstance) {
    workerPoolInstance = new ExtensionWorkerPool();
  }
  return workerPoolInstance;
}

/**
 * Reset the global worker pool instance (for testing)
 */
export async function resetWorkerPool(): Promise<void> {
  if (workerPoolInstance) {
    await workerPoolInstance.terminateAll();
  }
  workerPoolInstance = null;
}
