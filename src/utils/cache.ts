/**
 * Configurable in-memory cache with TTL and LRU eviction
 * @module utils/cache
 */

import { logger } from '../core/logger.js';

/** Cache entry with metadata */
interface CacheEntry<T> {
  data: T;
  expiry: number;
  created: number;
}

/** Cache configuration options */
export interface CacheOptions {
  /** Maximum number of entries (default: 500) */
  maxSize?: number;
  /** Default TTL in milliseconds (default: 60000) */
  defaultTtl?: number;
  /** Cache name for logging */
  name?: string;
  /** Log cache hits (default: false) */
  logHits?: boolean;
}

/** Options for getOrSet method */
export interface GetOrSetOptions {
  /** Custom TTL for this entry */
  ttl?: number;
  /** Force refresh even if cached value exists */
  forceFresh?: boolean;
}

/** Cache statistics */
export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
}

/** Cache controller interface */
export interface Cache<T> {
  /** Get value from cache, returns null if missing/expired */
  get(key: string): T | null;
  /** Store value in cache with optional custom TTL */
  set(key: string, value: T, ttl?: number): void;
  /** Check if key exists and isn't expired */
  has(key: string): boolean;
  /** Delete a key from cache */
  del(key: string): boolean;
  /** Clear all or matching entries, returns count cleared */
  clear(pattern?: string | null): number;
  /** Get value or generate it if missing */
  getOrSet(
    key: string,
    fetchFn: () => Promise<T>,
    options?: GetOrSetOptions
  ): Promise<T>;
  /** Get cache statistics */
  stats(): CacheStats;
}

/**
 * Creates a configurable in-memory cache with TTL and LRU eviction
 * @param options - Cache configuration
 * @returns Cache controller with typed methods
 */
export function createCache<T = unknown>(options: CacheOptions = {}): Cache<T> {
  const {
    maxSize = 500,
    defaultTtl = 60000,
    name = 'cache',
    logHits = false,
  } = options;

  const cache = new Map<string, CacheEntry<T>>();
  let hitCount = 0;
  let missCount = 0;

  /**
   * Checks if key exists and isn't expired
   */
  function has(key: string): boolean {
    if (!cache.has(key)) {
      return false;
    }

    const entry = cache.get(key)!;
    if (Date.now() > entry.expiry) {
      cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Gets value from cache
   */
  function get(key: string): T | null {
    if (!has(key)) {
      missCount++;
      return null;
    }

    hitCount++;
    if (logHits) {
      logger.log('Cache', `${name} cache hit for: ${key}`);
    }

    return cache.get(key)!.data;
  }

  /**
   * Stores value in cache with LRU eviction
   */
  function set(key: string, value: T, ttl: number = defaultTtl): void {
    // Evict oldest entry if at capacity
    if (cache.size >= maxSize) {
      let oldest: string | null = null;
      let oldestTime = Infinity;

      for (const [existingKey, entry] of cache.entries()) {
        if (entry.expiry < oldestTime) {
          oldestTime = entry.expiry;
          oldest = existingKey;
        }
      }

      if (oldest) {
        cache.delete(oldest);
      }
    }

    cache.set(key, {
      data: value,
      expiry: Date.now() + ttl,
      created: Date.now(),
    });
  }

  /**
   * Gets a value or generates it if missing
   */
  async function getOrSet(
    key: string,
    fetchFn: () => Promise<T>,
    options: GetOrSetOptions = {}
  ): Promise<T> {
    const { ttl = defaultTtl, forceFresh = false } = options;

    // Return cached value if valid and not forcing refresh
    if (!forceFresh && has(key)) {
      return get(key)!;
    }

    try {
      const freshValue = await fetchFn();

      // Only cache if value exists
      if (freshValue !== undefined && freshValue !== null) {
        set(key, freshValue, ttl);
      }

      return freshValue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Cache', `Error generating value for key '${key}': ${message}`);
      throw error;
    }
  }

  /**
   * Deletes a key from cache
   */
  function del(key: string): boolean {
    return cache.delete(key);
  }

  /**
   * Clears all or matching entries
   */
  function clear(pattern: string | null = null): number {
    if (!pattern) {
      const size = cache.size;
      cache.clear();
      return size;
    }

    let count = 0;
    for (const key of cache.keys()) {
      if (key.includes(pattern)) {
        cache.delete(key);
        count++;
      }
    }

    return count;
  }

  /**
   * Gets cache statistics
   */
  function stats(): CacheStats {
    return {
      size: cache.size,
      maxSize,
      hits: hitCount,
      misses: missCount,
      hitRate: hitCount + missCount > 0 ? hitCount / (hitCount + missCount) : 0,
    };
  }

  return {
    get,
    set,
    has,
    del,
    clear,
    getOrSet,
    stats,
  };
}

/** Disk cache options (placeholder for future implementation) */
export interface DiskCacheOptions extends CacheOptions {
  /** Directory path for cache files */
  cacheDir?: string;
}

/**
 * Creates a disk cache with filesystem persistence
 * @param options - Cache configuration
 * @returns Disk cache controller
 */
export function createDiskCache<T = unknown>(
  _options: DiskCacheOptions = {}
): Cache<T> | undefined {
  // Implementation placeholder
  // Would use Bun.file() for persistence
  return undefined;
}
