/**
 * Enspira Extension SDK - SQLite Storage Implementation
 * Provides persistent key-value storage for extensions using SQLite
 * @module extensions/sdk/storage
 *
 * Note: Requires 'better-sqlite3' to be installed for SQLite storage.
 * Falls back to in-memory storage if not available.
 */

import { mkdir } from 'fs/promises';
import { join } from 'path';
import type { ExtensionStorage } from './types.js';

// ==================== CONSTANTS ====================

/** Default data directory */
const DEFAULT_DATA_DIR = './extensions/data';

// ==================== TYPES ====================

export interface StorageKeyMeta {
  createdAt: Date;
  updatedAt: Date;
}

// ==================== IN-MEMORY STORAGE ====================

/**
 * In-memory storage implementation (fallback when SQLite not available)
 */
class InMemoryStorage implements ExtensionStorage {
  private store: Map<string, { value: unknown; created: number; updated: number }> = new Map();

  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);
    return entry?.value as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    const now = Date.now();
    const existing = this.store.get(key);
    this.store.set(key, {
      value,
      created: existing?.created ?? now,
      updated: now,
    });
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  keys(prefix?: string): string[] {
    const allKeys = Array.from(this.store.keys());
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  getMeta(key: string): StorageKeyMeta | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return {
      createdAt: new Date(entry.created),
      updatedAt: new Date(entry.updated),
    };
  }

  close(): void {
    // No-op for in-memory storage
  }
}

// ==================== SQLITE STORAGE ====================

/**
 * SQLite-based storage implementation for extensions
 * Each extension gets its own SQLite database file
 */
class SQLiteStorageImpl implements ExtensionStorage {
  private db: any; // better-sqlite3 Database instance
  private extensionId: string;
  private isClosed = false;

  constructor(db: any, extensionId: string) {
    this.db = db;
    this.extensionId = extensionId;

    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');

    // Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create index for prefix queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_kv_key ON kv(key)
    `);
  }

  get<T = unknown>(key: string): T | undefined {
    this.ensureOpen();

    const stmt = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;

    if (!row) return undefined;

    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    this.ensureOpen();

    const now = Date.now();
    const jsonValue = JSON.stringify(value);

    const stmt = this.db.prepare(`
      INSERT INTO kv (key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    stmt.run(key, jsonValue, now, now);
  }

  delete(key: string): boolean {
    this.ensureOpen();

    const stmt = this.db.prepare('DELETE FROM kv WHERE key = ?');
    const result = stmt.run(key);

    return result.changes > 0;
  }

  has(key: string): boolean {
    this.ensureOpen();

    const stmt = this.db.prepare('SELECT 1 FROM kv WHERE key = ?');
    const row = stmt.get(key);

    return row !== undefined;
  }

  keys(prefix?: string): string[] {
    this.ensureOpen();

    if (prefix) {
      const stmt = this.db.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key');
      const rows = stmt.all(`${prefix}%`) as { key: string }[];
      return rows.map((row) => row.key);
    }

    const stmt = this.db.prepare('SELECT key FROM kv ORDER BY key');
    const rows = stmt.all() as { key: string }[];
    return rows.map((row) => row.key);
  }

  clear(): void {
    this.ensureOpen();
    this.db.exec('DELETE FROM kv');
  }

  size(): number {
    this.ensureOpen();

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM kv');
    const row = stmt.get() as { count: number };

    return row.count;
  }

  getMeta(key: string): StorageKeyMeta | undefined {
    this.ensureOpen();

    const stmt = this.db.prepare(
      'SELECT created_at, updated_at FROM kv WHERE key = ?'
    );
    const row = stmt.get(key) as { created_at: number; updated_at: number } | undefined;

    if (!row) return undefined;

    return {
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  close(): void {
    if (!this.isClosed) {
      this.db.close();
      this.isClosed = true;
    }
  }

  private ensureOpen(): void {
    if (this.isClosed) {
      throw new Error('Storage has been closed');
    }
  }

  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9.-]/g, '_');
  }
}

// ==================== FACTORY ====================

/**
 * Factory for creating extension storage instances
 */
export class SQLiteStorageFactory {
  private dataDir: string;
  private stores: Map<string, ExtensionStorage & { close(): void }> = new Map();
  private DatabaseClass: any = null;
  private initialized = false;

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
  }

  /**
   * Initialize the factory (loads better-sqlite3 if available)
   */
  private async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Dynamic import with string interpolation to prevent static analysis
      const moduleName = 'better-sqlite3';
      const module = await import(/* @vite-ignore */ moduleName);
      this.DatabaseClass = module.default;
    } catch {
      // better-sqlite3 not available, will use in-memory storage
      this.DatabaseClass = null;
    }

    this.initialized = true;
  }

  /**
   * Create or get a storage instance for an extension
   */
  async create(extensionId: string): Promise<ExtensionStorage> {
    // Return existing instance if available
    if (this.stores.has(extensionId)) {
      return this.stores.get(extensionId)!;
    }

    await this.init();

    let storage: ExtensionStorage & { close(): void };

    if (this.DatabaseClass) {
      // Ensure data directory exists
      await mkdir(this.dataDir, { recursive: true });

      // Create SQLite storage
      const sanitizedId = extensionId.replace(/[^a-zA-Z0-9.-]/g, '_');
      const dbPath = join(this.dataDir, `${sanitizedId}.sqlite`);
      const db = new this.DatabaseClass(dbPath);
      storage = new SQLiteStorageImpl(db, extensionId);
    } else {
      // Fall back to in-memory storage
      storage = new InMemoryStorage();
    }

    this.stores.set(extensionId, storage);
    return storage;
  }

  /**
   * Close storage for an extension
   */
  close(extensionId: string): void {
    const storage = this.stores.get(extensionId);
    if (storage) {
      storage.close();
      this.stores.delete(extensionId);
    }
  }

  /**
   * Close all storage instances
   */
  closeAll(): void {
    for (const storage of this.stores.values()) {
      storage.close();
    }
    this.stores.clear();
  }

  /**
   * Set data directory
   */
  setDataDir(dir: string): void {
    this.dataDir = dir;
  }

  /**
   * Check if SQLite is available
   */
  async isSQLiteAvailable(): Promise<boolean> {
    await this.init();
    return this.DatabaseClass !== null;
  }
}

// ==================== SINGLETON INSTANCE ====================

let storageFactoryInstance: SQLiteStorageFactory | null = null;

/**
 * Get or create the global storage factory instance
 */
export function getStorageFactory(): SQLiteStorageFactory {
  if (!storageFactoryInstance) {
    storageFactoryInstance = new SQLiteStorageFactory();
  }
  return storageFactoryInstance;
}

/**
 * Reset the global storage factory instance (for testing)
 */
export function resetStorageFactory(): void {
  if (storageFactoryInstance) {
    storageFactoryInstance.closeAll();
  }
  storageFactoryInstance = null;
}
