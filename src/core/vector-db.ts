/**
 * Vector Database Operations (Milvus)
 * Handles all Milvus vector database interactions including:
 * - Collection management
 * - Vector search and insertion
 * - Batch processing
 * - Health monitoring
 */

import {
  MilvusClient,
  DataType,
  MetricType,
  IndexType,
  ConsistencyLevelEnum,
  LoadState,
  type RowData,
} from '@zilliz/milvus2-sdk-node';

import { logger } from './logger.js';
import { retrieveConfigValue } from './config.js';
import { returnAPIKeys } from './api-helper.js';

import type {
  CollectionLoadStatus,
  QueryCacheEntry,
  VectorInsertData,
  MilvusSearchOptions,
  MilvusSearchResponse,
  MilvusSearchResult,
  MilvusHealthResult,
  CollectionHealthStatus,
  MilvusCollectionSchema,
  MilvusCollectionType,
} from '@/types/ai.types.js';

// ==================== CONSTANTS AND GLOBALS ====================

/** Query result cache with TTL */
const queryCache = new Map<string, QueryCacheEntry>();

/** Collection load status cache */
const collectionLoadStatus = new Map<string, CollectionLoadStatus>();

/** Pending vectors for batch insertion */
const pendingVectors = new Map<string, VectorInsertData[]>();

/** Maximum vectors per batch */
const MAX_BATCH_SIZE = 100;

/** Maximum cache entries */
const MAX_CACHE_SIZE = 150;

/** Default TTL for cache entries in ms */
const DEFAULT_TTL = 60000;

/** Maximum wait time before batch processing in ms */
const MAX_WAIT_MS = 500;

/** TTL for collection status cache (1 hour) */
const COLLECTION_STATUS_TTL = 3600000;

// Initialize Milvus client lazily
let milvusClient: MilvusClient | null = null;

/**
 * Get or create the Milvus client instance
 */
async function getClient(): Promise<MilvusClient> {
  if (!milvusClient) {
    const milvusDatabaseUrl = await retrieveConfigValue<string>('milvus.endpoint');
    if (!milvusDatabaseUrl) {
      throw new Error('Milvus endpoint not configured');
    }
    milvusClient = new MilvusClient({
      address: milvusDatabaseUrl,
    });
  }
  return milvusClient;
}

// ==================== CACHING UTILITIES ====================

/**
 * Get a cached result if available and not expired
 * @param key - Unique cache key
 * @returns The cached result or null if not found/expired
 */
export function getCachedResult<T = unknown>(key: string): T | null {
  const entry = queryCache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiry) {
    queryCache.delete(key);
    return null;
  }

  logger.log('Milvus', `Cache hit for query: ${key}`);
  return entry.result as T;
}

/**
 * Store a result in the query cache with LRU eviction
 * @param key - Unique cache key
 * @param result - Result to cache
 * @param ttl - Time to live in milliseconds
 */
export function setCachedResult<T = unknown>(
  key: string,
  result: T,
  ttl: number = DEFAULT_TTL
): void {
  // Implement LRU eviction if cache gets too large
  if (queryCache.size >= MAX_CACHE_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [cachedKey, value] of queryCache.entries()) {
      if (value.expiry < oldestTime) {
        oldestTime = value.expiry;
        oldestKey = cachedKey;
      }
    }

    if (oldestKey) {
      queryCache.delete(oldestKey);
    }
  }

  queryCache.set(key, {
    result,
    expiry: Date.now() + ttl,
  });
}

/**
 * Clear the entire query cache or entries matching a pattern
 * @param pattern - Optional pattern to match keys for selective clearing
 */
export function clearQueryCache(pattern: string | null = null): void {
  if (!pattern) {
    queryCache.clear();
    logger.log('Milvus', 'Query cache cleared');
    return;
  }

  for (const key of queryCache.keys()) {
    if (key.includes(pattern)) {
      queryCache.delete(key);
    }
  }

  logger.log('Milvus', `Query cache entries matching '${pattern}' cleared`);
}

// ==================== MEMORY CLEANUP ====================

/** Cleanup interval reference for graceful shutdown */
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic cleanup of caches
 */
export function startCacheCleanup(): void {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(() => {
    const now = Date.now();

    // Clean up expired queryCache entries
    for (const [key, data] of queryCache.entries()) {
      if (now > data.expiry) {
        queryCache.delete(key);
      }
    }

    // Clean up collectionLoadStatus with TTL
    for (const [key, data] of collectionLoadStatus.entries()) {
      if (data.timestamp && now - data.timestamp > COLLECTION_STATUS_TTL) {
        collectionLoadStatus.delete(key);
      }
    }
  }, 300000); // Run every 5 minutes
}

/**
 * Stop the cleanup interval
 */
export function stopCacheCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

// Start cleanup on module load
startCacheCleanup();

// ==================== UTILITY FUNCTIONS ====================

/**
 * Retry operation with exponential backoff
 * @param operation - The operation to retry
 * @param maxRetries - Maximum number of retries
 * @param initialDelay - Initial delay in milliseconds
 * @returns Result of the operation
 */
export async function retryMilvusOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 100
): Promise<T> {
  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const isRetryable =
        lastError.message?.includes('connection') ||
        lastError.message?.includes('timeout') ||
        lastError.message?.includes('busy') ||
        (error as { code?: string })?.code === 'NetworkError' ||
        (error as { status?: { code?: string } })?.status?.code === 'Unavailable';

      if (isRetryable && attempt < maxRetries) {
        logger.log(
          'Milvus',
          `Retrying operation, attempt ${attempt}/${maxRetries} after ${delay}ms delay. Error: ${lastError.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  throw lastError;
}

/**
 * Validate embedding dimensions
 * @param embedding - The embedding buffer
 * @param expectedDim - Expected dimensions
 */
export function validateEmbeddingDimension(
  embedding: Buffer,
  expectedDim: number
): void {
  const requiredBytes = expectedDim / 8;
  if (embedding.length !== requiredBytes) {
    throw new Error(
      `Dimension mismatch: expected ${expectedDim} bits (${requiredBytes} bytes), but got ${embedding.length} bytes.`
    );
  }
}

// ==================== UNIFIED SCHEMA GENERATOR ====================

/**
 * Unified schema generator for all collection types
 * @param collectionType - Type of collection
 * @param userId - User ID
 * @returns Collection schema
 */
export async function generateCollectionSchema(
  collectionType: MilvusCollectionType,
  userId: string
): Promise<MilvusCollectionSchema | null> {
  const baseConfig = {
    consistency_level: ConsistencyLevelEnum.Strong,
  };

  type SchemaMap = Record<string, Omit<MilvusCollectionSchema, 'consistency_level'>>;

  const schemas: SchemaMap = {
    users: {
      collection_name: `${await retrieveConfigValue('milvus.collections.user')}_${userId}`,
      schema: [
        {
          name: 'embedding',
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'username',
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: true,
          auto_id: false,
        },
        {
          name: 'gender',
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'age',
          data_type: DataType.Int64,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'residence',
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: false,
          auto_id: false,
        },
      ],
      index_params: [
        {
          field_name: 'embedding',
          index_name: 'emb_user_lookup',
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
      ],
    },

    intelligence: {
      collection_name: `${await retrieveConfigValue('milvus.collections.intelligence')}_${userId}`,
      schema: [
        {
          name: 'embedding',
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
        },
        {
          name: 'relation',
          data_type: DataType.VarChar,
          max_length: 512,
          is_primary_key: true,
          auto_id: true,
        },
        {
          name: 'text_content',
          data_type: DataType.VarChar,
          max_length: 8192,
          is_primary_key: false,
        },
      ],
      index_params: [
        {
          field_name: 'embedding',
          index_name: 'emb_doc_lookup',
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
      ],
    },

    twitch_chat: {
      collection_name: `${await retrieveConfigValue('milvus.collections.chat')}_${userId}`,
      schema: [
        {
          name: 'embedding',
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'username',
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: true,
          auto_id: false,
        },
        {
          name: 'text_content',
          data_type: DataType.VarChar,
          max_length: 4096,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'raw_msg',
          data_type: DataType.VarChar,
          max_length: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'ai_message',
          data_type: DataType.VarChar,
          max_length: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'time_stamp',
          data_type: DataType.Int64,
          is_primary_key: false,
          auto_id: false,
        },
      ],
      index_params: [
        {
          field_name: 'embedding',
          index_name: 'emb_chat_lookup',
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
        // Note: Scalar field indexes may need to be created separately
        // depending on Milvus version and configuration
      ],
    },

    vocal: {
      collection_name: `${await retrieveConfigValue('milvus.collections.voice')}_${userId}`,
      schema: [
        {
          name: 'embedding',
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'username',
          data_type: DataType.VarChar,
          max_length: 32,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'user_message',
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: true,
          auto_id: false,
        },
        {
          name: 'ai_resp',
          data_type: DataType.VarChar,
          max_length: 4096,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'summary',
          data_type: DataType.VarChar,
          max_length: 4096,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: 'date_time',
          data_type: DataType.VarChar,
          max_length: 1024,
          is_primary_key: false,
          auto_id: false,
        },
      ],
      index_params: [
        {
          field_name: 'embedding',
          index_name: 'emb_voice_lookup',
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
      ],
    },
  };

  // Alias voice to vocal
  schemas['voice'] = schemas['vocal']!;
  // Alias chat to twitch_chat
  schemas['chat'] = schemas['twitch_chat']!;

  const schema = schemas[collectionType];
  if (!schema) {
    logger.log('Milvus', `No schema defined for collection ${collectionType}`);
    return null;
  }

  return { ...baseConfig, ...schema } as MilvusCollectionSchema;
}

// ==================== COLLECTION MANAGEMENT ====================

/**
 * Ensure collection is loaded with optimized caching
 * @param collectionName - Collection name
 * @param userId - User ID
 * @returns True if loaded successfully
 */
export async function ensureCollectionLoaded(
  collectionName: string,
  userId: string
): Promise<boolean> {
  const key = `${collectionName}_${userId}`;
  const cacheExpiry = 60 * 60 * 1000; // 1 hour

  // Check cache first
  const cached = collectionLoadStatus.get(key);
  if (cached && cached.loaded && Date.now() - cached.timestamp < cacheExpiry) {
    return true;
  }

  try {
    const client = await getClient();
    const collectionStatus = await client.getLoadState({
      collection_name: key,
    });

    if (collectionStatus.state === LoadState.LoadStateNotExist) {
      logger.log('Milvus', `Collection ${key} does not exist`);
      return false;
    }

    if (collectionStatus.state === LoadState.LoadStateNotLoad) {
      await client.loadCollection({
        collection_name: key,
      });
      logger.log('Milvus', `Collection ${key} loaded successfully.`);
    }

    collectionLoadStatus.set(key, { loaded: true, timestamp: Date.now() });
    return true;
  } catch (error) {
    logger.log('Milvus', `Error loading collection: ${error}`);
    collectionLoadStatus.set(key, { loaded: false, timestamp: Date.now() });
    return false;
  }
}

/**
 * Check if collection exists and create it if needed
 * @param collection - Collection type
 * @param userId - User ID
 * @returns True if collection exists or was created
 */
export async function checkAndCreateCollection(
  collection: string,
  userId: string
): Promise<boolean> {
  try {
    const client = await getClient();
    const exists = await client.hasCollection({
      collection_name: `${collection}_${userId}`,
    });

    if (!exists.value) {
      logger.log(
        'Milvus',
        `Collection '${collection}_${userId}' does not exist. Creating...`
      );

      const schema = await generateCollectionSchema(collection as MilvusCollectionType, userId);
      if (!schema) {
        logger.log(
          'Milvus',
          `Error: No schema found for collection ${collection}.`
        );
        return false;
      }

      const response = await client.createCollection(schema as Parameters<typeof client.createCollection>[0]);
      if (response.error_code === 'Success') {
        logger.log(
          'Milvus',
          `Collection '${collection}_${userId}' created successfully.`
        );
        return true;
      } else {
        logger.log(
          'Milvus',
          `Failed to create collection '${collection}_${userId}'. Reason: ${response.reason}`
        );
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.log(
      'Milvus',
      `Error checking or creating collection '${collection}_${userId}': ${error}`
    );
    return false;
  }
}

/**
 * Retrieves the schema of a collection in Milvus
 * @param collection - The name of the collection
 * @param userId - The user ID
 * @returns The schema of the collection
 */
export async function getCollectionSchema(
  collection: string,
  userId: string
): Promise<{ fields: Array<{ name: string; type_params: Array<{ key: string; value: string }> }> }> {
  try {
    const client = await getClient();
    const schemaResponse = await client.describeCollection({
      collection_name: `${collection}_${userId}`,
    });
    return schemaResponse.schema as { fields: Array<{ name: string; type_params: Array<{ key: string; value: string }> }> };
  } catch (error) {
    logger.log('Milvus', `Error fetching schema: ${error}`);
    throw error;
  }
}

// ==================== LEGACY FUNCTION WRAPPERS ====================

/**
 * Legacy wrapper: Returns the appropriate schema for a given collection and user ID
 */
export async function returnCollectionSchema(
  collection: string,
  userId: string
): Promise<MilvusCollectionSchema | null> {
  return await generateCollectionSchema(collection as MilvusCollectionType, userId);
}

/**
 * Legacy wrapper: Creates a collection in Milvus if it doesn't exist
 */
export async function createCollection(
  collection: string,
  userId: string
): Promise<void> {
  await checkAndCreateCollection(collection, userId);
}

/**
 * Legacy wrapper: Loads a collection in Milvus if it's not already loaded
 */
export async function loadCollectionIfNeeded(
  collectionName: string,
  userId: string
): Promise<boolean> {
  return await ensureCollectionLoaded(collectionName, userId);
}

// ==================== VECTOR BATCHING OPTIMIZATION ====================

/**
 * Schedule vector insertion for batch processing
 * @param collectionType - Type of collection
 * @param userId - User ID
 * @param vector - Vector data to insert
 */
export function scheduleVectorInsertion(
  collectionType: string,
  userId: string,
  vector: VectorInsertData
): void {
  const key = `${collectionType}_${userId}`;

  if (!pendingVectors.has(key)) {
    pendingVectors.set(key, []);
    setTimeout(() => processVectorBatch(collectionType, userId), MAX_WAIT_MS);
  }

  const batch = pendingVectors.get(key);
  if (batch) {
    batch.push(vector);

    if (batch.length >= MAX_BATCH_SIZE) {
      processVectorBatch(collectionType, userId);
    }
  }
}

/**
 * Process batched vector insertions
 * @param collectionType - Type of collection
 * @param userId - User ID
 */
export async function processVectorBatch(
  collectionType: string,
  userId: string
): Promise<void> {
  const key = `${collectionType}_${userId}`;
  if (!pendingVectors.has(key)) return;

  const vectors = pendingVectors.get(key);
  pendingVectors.delete(key);

  if (!vectors || vectors.length === 0) return;

  try {
    const client = await getClient();
    await client.insert({
      collection_name: `${await retrieveConfigValue(`milvus.collections.${collectionType}`)}_${userId}`,
      data: vectors as unknown as RowData[],
    });

    logger.log(
      'Milvus',
      `Batch inserted ${vectors.length} vectors into ${collectionType}_${userId}`
    );
  } catch (error) {
    logger.log('Milvus', `Error batch inserting vectors: ${error}`);
  }
}

// ==================== UNIFIED SEARCH FUNCTIONS ====================

/**
 * Get optimized search parameters based on collection size and requirements
 */
export async function getOptimizedSearchParams(
  collectionName: string,
  userId: string,
  queryEmbedding: Buffer,
  limit: number,
  textParam: string | string[],
  options: MilvusSearchOptions = {}
): Promise<{
  collection_name: string;
  data: Buffer;
  topk: number;
  metric_type: string;
  output_fields: string[];
  vector_type: number;
  search_params: unknown;
  consistency_level: number;
}> {
  const client = await getClient();
  const collStats = await client.getCollectionStatistics({
    collection_name: `${collectionName}_${userId}`,
  });

  // Extract row count from stats array (Milvus returns stats as key-value pairs)
  const rowCountStat = collStats.stats?.find((s: { key: string }) => s.key === 'row_count');
  const rowCount = rowCountStat ? parseInt(String(rowCountStat.value)) : 0;
  let nprobe = 16;
  let consistencyLevel = ConsistencyLevelEnum.Session;

  if (rowCount < 1000) {
    nprobe = 8;
  } else if (rowCount > 100000) {
    nprobe = 32;
  }

  if (options.requireStrongConsistency) {
    consistencyLevel = ConsistencyLevelEnum.Strong;
  }

  if (options.criticalSearch) {
    nprobe = Math.min(rowCount / 10, 64);
    consistencyLevel = ConsistencyLevelEnum.Strong;
  }

  return {
    collection_name: `${collectionName}_${userId}`,
    data: queryEmbedding,
    topk: limit,
    metric_type: MetricType.JACCARD,
    output_fields: Array.isArray(textParam) ? textParam : [textParam],
    vector_type: DataType.BinaryVector,
    search_params: {
      anns_field: 'embedding',
      topk: limit,
      metric_type: MetricType.JACCARD,
      params: JSON.stringify({ nprobe }),
    },
    consistency_level: consistencyLevel,
  };
}

/**
 * Core search function for all Milvus collections
 */
export async function searchDocumentsInMilvus(
  queryEmbedding: Buffer,
  collectionName: string,
  textParam: string | string[],
  limit: number,
  userId: string,
  options: MilvusSearchOptions = {}
): Promise<MilvusSearchResponse> {
  if (!queryEmbedding || queryEmbedding.length === 0) {
    logger.log('Milvus', 'Query embedding is empty.');
    return { results: [] };
  }

  try {
    const isLoaded = await ensureCollectionLoaded(collectionName, userId);
    if (!isLoaded) {
      logger.log(
        'Milvus',
        `Collection ${collectionName}_${userId} not available for search.`
      );
      return { results: [] };
    }

    const startTime = performance.now();
    const searchParams = await getOptimizedSearchParams(
      collectionName,
      userId,
      queryEmbedding,
      limit,
      textParam,
      options
    );

    const client = await getClient();
    const searchResponse = await retryMilvusOperation(
      () => client.search(searchParams as Parameters<typeof client.search>[0]),
      options.maxRetries || 3
    );

    const timeElapsed = (performance.now() - startTime) / 1000;
    logger.log(
      'DB Metrics',
      `Vector search took ${timeElapsed.toFixed(3)} seconds for query in collection "${collectionName}".`
    );

    return searchResponse as MilvusSearchResponse;
  } catch (error) {
    logger.log('Milvus', `Error searching in Milvus: ${error}`);
    return { results: [] };
  }
}

// ==================== UNIFIED VECTOR INSERTION ====================

/**
 * Generic vector insertion function for all collection types
 * @param collectionType - Type of collection
 * @param userId - User ID
 * @param vectorData - Data to insert
 * @param useBatching - Whether to use batch insertion
 * @returns Success status
 */
export async function insertVectorToMilvus(
  collectionType: string,
  userId: string,
  vectorData: VectorInsertData,
  useBatching: boolean = false
): Promise<boolean> {
  try {
    const collectionTypeConfig = await retrieveConfigValue<string>(`milvus.collections.${collectionType}`);
    if (!collectionTypeConfig) {
      logger.log('Milvus', `Collection type ${collectionType} not configured`);
      return false;
    }
    const collectionName = `${collectionTypeConfig}_${userId}`;

    const client = await getClient();
    const exists = await client.hasCollection({
      collection_name: collectionName,
    });
    if (!exists.value) {
      const created = await checkAndCreateCollection(
        collectionTypeConfig,
        userId
      );
      if (!created) {
        logger.log('Milvus', `Failed to create collection ${collectionName}.`);
        return false;
      }
    }

    const isLoaded = await ensureCollectionLoaded(
      collectionTypeConfig,
      userId
    );
    if (!isLoaded) {
      logger.log('Milvus', `Failed to load collection ${collectionName}.`);
      return false;
    }

    if (useBatching) {
      scheduleVectorInsertion(collectionType, userId, vectorData);
      return true;
    }

    const insertResponse = await client.insert({
      collection_name: collectionName,
      data: [vectorData as unknown as RowData],
    });

    if (insertResponse.status.error_code === 'Success') {
      logger.log('Milvus', `Inserted data into collection ${collectionName}`);
      return true;
    } else {
      logger.log(
        'Milvus',
        `Failed to insert data into ${collectionName}. Reason: ${insertResponse.status.reason}`
      );
      return false;
    }
  } catch (error) {
    logger.log(
      'Milvus',
      `Error in insertVectorToMilvus for ${collectionType}: ${error}`
    );
    return false;
  }
}

// ==================== DELETE OPERATIONS ====================

/**
 * Delete vectors from a collection by relation
 */
export async function deleteVectorsFromMilvus(
  relations: string[],
  collection: string,
  userId: string
): Promise<void> {
  try {
    const client = await getClient();
    for (const relation of relations) {
      const deleteResponse = await client.deleteEntities({
        collection_name: `${collection}_${userId}`,
        expr: `relation in ['${relation}']`,
      });

      if (deleteResponse.status.error_code === 'Success') {
        logger.log(
          'Milvus',
          `Deleted vector with relation '${relation}' from ${collection}_${userId}`
        );
      } else {
        logger.log(
          'Milvus',
          `Failed to delete vector with relation '${relation}' from ${collection}_${userId}. Reason: ${deleteResponse.status.reason}`
        );
      }
    }
  } catch (error) {
    logger.log('Milvus', `Error deleting vectors: ${error}`);
  }
}

/**
 * Drop a collection
 */
async function dropCollection(
  collection: string,
  userId: string
): Promise<boolean> {
  const collectionName = `${collection}_${userId}`;
  try {
    const client = await getClient();
    const exists = await client.hasCollection({
      collection_name: collectionName,
    });

    if (!exists.value) {
      logger.log('Milvus', `Collection '${collectionName}' does not exist.`);
      return false;
    }

    const status = await client.dropCollection({
      collection_name: collectionName,
    });

    if (status.error_code === 'Success') {
      logger.log(
        'Milvus',
        `Collection '${collectionName}' dropped successfully.`
      );
      return true;
    } else {
      logger.log(
        'Milvus',
        `Failed to drop collection '${collectionName}'. Reason: ${status.reason}`
      );
      return false;
    }
  } catch (error) {
    logger.log(
      'Milvus',
      `Error dropping collection '${collectionName}': ${error}`
    );
    return false;
  }
}

/**
 * Drop collections (all for user or specific collection)
 */
export async function weGottaGoBald(
  collection: string,
  userId: string
): Promise<boolean> {
  try {
    if (userId === 'all') {
      const allUsers = await returnAPIKeys();
      let allDropsSuccessful = true;

      for (const user of allUsers) {
        if (collection === 'all') {
          const allCollections: (string | undefined)[] = [
            await retrieveConfigValue<string>('milvus.collections.user'),
            await retrieveConfigValue<string>('milvus.collections.intelligence'),
            await retrieveConfigValue<string>('milvus.collections.chat'),
            await retrieveConfigValue<string>('milvus.collections.voice'),
          ];
          for (const coll of allCollections) {
            if (!coll) continue;
            const success = await dropCollection(coll, user.user_id);
            if (!success) {
              allDropsSuccessful = false;
            }
          }
        } else {
          const success = await dropCollection(collection, user.user_id);
          if (!success) {
            allDropsSuccessful = false;
          }
        }
      }
      return allDropsSuccessful;
    } else {
      return await dropCollection(collection, userId);
    }
  } catch (error) {
    logger.log('Milvus', `Error during database reload: ${error}`);
    return false;
  }
}

// ==================== HEALTH CHECKS ====================

/**
 * Check if Milvus is healthy
 */
export async function checkMilvusHealth(): Promise<boolean> {
  try {
    const client = await getClient();
    const isUp = await client.checkHealth();
    return isUp.isHealthy;
  } catch {
    return false;
  }
}

/**
 * Detailed health check for Milvus
 */
export async function checkMilvusHealthDetailed(
  userId: string | null = null
): Promise<MilvusHealthResult> {
  try {
    const client = await getClient();
    const isHealthy = await client.checkHealth();

    const healthData: MilvusHealthResult = {
      isHealthy: isHealthy.isHealthy,
      timestamp: Date.now(),
      metrics: {},
    };

    if (!isHealthy.isHealthy) {
      logger.log('Milvus', 'Milvus health check failed');
      return healthData;
    }

    if (userId) {
      const collections: (string | undefined)[] = [
        await retrieveConfigValue<string>('milvus.collections.user'),
        await retrieveConfigValue<string>('milvus.collections.intelligence'),
        await retrieveConfigValue<string>('milvus.collections.chat'),
        await retrieveConfigValue<string>('milvus.collections.voice'),
      ];

      const collectionStats: Record<string, CollectionHealthStatus> = {};

      for (const collection of collections) {
        if (!collection) continue;
        const collName = `${collection}_${userId}`;
        try {
          const exists = await client.hasCollection({
            collection_name: collName,
          });

          if (exists.value) {
            const stats = await client.getCollectionStatistics({
              collection_name: collName,
            });
            const loadState = await client.getLoadState({
              collection_name: collName,
            });

            const rowCountStat = stats.stats?.find((s: { key: string }) => s.key === 'row_count');
            collectionStats[collection] = {
              exists: true,
              rowCount: rowCountStat ? parseInt(String(rowCountStat.value)) : 0,
              loadState: loadState.state,
            };
          } else {
            collectionStats[collection] = {
              exists: false,
            };
          }
        } catch (err) {
          collectionStats[collection] = {
            exists: 'error',
            error: (err as Error).message,
          };
        }
      }

      healthData.metrics!.collections = collectionStats;
    }

    try {
      const sysInfo = await client.getMetric({ request: { metric_type: 'system_info' } });

      if (sysInfo && sysInfo.response) {
        healthData.metrics!.system = sysInfo.response;
      }
    } catch (error) {
      healthData.metrics!.system = { error: (error as Error).message };
    }

    healthData.metrics!.cache = {
      queryCache: {
        size: queryCache.size,
        maxSize: MAX_CACHE_SIZE,
      },
      collectionLoadStatus: {
        size: collectionLoadStatus.size,
      },
    };

    return healthData;
  } catch (error) {
    logger.log('Milvus', `Error in detailed health check: ${error}`);
    return {
      isHealthy: false,
      error: (error as Error).message,
      timestamp: Date.now(),
    };
  }
}

// ==================== UPSERT OPERATIONS ====================

/**
 * Upsert intelligence vectors (batch operation)
 * @param data - Array of vector data
 * @param collection - Collection name
 * @param userId - User ID
 * @returns Success status
 */
export async function upsertIntelligenceToMilvus(
  data: Array<{ relation: string; text_content: string; embedding: number[] }>,
  collection: string,
  userId: string
): Promise<boolean> {
  if (!data || data.length === 0) {
    logger.log('Milvus', 'No data to upsert.');
    return false;
  }

  try {
    const client = await getClient();
    const upsertResponse = await client.upsert({
      collection_name: `${collection}_${userId}`,
      fields_data: data,
    });

    if (upsertResponse.status.error_code === 'Success') {
      logger.log(
        'Milvus',
        `Upserted ${data.length} items into ${collection}_${userId}`
      );
      return true;
    } else {
      logger.log(
        'Milvus',
        `Failed to upsert data into ${collection}_${userId}. Reason: ${upsertResponse.status.reason}`
      );
      return false;
    }
  } catch (error) {
    logger.log('Milvus', `Error upserting data: ${error}`);
    return false;
  }
}

// ==================== CACHE STATISTICS ====================

/**
 * Get vector database cache statistics
 */
export function getVectorCacheStats(): {
  queryCache: { size: number; maxSize: number };
  collectionLoadStatus: { size: number };
  pendingVectors: { batchCount: number; totalVectors: number };
} {
  let totalVectors = 0;
  for (const batch of pendingVectors.values()) {
    totalVectors += batch.length;
  }

  return {
    queryCache: {
      size: queryCache.size,
      maxSize: MAX_CACHE_SIZE,
    },
    collectionLoadStatus: {
      size: collectionLoadStatus.size,
    },
    pendingVectors: {
      batchCount: pendingVectors.size,
      totalVectors,
    },
  };
}
