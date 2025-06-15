import { logger } from '../create-global-logger.js';

/**
 * Creates a configurable in-memory cache
 * @param {object} options - Cache configuration
 * @returns {object} - Cache controller
 */
export function createCache(options = {}) {
  const {
    maxSize = 500,
    defaultTtl = 60000, // 1 minute
    name = 'cache',
    logHits = false
  } = options;
  
  const cache = new Map();
  let hitCount = 0;
  let missCount = 0;
  
  /**
   * Checks if key exists and isn't expired
   * @param {string} key - Cache key
   * @returns {boolean} - Whether key exists and is valid
   */
  function has(key) {
    if (!cache.has(key)) {
      return false;
    }
    
    const { expiry } = cache.get(key);
    if (Date.now() > expiry) {
      cache.delete(key);
      return false;
    }
    
    return true;
  }
  
  /**
   * Gets value from cache
   * @param {string} key - Cache key
   * @returns {any} - Cached value or null if missing/expired
   */
  function get(key) {
    if (!has(key)) {
      missCount++;
      return null;
    }
    
    hitCount++;
    if (logHits) {
      logger.log('Cache', `${name} cache hit for: ${key}`);
    }
    
    return cache.get(key).data;
  }
  
  /**
   * Stores value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to store
   * @param {number} [ttl] - Custom TTL in ms
   */
  function set(key, value, ttl = defaultTtl) {
    // Evict oldest entry if at capacity
    if (cache.size >= maxSize) {
      let oldest = null;
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
      created: Date.now()
    });
  }
  
  /**
   * Gets a value or generates it if missing
   * @param {string} key - Cache key
   * @param {function} fetchFn - Function to generate value
   * @param {object} [options] - Additional options
   * @returns {Promise<any>} - Retrieved or generated value
   */
  async function getOrSet(key, fetchFn, options = {}) {
    const { ttl = defaultTtl, forceFresh = false } = options;
    
    // Return cached value if valid and not forcing refresh
    if (!forceFresh && has(key)) {
      return get(key);
    }
    
    try {
      // Generate new value
      const freshValue = await fetchFn();
      
      // Only cache if value exists
      if (freshValue !== undefined && freshValue !== null) {
        set(key, freshValue, ttl);
      }
      
      return freshValue;
    } catch (error) {
      logger.error('Cache', `Error generating value for key '${key}': ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Deletes a key from cache
   * @param {string} key - Key to delete
   * @returns {boolean} - Whether deletion was successful
   */
  function del(key) {
    return cache.delete(key);
  }
  
  /**
   * Clears all or matching entries
   * @param {string} [pattern] - Optional pattern to match keys
   * @returns {number} - Number of entries cleared
   */
  function clear(pattern = null) {
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
   * @returns {object} - Cache statistics
   */
  function stats() {
    return {
      size: cache.size,
      maxSize,
      hits: hitCount,
      misses: missCount,
      hitRate: hitCount + missCount > 0 
        ? hitCount / (hitCount + missCount) 
        : 0
    };
  }
  
  return {
    get,
    set,
    has,
    del,
    clear,
    getOrSet,
    stats
  };
}

/**
 * Creates a disk cache with filesystem persistence
 * @param {object} options - Cache configuration
 * @returns {object} - Disk cache controller
 */
export function createDiskCache(options = {}) {
  // Implementation details would go here
  // This would use fs-extra to persist cache entries to disk
  // with similar interface to in-memory cache
}