import axios from "axios";
import fs from "fs-extra";
import path from "path";
import fetch from "node-fetch";
import https from "https";
import { performance } from "node:perf_hooks";
import { processAudio } from "./audio-processor.js";
import {
  MilvusClient,
  DataType,
  MetricType,
  IndexType,
  ConsistencyLevelEnum,
  LoadState,
  buildSearchParams,
} from "@zilliz/milvus2-sdk-node";
import OpenAI from "openai";
import FormData from "form-data";
import {
  replyStripped,
  queryPrompt,
  contextPromptChat,
  eventPromptChat,
  rerankPrompt,
  fixTTSString,
  sendChatCompletionRequest,
  sendToolCompletionRequest,
} from "./prompt-helper.js";
import { SummaryRequestBody } from "./oai-requests.js";
import { returnTwitchEvent } from "./twitch-helper.js";
import {
  resultsReranked,
  createRagError,
  pullFromWebScraper,
} from "./data-helper.js";
import { returnAuthObject } from "./api-helper.js";
import { retrieveConfigValue } from "./config-helper.js";
import { fileURLToPath } from "url";

// ==================== CONSTANTS AND GLOBALS ====================
const queryCache = new Map();
const collectionLoadStatus = new Map();
const pendingVectors = new Map();
const MAX_BATCH_SIZE = 100;
const MAX_CACHE_SIZE = 150;
const DEFAULT_TTL = 60000;
const MAX_WAIT_MS = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Milvus client
const milvusDatabaseUrl = await retrieveConfigValue("milvus.endpoint");
const client = new MilvusClient({
  address: milvusDatabaseUrl,
});

// ==================== CACHING UTILITIES ====================
/**
 * Get a cached result if available and not expired
 * @param {string} key - Unique cache key
 * @returns {any} - The cached result or null if not found/expired
 */
function getCachedResult(key) {
  if (!queryCache.has(key)) return null;

  const { result, expiry } = queryCache.get(key);
  if (Date.now() > expiry) {
    queryCache.delete(key);
    return null;
  }

  logger.log("Milvus", `Cache hit for query: ${key}`);
  return result;
}

/**
 * Store a result in the query cache with LRU eviction
 * @param {string} key - Unique cache key
 * @param {any} result - Result to cache
 * @param {number} ttl - Time to live in milliseconds
 */
function setCachedResult(key, result, ttl = DEFAULT_TTL) {
  // Implement LRU eviction if cache gets too large
  if (queryCache.size >= MAX_CACHE_SIZE) {
    let oldestKey = null;
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
 * @param {string} [pattern] - Optional pattern to match keys for selective clearing
 */
function clearQueryCache(pattern = null) {
  if (!pattern) {
    queryCache.clear();
    logger.log("Milvus", "Query cache cleared");
    return;
  }

  for (const key of queryCache.keys()) {
    if (key.includes(pattern)) {
      queryCache.delete(key);
    }
  }

  logger.log("Milvus", `Query cache entries matching '${pattern}' cleared`);
}

// ==================== UTILITY FUNCTIONS ====================
/**
 * Retry operation with exponential backoff
 * @param {Function} operation - The operation to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} initialDelay - Initial delay in milliseconds
 * @returns {Promise<any>} - Result of the operation
 */
async function retryMilvusOperation(
  operation,
  maxRetries = 3,
  initialDelay = 100
) {
  let lastError;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const isRetryable =
        error.message?.includes("connection") ||
        error.message?.includes("timeout") ||
        error.message?.includes("busy") ||
        error.code === "NetworkError" ||
        error.status?.code === "Unavailable";

      if (isRetryable && attempt < maxRetries) {
        logger.log(
          "Milvus",
          `Retrying operation, attempt ${attempt}/${maxRetries} after ${delay}ms delay. Error: ${error.message}`
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
 * @param {Buffer} embedding - The embedding buffer
 * @param {number} expectedDim - Expected dimensions
 */
export function validateEmbeddingDimension(embedding, expectedDim) {
  const requiredBytes = expectedDim / 8;
  if (embedding.length !== requiredBytes) {
    throw new Error(
      `Dimension mismatch: expected ${expectedDim} bits (${requiredBytes} bytes), but got ${embedding.length} bytes.`
    );
  }
}

/**
 * Axios request with retry logic
 * @param {object} config - Axios configuration
 * @param {number} attempts - Number of attempts
 * @param {number} initialDelay - Initial delay
 * @returns {Promise<object>} - Response object
 */
export async function axiosRequestWithRetry(
  config,
  attempts = 3,
  initialDelay = 1000
) {
  let delay = initialDelay;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios(config);
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * Get message embedding
 * @param {string|string[]} message - Message(s) to embed
 * @returns {Promise<number[]|number[][]>} - Embedding(s)
 */
export async function getMessageEmbedding(message) {
  const embeddingData = {
    input: Array.isArray(message) ? message : [message],
    model: await retrieveConfigValue("models.embedding.model"),
  };

  try {
    const config = {
      method: "post",
      url: `${await retrieveConfigValue("models.embedding.endpoint")}/embeddings`,
      data: embeddingData,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await retrieveConfigValue("models.embedding.apiKey")}`,
      },
      timeout: 30000,
    };

    const response = await axiosRequestWithRetry(config, 3, 1000);
    const embeddingResp = response.data.data;
    return embeddingResp.length > 1
      ? embeddingResp.map((item) => item.embedding)
      : embeddingResp[0].embedding;
  } catch (error) {
    logger.log("System", `Error generating embedding: ${error}`);
    throw error;
  }
}

// ==================== UNIFIED SCHEMA GENERATOR ====================
/**
 * Unified schema generator for all collection types
 * @param {string} collectionType - Type of collection
 * @param {string} userId - User ID
 * @returns {Promise<object>} - Collection schema
 */
async function generateCollectionSchema(collectionType, userId) {
  const baseConfig = {
    consistency_level: ConsistencyLevelEnum.Strong,
  };

  const schemas = {
    users: {
      collection_name: `${await retrieveConfigValue("milvus.collections.user")}_${userId}`,
      schema: [
        {
          name: "embedding",
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "username",
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: true,
          auto_id: false,
        },
        {
          name: "gender",
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "age",
          data_type: DataType.Int64,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "residence",
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: false,
          auto_id: false,
        },
      ],
      index_params: [
        {
          field_name: "embedding",
          index_name: "emb_user_lookup",
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
      ],
    },

    intelligence: {
      collection_name: `${await retrieveConfigValue("milvus.collections.intelligence")}_${userId}`,
      schema: [
        {
          name: "embedding",
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
        },
        {
          name: "relation",
          data_type: DataType.VarChar,
          max_length: 512,
          is_primary_key: true,
          auto_id: true,
        },
        {
          name: "text_content",
          data_type: DataType.VarChar,
          max_length: 8192,
          is_primary_key: false,
        },
      ],
      index_params: [
        {
          field_name: "embedding",
          index_name: "emb_doc_lookup",
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
      ],
    },

    twitch_chat: {
      collection_name: `${await retrieveConfigValue("milvus.collections.chat")}_${userId}`,
      schema: [
        {
          name: "embedding",
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "username",
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: true,
          auto_id: false,
        },
        {
          name: "text_content",
          data_type: DataType.VarChar,
          max_length: 4096,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "raw_msg",
          data_type: DataType.VarChar,
          max_length: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "ai_message",
          data_type: DataType.VarChar,
          max_length: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "time_stamp",
          data_type: DataType.Int64,
          is_primary_key: false,
          auto_id: false,
        },
      ],
      index_params: [
        {
          field_name: "embedding",
          index_name: "emb_chat_lookup",
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
        {
          field_name: "time_stamp",
          index_name: "idx_time_stamp",
          index_type: IndexType.RANGE,
        },
      ],
    },

    vocal: {
      collection_name: `${await retrieveConfigValue("milvus.collections.voice")}_${userId}`,
      schema: [
        {
          name: "embedding",
          data_type: DataType.BinaryVector,
          dim: 1024,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "username",
          data_type: DataType.VarChar,
          max_length: 32,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "user_message",
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: true,
          auto_id: false,
        },
        {
          name: "ai_resp",
          data_type: DataType.VarChar,
          max_length: 4096,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "summary",
          data_type: DataType.VarChar,
          max_length: 4096,
          is_primary_key: false,
          auto_id: false,
        },
        {
          name: "date_time",
          data_type: DataType.VarChar,
          max_length: 1024,
          is_primary_key: false,
          auto_id: false,
        },
      ],
      index_params: [
        {
          field_name: "embedding",
          index_name: "emb_voice_lookup",
          index_type: IndexType.BIN_IVF_FLAT,
          metric_type: MetricType.JACCARD,
          params: { nlist: 2048 },
        },
      ],
    },
  };

  const schema = schemas[collectionType];
  if (!schema) {
    logger.log("Milvus", `No schema defined for collection ${collectionType}`);
    return null;
  }

  return { ...baseConfig, ...schema };
}

// ==================== COLLECTION MANAGEMENT ====================
/**
 * CONSOLIDATED: Ensure collection is loaded with optimized caching
 * @param {string} collectionName - Collection name
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - True if loaded successfully
 */
async function ensureCollectionLoaded(collectionName, userId) {
  const key = `${collectionName}_${userId}`;
  const cacheExpiry = 60 * 60 * 1000; // 1 hour

  // Check cache first
  const cached = collectionLoadStatus.get(key);
  if (cached && cached.loaded && Date.now() - cached.timestamp < cacheExpiry) {
    return true;
  }

  try {
    const collectionStatus = await client.getLoadState({
      collection_name: key,
    });

    if (collectionStatus.state === LoadState.LoadStateNotExist) {
      logger.log("Milvus", `Collection ${key} does not exist`);
      return false;
    }

    if (collectionStatus.state === LoadState.LoadStateNotLoad) {
      await client.loadCollection({
        collection_name: key,
      });
      logger.log("Milvus", `Collection ${key} loaded successfully.`);
    }

    collectionLoadStatus.set(key, { loaded: true, timestamp: Date.now() });
    return true;
  } catch (error) {
    logger.log("Milvus", `Error loading collection: ${error}`);
    collectionLoadStatus.set(key, { loaded: false, timestamp: Date.now() });
    return false;
  }
}

/**
 * CONSOLIDATED: Check if collection exists and create it if needed
 * @param {string} collection - Collection type
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - True if collection exists or was created
 */
async function checkAndCreateCollection(collection, userId) {
  try {
    const exists = await client.hasCollection({
      collection_name: `${collection}_${userId}`,
    });

    if (!exists.value) {
      logger.log(
        "Milvus",
        `Collection '${collection}_${userId}' does not exist. Creating...`
      );

      const schema = await generateCollectionSchema(collection, userId);
      if (!schema) {
        logger.log(
          "Milvus",
          `Error: No schema found for collection ${collection}.`
        );
        return false;
      }

      const response = await client.createCollection(schema);
      if (response.error_code === "Success") {
        logger.log(
          "Milvus",
          `Collection '${collection}_${userId}' created successfully.`
        );
        return true;
      } else {
        logger.log(
          "Milvus",
          `Failed to create collection '${collection}_${userId}'. Reason: ${response.reason}`
        );
        return false;
      }
    }

    return true;
  } catch (error) {
    logger.log(
      "Milvus",
      `Error checking or creating collection '${collection}_${userId}': ${error}`
    );
    return false;
  }
}

// ==================== LEGACY FUNCTION WRAPPERS ====================
// These maintain backward compatibility with existing function names

/**
 * Legacy wrapper: Returns the appropriate schema for a given collection and user ID
 * @param {string} collection - The name of the collection
 * @param {string} userId - The user ID
 * @returns {object} - The schema for the specified collection
 */
async function returnCollectionSchema(collection, userId) {
  return await generateCollectionSchema(collection, userId);
}

/**
 * Legacy wrapper: Creates a collection in Milvus if it doesn't exist
 * @param {string} collection - The name of the collection to create
 * @param {string} userId - The user ID
 * @returns {Promise<void>}
 */
async function createCollection(collection, userId) {
  await checkAndCreateCollection(collection, userId);
}

/**
 * Legacy wrapper: Loads a collection in Milvus if it's not already loaded
 * @param {string} collectionName - The name of the collection
 * @param {string} userId - The user ID
 * @returns {Promise<boolean>} - True if the collection is loaded
 */
async function loadCollectionIfNeeded(collectionName, userId) {
  return await ensureCollectionLoaded(collectionName, userId);
}

/**
 * Legacy wrapper: Retrieves the schema of a collection in Milvus
 * @param {string} collection - The name of the collection
 * @param {string} userId - The user ID
 * @returns {Promise<object>} - The schema of the collection
 */
async function getCollectionSchema(collection, userId) {
  try {
    const schemaResponse = await client.describeCollection({
      collection_name: `${collection}_${userId}`,
    });
    return schemaResponse.schema;
  } catch (error) {
    logger.log("Milvus", `Error fetching schema: ${error}`);
    throw error;
  }
}

// ==================== VECTOR BATCHING OPTIMIZATION ====================
/**
 * Schedule vector insertion for batch processing
 * @param {string} collectionType - Type of collection
 * @param {string} userId - User ID
 * @param {object} vector - Vector data to insert
 */
async function scheduleVectorInsertion(collectionType, userId, vector) {
  const key = `${collectionType}_${userId}`;

  if (!pendingVectors.has(key)) {
    pendingVectors.set(key, []);
    setTimeout(() => processVectorBatch(collectionType, userId), MAX_WAIT_MS);
  }

  const batch = pendingVectors.get(key);
  batch.push(vector);

  if (batch.length >= MAX_BATCH_SIZE) {
    processVectorBatch(collectionType, userId);
  }
}

/**
 * Process batched vector insertions
 * @param {string} collectionType - Type of collection
 * @param {string} userId - User ID
 */
async function processVectorBatch(collectionType, userId) {
  const key = `${collectionType}_${userId}`;
  if (!pendingVectors.has(key)) return;

  const vectors = pendingVectors.get(key);
  pendingVectors.delete(key);

  if (vectors.length === 0) return;

  try {
    await client.insert({
      collection_name: `${await retrieveConfigValue(`milvus.collections.${collectionType}`)}_${userId}`,
      fields_data: vectors,
    });

    logger.log(
      "Milvus",
      `Batch inserted ${vectors.length} vectors into ${collectionType}_${userId}`
    );
  } catch (error) {
    logger.log("Milvus", `Error batch inserting vectors: ${error}`);
  }
}

// ==================== UNIFIED SEARCH FUNCTIONS ====================
/**
 * Get optimized search parameters based on collection size and requirements
 * @param {string} collectionName - Collection name
 * @param {string} userId - User ID
 * @param {Buffer} queryEmbedding - Query embedding
 * @param {number} limit - Result limit
 * @param {string|string[]} textParam - Output fields
 * @param {object} options - Search options
 * @returns {Promise<object>} - Search parameters
 */
async function getOptimizedSearchParams(
  collectionName,
  userId,
  queryEmbedding,
  limit,
  textParam,
  options = {}
) {
  const collStats = await client.getCollectionStatistics({
    collection_name: `${collectionName}_${userId}`,
  });

  const rowCount = parseInt(collStats.stats.row_count);
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
    search_params: buildSearchParams({
      nprobe: nprobe,
      limit: limit,
    }),
    consistency_level: consistencyLevel,
  };
}

/**
 * UNIFIED: Core search function for all Milvus collections
 * @param {Buffer} queryEmbedding - Query embedding
 * @param {string} collectionName - Collection name
 * @param {string|string[]} textParam - Output fields
 * @param {number} limit - Result limit
 * @param {string} userId - User ID
 * @param {object} options - Search options
 * @returns {Promise<object>} - Search results
 */
async function searchDocumentsInMilvus(
  queryEmbedding,
  collectionName,
  textParam,
  limit,
  userId,
  options = {}
) {
  if (!queryEmbedding || queryEmbedding.length === 0) {
    logger.log("Milvus", "Query embedding is empty.");
    return { results: [] };
  }

  try {
    const isLoaded = await ensureCollectionLoaded(collectionName, userId);
    if (!isLoaded) {
      logger.log(
        "Milvus",
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

    const searchResponse = await retryMilvusOperation(
      () => client.search(searchParams),
      options.maxRetries || 3
    );

    const timeElapsed = (performance.now() - startTime) / 1000;
    logger.log(
      "DB Metrics",
      `Vector search took ${timeElapsed.toFixed(3)} seconds for query in collection "${collectionName}".`
    );

    return searchResponse;
  } catch (error) {
    logger.log("Milvus", `Error searching in Milvus: ${error}`);
    return { results: [] };
  }
}

/**
 * UNIFIED: Generic function to find relevant items in any collection
 * @param {string} message - Search message
 * @param {string} userId - User ID
 * @param {string} collectionType - Type of collection to search
 * @param {string|string[]} outputFields - Fields to return
 * @param {number} topK - Number of results
 * @param {object} searchOptions - Additional search options
 * @returns {Promise<array>} - Search results
 */
async function findRelevantItems(
  message,
  userId,
  collectionType,
  outputFields,
  topK = 10,
  searchOptions = {}
) {
  const cacheKey = `${collectionType}_${userId}_${message}`;
  const cachedResult = getCachedResult(cacheKey);
  if (cachedResult) return cachedResult;

  try {
    const configKey = `milvus.collections.${collectionType}`;
    const collectionName = await retrieveConfigValue(configKey);

    const created = await checkAndCreateCollection(collectionName, userId);
    if (!created) {
      return [];
    }

    const messageEmbedding = await getMessageEmbedding(message);
    const binaryEmbedding = Buffer.from(messageEmbedding);

    // Validate embedding dimensions
    const collectionSchema = await getCollectionSchema(collectionName, userId);
    const embeddingField = collectionSchema.fields.find(
      (field) => field.name === "embedding"
    );
    const expectedDim = parseInt(
      embeddingField?.type_params.find((param) => param.key === "dim")?.value
    );
    validateEmbeddingDimension(binaryEmbedding, expectedDim);

    const searchResponse = await searchDocumentsInMilvus(
      binaryEmbedding,
      collectionName,
      outputFields,
      topK,
      userId,
      searchOptions
    );

    // Set appropriate cache TTL based on collection type
    const cacheTTL =
      collectionType === "intelligence"
        ? 300000 // 5 minutes for documents
        : collectionType === "chat"
          ? 30000 // 30 seconds for chats
          : 60000; // 1 minute for others

    setCachedResult(cacheKey, searchResponse.results, cacheTTL);
    return searchResponse.results;
  } catch (error) {
    logger.log(
      "Milvus",
      `Error in findRelevantItems for ${collectionType}: ${error}`
    );
    return [];
  }
}

// ==================== LEGACY SEARCH FUNCTION WRAPPERS ====================
/**
 * Legacy wrapper: Finds relevant chats (with fallback to MongoDB)
 * @param {string} message - The message to search for
 * @param {string} user - The username
 * @param {string} userId - The user ID
 * @param {number} topK - The number of top results to return
 * @returns {Promise<object[]|boolean>} - Search results
 */
async function findRelevantChats(message, user, userId, topK = 10) {
  try {
    // Import MongoDB search function for hybrid approach
    const { findRelevantChatContext } = await import("./mongodb-client.js");
    const results = await findRelevantChatContext(userId, message, user, topK, {
      useVectors: true,
      simpleTextSearch: true,
    });

    return results;
  } catch (error) {
    logger.log("Chat", `Error in findRelevantChats: ${error.message}`);

    // Fallback to Milvus-only search
    return await findRelevantItems(
      message,
      userId,
      "chat",
      ["text_content", "username", "raw_msg", "ai_message"],
      topK,
      { requireStrongConsistency: false }
    );
  }
}

/**
 * Legacy wrapper: Finds relevant documents in intelligence collection
 * @param {string} message - The message to search for
 * @param {string} userId - The user ID
 * @param {number} topK - The number of top results to return
 * @returns {Promise<object[]>} - Search results
 */
async function findRelevantDocuments(message, userId, topK = 10) {
  return await findRelevantItems(
    message,
    userId,
    "intelligence",
    ["text_content", "relation"],
    topK,
    { criticalSearch: true, maxRetries: 3 }
  );
}

/**
 * Legacy wrapper: Finds relevant voice interactions in voice collection
 * @param {string} message - The message to search for
 * @param {string} userId - The user ID
 * @param {number} topK - The number of top results to return
 * @returns {Promise<object[]>} - Search results
 */
async function findRelevantVoiceInMilvus(message, userId, topK = 5) {
  return await findRelevantItems(
    message,
    userId,
    "voice",
    ["summary", "username", "user_message", "ai_resp", "date_time"],
    topK,
    { requireStrongConsistency: false }
  );
}

// ==================== UNIFIED VECTOR INSERTION ====================
/**
 * UNIFIED: Generic vector insertion function for all collection types
 * @param {string} collectionType - Type of collection
 * @param {string} userId - User ID
 * @param {object} vectorData - Data to insert
 * @param {boolean} useBatching - Whether to use batch insertion
 * @returns {Promise<boolean>} - Success status
 */
async function insertVectorToMilvus(
  collectionType,
  userId,
  vectorData,
  useBatching = false
) {
  try {
    const configKey = `milvus.collections.${collectionType}`;
    const collectionName = `${await retrieveConfigValue(configKey)}_${userId}`;

    const exists = await client.hasCollection({
      collection_name: collectionName,
    });
    if (!exists.value) {
      const created = await checkAndCreateCollection(
        await retrieveConfigValue(configKey),
        userId
      );
      if (!created) {
        logger.log("Milvus", `Failed to create collection ${collectionName}.`);
        return false;
      }
    }

    const isLoaded = await ensureCollectionLoaded(
      await retrieveConfigValue(configKey),
      userId
    );
    if (!isLoaded) {
      logger.log("Milvus", `Failed to load collection ${collectionName}.`);
      return false;
    }

    if (useBatching) {
      scheduleVectorInsertion(collectionType, userId, vectorData);
      return true;
    }

    const insertResponse = await client.insert({
      collection_name: collectionName,
      fields_data: [vectorData],
    });

    if (insertResponse.status.error_code === "Success") {
      logger.log("Milvus", `Inserted data into collection ${collectionName}`);
      return true;
    } else {
      logger.log(
        "Milvus",
        `Failed to insert data into ${collectionName}. Reason: ${insertResponse.status.reason}`
      );
      return false;
    }
  } catch (error) {
    logger.log(
      "Milvus",
      `Error in insertVectorToMilvus for ${collectionType}: ${error}`
    );
    return false;
  }
}

// ==================== LEGACY VECTOR INSERTION WRAPPERS ====================
/**
 * Legacy wrapper: Inserts intelligence vectors
 * @param {number[]} vectors - The vector embeddings
 * @param {string} content - The content
 * @param {string} relational - Relational identifier
 * @param {string} userId - The user ID
 * @returns {Promise<boolean>} - Success status
 */
async function insertAugmentVectorsToMilvus(
  vectors,
  content,
  relational,
  userId
) {
  const vectorData = {
    embedding: vectors,
    relation: relational,
    text_content: content,
  };

  return await insertVectorToMilvus("intelligence", userId, vectorData);
}

/**
 * Legacy wrapper: Inserts voice interaction vectors
 * @param {number[]} vectors - The vector embeddings
 * @param {string} summary - Summary of interaction
 * @param {string} message - User message
 * @param {string} response - AI response
 * @param {string} user - Username
 * @param {string} date - Date timestamp
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - Success status
 */
async function insertVoiceVectorsIntoMilvus(
  vectors,
  summary,
  message,
  response,
  user,
  date,
  userId
) {
  const vectorData = {
    embedding: vectors,
    username: user,
    user_message: message,
    ai_resp: response,
    summary: summary,
    date_time: date,
  };

  return await insertVectorToMilvus("voice", userId, vectorData);
}

/**
 * Legacy wrapper: Adds chat message as vector with batching
 * @param {string} sumText - Summary text
 * @param {string} message - Original message
 * @param {string} username - Username
 * @param {string} date - Date
 * @param {string} response - AI response
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - Success status
 */
async function addChatMessageAsVector(
  sumText,
  message,
  username,
  date,
  response,
  userId
) {
  try {
    const currentTime = Date.now();
    const embeddingsArray = await getMessageEmbedding(sumText);

    const vectorData = {
      embedding: embeddingsArray,
      username: username,
      text_content: sumText,
      raw_msg: message,
      ai_message: response,
      time_stamp: currentTime,
    };

    scheduleVectorInsertion("chat", userId, vectorData);
    return true;
  } catch (error) {
    logger.log("Milvus", `Error processing chat text: ${error}`);
    return false;
  }
}

/**
 * Legacy wrapper: Adds voice message as vector
 * @param {string} sumString - Summary string
 * @param {string} message - Original message
 * @param {string} username - Username
 * @param {string} date - Date
 * @param {string} response - AI response
 * @param {string} userId - User ID
 */
async function addVoiceMessageAsVector(
  sumString,
  message,
  username,
  date,
  response,
  userId
) {
  try {
    const embeddingsArray = await getMessageEmbedding(message);
    const success = await insertVoiceVectorsIntoMilvus(
      embeddingsArray,
      sumString,
      message,
      response,
      username,
      date,
      userId
    );

    if (success) {
      logger.log("Milvus", "Voice message successfully inserted into Milvus.");
    } else {
      logger.log("Milvus", "Failed to insert voice message into Milvus.");
    }
  } catch (error) {
    logger.log("Milvus", `Error processing voice message: ${error}`);
  }
}

/**
 * Legacy wrapper: Upserts intelligence vectors (batch operation)
 * @param {object[]} data - Array of vector data
 * @param {string} collection - Collection name
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - Success status
 */
async function upsertIntelligenceToMilvus(data, collection, userId) {
  if (!data || data.length === 0) {
    logger.log("Milvus", "No data to upsert.");
    return false;
  }

  try {
    const upsertResponse = await client.upsert({
      collection_name: `${collection}_${userId}`,
      fields_data: data,
    });

    if (upsertResponse.status.error_code === "Success") {
      logger.log(
        "Milvus",
        `Upserted ${data.length} items into ${collection}_${userId}`
      );
      return true;
    } else {
      logger.log(
        "Milvus",
        `Failed to upsert data into ${collection}_${userId}. Reason: ${upsertResponse.status.reason}`
      );
      return false;
    }
  } catch (error) {
    logger.log("Milvus", `Error upserting data: ${error}`);
    return false;
  }
}

// ==================== REMAINING FUNCTIONS (UNCHANGED) ====================
// These functions remain as they were, since they don't have redundancy issues
// and are working well as specialized functions

async function returnRecentChats(
  userId,
  fromConsole = false,
  allChats = false
) {
  try {
    const userObj = await returnAuthObject(userId);
    const { getRecentChats } = await import("./mongodb-client.js");
    const startTime = performance.now();
    const limit = allChats ? 1000 : userObj.max_chats || 25;
    const messages = await getRecentChats(userId, limit);
    const sortedResults = messages.sort((a, b) => a.time_stamp - b.time_stamp);
    const formattedResults = sortedResults
      .map(
        (item) =>
          `- ${item.username} sent the following message in ${userObj.user_name}'s Twitch channel: ${item.raw_msg}`
      )
      .join("\n");

    const timeElapsed = (performance.now() - startTime) / 1000;
    logger.log(
      "DB Metrics",
      `Recent chats took ${timeElapsed.toFixed(3)} seconds for query.`
    );

    if (fromConsole) {
      return { chatList: formattedResults, executionTime: timeElapsed };
    } else {
      return formattedResults;
    }
  } catch (error) {
    logger.log("MongoDB", `Error in findRecentChats: ${error.message}`);
    return [];
  }
}

async function upsertUserInfo(userId, userInfo) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.user")}_${userId}`;
    const userEmbedding = await getMessageEmbedding(userInfo.username);

    const fieldsData = [
      {
        embedding: userEmbedding,
        username: userInfo.username,
        gender: userInfo.gender || "",
        age: userInfo.age || 0,
        residence: userInfo.residence || "",
      },
    ];

    await client.upsert({
      collection_name: collectionName,
      fields_data: fieldsData,
    });

    logger.log(
      "Milvus",
      `User info for ${userInfo.username} upserted in collection ${collectionName}.`
    );
  } catch (error) {
    logger.log("Milvus", `Error upserting user info: ${error}`);
  }
}

async function findUserInMilvus(username, userId) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.user")}_${userId}`;
    const collectionExists = await client.hasCollection({
      collection_name: collectionName,
    });

    if (!collectionExists.value) {
      logger.log("Milvus", `Collection ${collectionName} does not exist.`);
      return null;
    }

    const isLoaded = await ensureCollectionLoaded(collectionName, userId);
    if (!isLoaded) {
      logger.log("Milvus", `Collection ${collectionName} is not loaded.`);
      return null;
    }

    const usernameEmbedding = await getMessageEmbedding(username);
    const binaryEmbedding = Buffer.from(usernameEmbedding);

    const searchParams = {
      collection_name: collectionName,
      data: binaryEmbedding,
      search_params: buildSearchParams({
        anns_field: "embedding",
        topk: 1,
        metric_type: MetricType.JACCARD,
        params: JSON.stringify({ nprobe: 128 }),
      }),
      vector_type: DataType.BinaryVector,
      output_fields: ["gender", "age", "residence"],
    };

    const searchResponse = await client.search(searchParams);

    if (searchResponse.results.length > 0) {
      return searchResponse.results[0];
    } else {
      logger.log(
        "Milvus",
        `User ${username} not found in collection ${collectionName}.`
      );
      return null;
    }
  } catch (error) {
    logger.log("Milvus", `Error searching for user: ${error}`);
    return null;
  }
}

async function deleteVectorsFromMilvus(relations, collection, userId) {
  try {
    for (const relation of relations) {
      const deleteResponse = await client.deleteEntities({
        collection_name: `${collection}_${userId}`,
        expr: `relation in ['${relation}']`,
      });

      if (deleteResponse.status.error_code === "Success") {
        logger.log(
          "Milvus",
          `Deleted vector with relation '${relation}' from ${collection}_${userId}`
        );
      } else {
        logger.log(
          "Milvus",
          `Failed to delete vector with relation '${relation}' from ${collection}_${userId}. Reason: ${deleteResponse.status.reason}`
        );
      }
    }
  } catch (error) {
    logger.log("Milvus", `Error deleting vectors: ${error}`);
  }
}

export async function retrieveWebContext(urls, query, subject, userId) {
  if (!urls || urls.length === 0) {
    return createRagError(
      "context-retrieval",
      "No URLs provided for context extraction",
      { query: query }
    );
  }

  try {
    logger.log(
      "LLM",
      `Starting optimized web context retrieval for '${query}'`
    );

    const scrapePromises = urls.map((urlObj) =>
      pullFromWebScraper([urlObj], subject)
    );
    const pageContentsArray = await Promise.all(scrapePromises);
    const validContents = pageContentsArray.filter(
      (content) =>
        content && typeof content === "string" && content.trim() !== ""
    );

    if (validContents.length === 0) {
      return createRagError(
        "content-scraping",
        "No valid content found from scraped URLs",
        { urlCount: urls.length }
      );
    }

    const summaryPromises = validContents.map((content) =>
      summarizePage(content, subject)
    );
    const individualSummaries = await Promise.all(summaryPromises);

    const validSummaries = individualSummaries.filter(
      (summary) =>
        summary &&
        !summary.error &&
        summary.vectorString &&
        summary.summaryContents
    );

    if (validSummaries.length === 0) {
      return createRagError(
        "summarization",
        "Failed to generate valid summaries from content",
        { contentCount: validContents.length }
      );
    }

    const finalSummary = await finalCombinedSummary(validSummaries, subject);

    if (finalSummary && finalSummary.error) {
      return finalSummary;
    }

    if (
      !finalSummary ||
      !finalSummary.vectorString ||
      !finalSummary.summaryContents
    ) {
      return createRagError(
        "final-summary",
        "Failed to generate final combined summary",
        { summaryCount: validSummaries.length }
      );
    }

    const finalText = `### Final Summary for ${subject}:\n${finalSummary.summaryContents}`;
    const embeddingArray = await getMessageEmbedding(finalSummary.vectorString);

    if (!embeddingArray) {
      return createRagError(
        "embedding-generation",
        "Failed to generate embedding for summary",
        { vectorString: finalSummary.vectorString.substring(0, 100) + "..." }
      );
    }

    const upsertData = [
      {
        relation: finalSummary.vectorString.slice(0, 512),
        text_content: finalText,
        embedding: embeddingArray,
      },
    ];

    const upsertResult = await upsertIntelligenceToMilvus(
      upsertData,
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId
    );

    if (!upsertResult) {
      return createRagError(
        "vector-storage",
        "Failed to store summary in vector database",
        { subject: subject }
      );
    }

    logger.log("Augment", `Final combined summary stored for '${subject}'`);
    return finalText;
  } catch (error) {
    logger.log(
      "Augment",
      `Error in web context retrieval for '${query}': ${error.message}`,
      "err"
    );
    return createRagError("web-context", error.message, {
      query: query,
      subject: subject,
    });
  }
}

// Helper functions for web context retrieval
async function summarizePage(pageContent, subject) {
  try {
    const instruct = await SummaryRequestBody.create(
      `Please summarize the following content about "${subject}" in a way that provides both a concise vector-optimized sentence and a detailed summary.`,
      await retrieveConfigValue("models.summary.model"),
      pageContent
    );

    const chatTask = await sendToolCompletionRequest(
      instruct,
      await retrieveConfigValue("models.summary")
    );

    if (!chatTask) {
      logger.log("Augment", "Empty response from summary request");
      return null;
    }

    if (chatTask.error) {
      logger.log("Augment", `Error in summary request: ${chatTask.error}`);
      return { error: chatTask.error };
    }

    if (typeof chatTask.response === "object" && chatTask.response !== null) {
      return chatTask.response;
    }

    try {
      return JSON.parse(chatTask.response);
    } catch (parseError) {
      logger.log(
        "Augment",
        `Failed to parse summary response as JSON: ${parseError.message}`
      );
      return { error: "JSON parsing failed", details: parseError.message };
    }
  } catch (error) {
    logger.log("Augment", `Error in summarizePage: ${error.message}`);
    return { error: error.message };
  }
}

async function finalCombinedSummary(summaries, subject) {
  try {
    const combinedText = summaries
      .map(
        (s) => `Vector hint: ${s.vectorString}\nDetailed: ${s.summaryContents}`
      )
      .join("\n\n");

    const finalPrompt = `You are provided with multiple summaries for content about "${subject}". Please consolidate these into a final summary. Your output must be in JSON format with two properties: "vectorString" (a single concise sentence optimized for vector search) and "summaryContents" (the complete final summary). Here are the individual summaries:\n\n${combinedText}`;

    const instruct = await SummaryRequestBody.create(
      finalPrompt,
      await retrieveConfigValue("models.summary.model"),
      combinedText
    );

    const chatTask = await sendToolCompletionRequest(
      instruct,
      await retrieveConfigValue("models.summary")
    );

    if (!chatTask) {
      logger.log("Augment", "Empty response from final summary request");
      return createRagError(
        "summary-generation",
        "Empty response from summary tool"
      );
    }

    if (chatTask.error) {
      logger.log(
        "Augment",
        `Error in final summary request: ${chatTask.error}`
      );
      return createRagError("summary-generation", chatTask.error);
    }

    if (typeof chatTask.response === "object" && chatTask.response !== null) {
      if (
        !chatTask.response.vectorString ||
        !chatTask.response.summaryContents
      ) {
        logger.log(
          "Augment",
          "Final summary response missing required properties"
        );
        return createRagError(
          "summary-format",
          "Summary response missing required properties",
          {
            response:
              JSON.stringify(chatTask.response).substring(0, 100) + "...",
          }
        );
      }
      return chatTask.response;
    }

    try {
      const parsedResponse = JSON.parse(chatTask.response);
      if (!parsedResponse.vectorString || !parsedResponse.summaryContents) {
        logger.log(
          "Augment",
          "Parsed final summary response missing required properties"
        );
        return createRagError(
          "summary-format",
          "Parsed summary response missing required properties",
          { response: JSON.stringify(parsedResponse).substring(0, 100) + "..." }
        );
      }
      return parsedResponse;
    } catch (parseError) {
      logger.log(
        "Augment",
        `Failed to parse final summary response as JSON: ${parseError.message}`
      );
      return createRagError(
        "summary-parsing",
        "Failed to parse summary as JSON",
        {
          error: parseError.message,
          rawResponse: chatTask.response.substring(0, 100) + "...",
        }
      );
    }
  } catch (error) {
    logger.log("Augment", `Error in finalCombinedSummary: ${error.message}`);
    return createRagError("summary-execution", error.message, {
      stack: error.stack,
    });
  }
}

async function searchBraveAPI(query, freshness) {
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("result_filter", "web");
    url.searchParams.set("freshness", freshness);

    const httpsAgent = new https.Agent({
      keepAlive: true,
      rejectUnauthorized: true,
      timeout: 10000,
    });

    const response = await fetch(url.toString(), {
      method: "GET",
      agent: httpsAgent,
      headers: {
        "X-Subscription-Token": await retrieveConfigValue("brave.apiKey"),
        Accept: "application/json",
        "User-Agent": "curl/7.68.0",
      },
    });

    const data = await response.json();
    if (data && data.web && Array.isArray(data.web.results)) {
      const chosenResults = data.web.results.slice(0, 4);
      let resultStuff = [];
      for await (const item of chosenResults) {
        const relevantItems = {
          url: item.url,
          title: item.title,
          source: item.meta_url.hostname,
        };
        resultStuff.push(relevantItems);
      }
      return resultStuff;
    } else {
      logger.log(
        "Brave Search",
        `No web results found from Brave for '${query}' using freshness '${freshness}'`,
        "err"
      );
      return [];
    }
  } catch (error) {
    console.error("Error:", error);
    return [];
  }
}

export async function searchSearXNG(query, freshness) {
  try {
    const url = new URL("https://search.prolix.dev/search");
    url.searchParams.set("q", query);
    url.searchParams.set("safesearch", 0);
    url.searchParams.set("categories", "general");
    url.searchParams.set("engines", "google,bing");
    url.searchParams.set("format", "json");

    const response = await axios.get(url.toString());

    if (!response.data || !Array.isArray(response.data.results)) {
      return createRagError("search-api", "Invalid response from search API", {
        query: query,
        responseStatus: response.status,
      });
    }

    if (response.data.results.length === 0) {
      return createRagError("search-results", "No results found for query", {
        query: query,
        freshness: freshness,
      });
    }

    const chosenResults = response.data.results.slice(0, 4);
    let resultStuff = [];

    for await (const item of chosenResults) {
      const relevantItems = {
        url: item.url,
        title: item.title,
        source: item.parsed_url[1],
      };
      resultStuff.push(relevantItems);
    }

    return resultStuff;
  } catch (error) {
    logger.log("SearXNG Search", `Error searching: ${error.message}`);
    return createRagError("search-execution", error.message, { query: query });
  }
}

export async function inferSearchParam(query, userId) {
  try {
    const instruct = await queryPrompt(query, userId);
    const chatTask = await sendToolCompletionRequest(
      instruct,
      await retrieveConfigValue("models.query")
    );

    if (!chatTask || chatTask.error) {
      return createRagError(
        "query-generation",
        "Failed to generate search query",
        { originalError: chatTask?.error || "Unknown error" }
      );
    }

    const fullChat = chatTask.response;

    if (!fullChat || typeof fullChat !== "object") {
      return createRagError(
        "query-parsing",
        "Invalid response structure from query builder",
        { responseType: typeof fullChat }
      );
    }

    if (fullChat.valid === false) {
      logger.log(
        "LLM",
        `Query builder opted out of search for this query. Reason: ${fullChat.reason}`
      );
      return {
        success: false,
        optedOut: true,
        reason: fullChat.reason,
      };
    } else {
      logger.log(
        "LLM",
        `Returned optimized search param: '${fullChat.searchTerm}'. Time to first token: ${chatTask.timeToFirstToken} seconds. Process speed: ${chatTask.tokensPerSecond}tps`
      );
      return {
        success: true,
        searchTerm: fullChat.searchTerm,
        subject: fullChat.subject,
        freshness: fullChat.freshness,
        vectorString: fullChat.vectorString,
      };
    }
  } catch (error) {
    logger.log("LLM", `Error inferring search parameter: ${error}`);
    return createRagError("query-inference", error.message, {
      stack: error.stack,
    });
  }
}

async function readFilesFromDirectory(directory) {
  const files = [];
  try {
    const items = await fs.readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(directory, item.name);
      if (item.isDirectory()) {
        const subDirFiles = await readFilesFromDirectory(fullPath);
        files.push(...subDirFiles);
      } else if (item.isFile() && path.extname(item.name) === ".json") {
        files.push(fullPath);
      }
    }
  } catch (error) {
    logger.log("File System", `Error reading directory ${directory}: ${error}`);
    return [];
  }
  return files;
}

async function compareDocuments(directory, userId, collectionName) {
  const filenames = await readFilesFromDirectory(`${directory}/${userId}`);
  const localDocuments = (
    await Promise.all(
      filenames.map(async (filename) => {
        try {
          const content = await fs.readFile(filename, "utf8");
          return isValidJson(content) ? JSON.parse(content) : null;
        } catch (error) {
          logger.log(
            "File System",
            `Error reading or parsing file ${filename}: ${error}`
          );
          return null;
        }
      })
    )
  ).filter((content) => content !== null);

  const existingDocsResponse = await client.query({
    collection_name: collectionName,
    output_fields: ["relation", "text_content", "embedding"],
    limit: 10000,
  });

  logger.log(
    "Milvus",
    `Retrieved ${existingDocsResponse.data.length} existing documents from Milvus for user ${userId}.`
  );

  const existingDocsMap = new Map(
    existingDocsResponse.data.map((doc) => [doc.relation, doc])
  );

  const toInsert = [];
  const toUpdate = [];
  const toDelete = new Set(existingDocsMap.keys());

  for (const localDoc of localDocuments) {
    if (!localDoc || !localDoc.relation || localDoc.content === undefined) {
      logger.log(
        "Milvus",
        `Skipping invalid local document: ${JSON.stringify(localDoc)}`
      );
      continue;
    }
    const existingDoc = existingDocsMap.get(localDoc.relation);

    const embedding = await getMessageEmbedding(localDoc.relation);
    const flattenedEmbedding = embedding.flat();

    if (!existingDoc) {
      toInsert.push({
        relation: localDoc.relation,
        text_content: localDoc.content,
        embedding: flattenedEmbedding,
      });
    } else {
      toDelete.delete(localDoc.relation);

      if (existingDoc.text_content !== localDoc.content) {
        toUpdate.push({
          relation: localDoc.relation,
          text_content: localDoc.content,
          embedding: flattenedEmbedding,
        });
      }
    }
  }

  return {
    missing: toInsert,
    update: toUpdate,
    remove: Array.from(toDelete).map((relation) => ({ relation })),
  };
}

async function processFiles(directory, userId) {
  try {
    const collectionName = `${await retrieveConfigValue("milvus.collections.intelligence")}_${userId}`;
    const collectionCreated = await checkAndCreateCollection(
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId
    );
    if (!collectionCreated) {
      logger.log(
        "Milvus",
        `Failed to create or verify collection for ${userId}.`
      );
      return;
    }

    const loadedColl = await ensureCollectionLoaded(
      await retrieveConfigValue("milvus.collections.intelligence"),
      userId
    );
    if (!loadedColl) {
      logger.log("Milvus", `Failed to load collection for ${userId}.`);
      return;
    }

    const actions = await compareDocuments(directory, userId, collectionName);

    if (actions.missing.length > 0) {
      await upsertIntelligenceToMilvus(
        [...actions.missing],
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId
      );
      logger.log(
        "Milvus",
        `Adding ${actions.missing.length} documents to ${userId}'s intelligence collection...`
      );
    }

    if (actions.update.length > 0) {
      await upsertIntelligenceToMilvus(
        [...actions.update],
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId
      );
      logger.log(
        "Milvus",
        `Updating ${actions.update.length} documents from ${userId}'s intelligence collection...`
      );
    }

    if (actions.remove.length > 0) {
      await deleteVectorsFromMilvus(
        actions.remove.map((doc) => doc.relation),
        await retrieveConfigValue("milvus.collections.intelligence"),
        userId
      );
      logger.log(
        "Milvus",
        `Removing ${actions.remove.length} documents from ${userId}'s intelligence collection...`
      );
    }
  } catch (error) {
    logger.log("Milvus", `Error processing files for ${userId}: ${error}`);
  }
}

export async function respondToChat(messageData, userId) {
  try {
    const { message, user } = messageData;
    const formattedDate = new Date().toLocaleString();

    logger.log(
      "AI",
      `Starting respondToChat for user ${userId}: "${message.substring(0, 50)}..."`
    );

    // FIXED: Enhanced error handling with detailed logging
    const response = await respondWithContext(message, user, userId);

    if (!response) {
      logger.error(
        "AI",
        `respondWithContext returned null/undefined for user ${userId}`
      );
      return {
        success: false,
        error: "No response generated from AI system",
        details: "respondWithContext returned null or undefined",
      };
    }

    if (!response.response || response.response.trim() === "") {
      logger.error(
        "AI",
        `respondWithContext returned empty response for user ${userId}`
      );
      return {
        success: false,
        error: "AI generated empty response",
        details: "Response object exists but response field is empty",
      };
    }

    logger.log(
      "AI",
      `AI response generated successfully for user ${userId}: "${response.response.substring(0, 50)}..."`
    );

    // FIXED: Enhanced vector storage with error handling
    try {
      const summaryString = `On ${formattedDate}, ${user} said: "${message}". You responded by saying: ${response.response}`;

      // Store the interaction asynchronously
      addChatMessageAsVector(
        summaryString,
        message,
        user,
        formattedDate,
        response.response,
        userId
      ).catch((err) => {
        logger.error(
          "AI",
          `Error saving chat message vector for user ${userId}: ${err.message}`
        );
        // Don't fail the main response for vector storage errors
      });
    } catch (vectorError) {
      logger.error(
        "AI",
        `Error preparing chat message vector for user ${userId}: ${vectorError.message}`
      );
      // Continue with response even if vector storage fails
    }

    return {
      success: true,
      text: response.response,
      thoughtProcess: response.thoughtProcess || null,
      metadata: {
        timestamp: formattedDate,
        userId: userId,
        username: user,
      },
    };
  } catch (error) {
    logger.error(
      "AI",
      `Critical error in respondToChat for user ${userId}: ${error.message}`
    );
    logger.error("AI", `Stack trace: ${error.stack}`);

    return {
      success: false,
      error: `Failed to process chat: ${error.message}`,
      details: error.stack,
    };
  }
}

async function respondWithContext(message, username, userID) {
  const contextId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

  try {
    logger.log(
      "AI",
      `[${contextId}] Starting respondWithContext for user ${userID}: "${message.substring(0, 50)}..."`
    );

    // ENHANCED: Check if we should use cached response
    const responseCacheKey = `response_${userID}_${message}_${username}`;
    const cachedResponse = getCachedResult(responseCacheKey);
    if (cachedResponse) {
      logger.log(
        "AI",
        `[${contextId}] Using cached response from previous identical query`
      );
      return cachedResponse;
    }

    // ENHANCED: Validate configuration before proceeding
    logger.log("AI", `[${contextId}] Validating model configuration...`);

    const modelConfig = await retrieveConfigValue("models.chat");
    if (!modelConfig) {
      throw new Error("Chat model configuration is missing");
    }

    if (!modelConfig.endpoint || !modelConfig.apiKey || !modelConfig.model) {
      logger.error("AI", `[${contextId}] Invalid model configuration:`, {
        hasEndpoint: !!modelConfig.endpoint,
        hasApiKey: !!modelConfig.apiKey,
        hasModel: !!modelConfig.model,
        endpoint: modelConfig.endpoint || "MISSING",
        model: modelConfig.model || "MISSING",
      });
      throw new Error(
        "Incomplete chat model configuration - missing endpoint, apiKey, or model"
      );
    }

    logger.log("AI", `[${contextId}] Model configuration validated:`, {
      endpoint: modelConfig.endpoint,
      model: modelConfig.model,
      maxTokens: modelConfig.maxTokens,
    });

    // ENHANCED: Parallel vector searches with individual error handling and timeouts
    logger.log("AI", `[${contextId}] Starting parallel vector searches...`);

    const searchPromises = [
      Promise.race([
        findRelevantDocuments(message, userID, 8),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Document search timeout")), 10000)
        ),
      ]).catch((error) => {
        logger.warn(
          "AI",
          `[${contextId}] Document search failed: ${error.message}`
        );
        return [];
      }),

      Promise.race([
        findRelevantVoiceInMilvus(message, userID, 3),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Voice search timeout")), 8000)
        ),
      ]).catch((error) => {
        logger.warn(
          "AI",
          `[${contextId}] Voice search failed: ${error.message}`
        );
        return [];
      }),

      Promise.race([
        findRelevantChats(message, username, userID, 3),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Chat search timeout")), 8000)
        ),
      ]).catch((error) => {
        logger.warn(
          "AI",
          `[${contextId}] Chat search failed: ${error.message}`
        );
        return [];
      }),
    ];

    const [rawContext, voiceCtx, chatHistory] =
      await Promise.all(searchPromises);

    logger.log("AI", `[${contextId}] Vector searches completed:`, {
      documents: rawContext?.length || 0,
      voice: voiceCtx?.length || 0,
      chat: chatHistory?.length || 0,
    });

    // ENHANCED: Parallel reranking with error handling
    logger.log("AI", `[${contextId}] Starting reranking process...`);

    const rerankPromises = [
      resultsReranked(rawContext, message, userID, true).catch((error) => {
        logger.warn(
          "AI",
          `[${contextId}] Document reranking failed: ${error.message}`
        );
        return "- No additional context available due to processing error.";
      }),

      resultsReranked(chatHistory, message, userID).catch((error) => {
        logger.warn(
          "AI",
          `[${contextId}] Chat reranking failed: ${error.message}`
        );
        return [];
      }),

      resultsReranked(voiceCtx, message, userID).catch((error) => {
        logger.warn(
          "AI",
          `[${contextId}] Voice reranking failed: ${error.message}`
        );
        return [];
      }),
    ];

    const [contextBody, relChatBody, relVoiceBody] =
      await Promise.all(rerankPromises);

    logger.log("AI", `[${contextId}] Reranking completed successfully`);

    // ENHANCED: Build prompt data with validation
    const promptData = {
      relChats: Array.isArray(relChatBody) ? relChatBody : [],
      relContext: contextBody || "- No additional context available.",
      relVoice: Array.isArray(relVoiceBody) ? relVoiceBody : [],
      chat_user: username,
    };

    logger.log("AI", `[${contextId}] Building context prompt...`);

    // ENHANCED: Generate prompt with error handling
    let body;
    try {
      body = await contextPromptChat(promptData, message, userID);

      if (!body || !body.messages || !Array.isArray(body.messages)) {
        throw new Error("Invalid prompt body structure");
      }

      logger.log("AI", `[${contextId}] Prompt generated successfully:`, {
        messageCount: body.messages.length,
        model: body.model,
        maxTokens: body.max_tokens,
      });
    } catch (promptError) {
      logger.error(
        "AI",
        `[${contextId}] Error generating prompt: ${promptError.message}`
      );
      throw new Error(`Failed to generate prompt: ${promptError.message}`);
    }

    // ENHANCED: Send completion request with comprehensive error handling
    logger.log("AI", `[${contextId}] Sending completion request to vLLM...`);

    const chatTask = await retryMilvusOperation(
      async () => {
        const startTime = Date.now();

        try {
          const result = await sendChatCompletionRequest(body, modelConfig);

          const elapsedTime = Date.now() - startTime;
          logger.log(
            "AI",
            `[${contextId}] Completion request completed in ${elapsedTime}ms`
          );

          if (!result) {
            throw new Error("Empty response from chat completion");
          }

          if (result.error) {
            throw new Error(`Chat completion error: ${result.error}`);
          }

          if (!result.response || result.response.trim() === "") {
            logger.error("AI", `[${contextId}] Empty response received:`, {
              hasResponse: !!result.response,
              responseLength: result.response?.length || 0,
              requestId: result.requestId,
            });
            throw new Error("Chat completion returned empty response");
          }

          return result;
        } catch (requestError) {
          logger.error(
            "AI",
            `[${contextId}] Request error: ${requestError.message}`
          );
          throw requestError;
        }
      },
      3, // Max retries
      1000 // Initial delay
    );

    logger.log("AI", `[${contextId}] Chat completion successful:`, {
      responseLength: chatTask.response?.length || 0,
      timeToFirstToken: chatTask.timeToFirstToken,
      tokensPerSecond: chatTask.tokensPerSecond,
      requestId: chatTask.requestId,
    });

    if (chatTask.thoughtProcess) {
      logger.log("AI", `[${contextId}] Thought process received:`, {
        thoughtLength: chatTask.thoughtProcess.length,
        thoughts: Array.isArray(chatTask.thoughtProcess)
          ? chatTask.thoughtProcess.length
          : "string",
      });
    }

    // ENHANCED: Process and validate response
    logger.log("AI", `[${contextId}] Processing response...`);

    const strippedResp = await replyStripped(chatTask.response, userID);

    if (!strippedResp || strippedResp.trim() === "") {
      logger.error(
        "AI",
        `[${contextId}] Response stripping resulted in empty text`
      );
      throw new Error("Response processing resulted in empty text");
    }

    const finalResponse = {
      response: strippedResp,
      thoughtProcess: chatTask.thoughtProcess,
      metadata: {
        contextId: contextId,
        timeToFirstToken: chatTask.timeToFirstToken,
        tokensPerSecond: chatTask.tokensPerSecond,
        requestId: chatTask.requestId,
        contextUsed: {
          documents: rawContext?.length || 0,
          voice: voiceCtx?.length || 0,
          chat: chatHistory?.length || 0,
        },
        endpoint: modelConfig.endpoint,
        model: modelConfig.model,
      },
    };

    // ENHANCED: Cache successful responses
    setCachedResult(responseCacheKey, finalResponse, 10000);

    logger.log(
      "AI",
      `[${contextId}] Response processing completed successfully:`,
      {
        finalLength: strippedResp.length,
        cached: true,
      }
    );

    return finalResponse;
  } catch (error) {
    logger.error(
      "AI",
      `[${contextId}] Error in respondWithContext: ${error.message}`
    );
    logger.error("AI", `[${contextId}] Stack trace: ${error.stack}`);

    // ENHANCED: Return a contextual fallback response instead of throwing
    const fallbackResponse = {
      response: determineFallbackResponse(error.message),
      thoughtProcess: `Error: ${error.message}`,
      isErrorResponse: true,
      metadata: {
        contextId: contextId,
        errorType: error.name || "Unknown",
        errorMessage: error.message,
      },
    };

    return fallbackResponse;
  }
}

async function rerankString(message, userId) {
  const promptRerank = await rerankPrompt(message, userId);
  const chatTask = await sendToolCompletionRequest(
    promptRerank,
    await retrieveConfigValue("models.rerankTransform")
  );
  return chatTask.response;
}

async function respondWithoutContext(message, userId) {
  try {
    const promptData = {
      relChats: "- No relevant chat context available.",
      relContext: "- No additional context to provide.",
      relVoice: "- No voice conversation history.",
      chat_user: "User",
    };

    const body = await contextPromptChat(promptData, message, userId);
    const chatTask = await sendChatCompletionRequest(
      body,
      await retrieveConfigValue("models.chat")
    );

    const strippedResp = await replyStripped(chatTask.response, userId);
    return {
      response: strippedResp,
      thoughtProcess: chatTask.thoughtProcess,
    };
  } catch (error) {
    logger.log("System", `Error in respondWithoutContext: ${error}`);
    return {
      response: "I'm sorry, I encountered an error processing your request.",
      thoughtProcess: `Error: ${error.message}`,
    };
  }
}

async function respondWithVoice(message, userId) {
  const startTime = performance.now();

  const fixedAcro = await fixTTSString(message);
  const userObj = await returnAuthObject(userId);

  logger.log(
    "LLM",
    `Converted ${fixedAcro.acronymCount} acronyms in ${userObj.bot_name}'s TTS message.`
  );

  try {
    const tempDir = path.join(__dirname, "temp");
    await fs.mkdir(tempDir, { recursive: true }).catch(() => {});

    const ttsPreference = await retrieveConfigValue("ttsPreference");

    let audioFilePath;
    let outputFileName;
    let externalGenUrl;
    let internalGenUrl;
    if (ttsPreference === "fish") {
      const fishParameters = {
        text: fixedAcro.fixedString,
        chunk_length: 400,
        format: "wav",
        reference_id: userObj.fishTTSVoice,
        seed: null,
        normalize: false,
        streaming: false,
        max_new_tokens: 4096,
        top_p: 0.82,
        repetition_penalty: 1.2,
        temperature: 0.75,
      };

      const res = await axios.post(
        new URL(await retrieveConfigValue("fishTTS.ttsGenEndpoint.internal")),
        fishParameters,
        { responseType: "arraybuffer" }
      );

      outputFileName = `fish_${userId}_${Date.now()}.wav`;
      const tempFilePath = path.join("./final", outputFileName);
      await fs.writeFile(tempFilePath, Buffer.from(res.data));

      audioFilePath = tempFilePath;
    } else {
      const voiceForm = new FormData();
      voiceForm.append("text_input", fixedAcro.fixedString);
      voiceForm.append("text_filtering", "standard");
      voiceForm.append("character_voice_gen", userObj.speaker_file);
      voiceForm.append("narrator_enabled", "false");
      voiceForm.append("text_not_inside", "character");
      voiceForm.append("language", "en");
      voiceForm.append("output_file_name", userObj.user_id);
      voiceForm.append("output_file_timestamp", "true");
      voiceForm.append("autoplay", "false");
      voiceForm.append("temperature", "0.9");
      voiceForm.append("repetition_penalty", "1.5");

      const res = await axios.post(
        new URL(await retrieveConfigValue("alltalk.ttsGenEndpoint.internal")),
        voiceForm
      );
      internalGenUrl = `${await retrieveConfigValue("alltalk.ttsServeEndpoint.internal")}${res.data.output_file_url}`
      externalGenUrl = `${await retrieveConfigValue("alltalk.ttsServeEndpoint.external")}${res.data.output_file_url}`
      const fileRes = await axios({
        method: "GET",
        url: `${await retrieveConfigValue("alltalk.ttsServeEndpoint.internal")}${res.data.output_file_url}`,
        responseType: "arraybuffer",
      });

      outputFileName = `${userId}_${Date.now()}.wav`;
      const tempFilePath = path.join("./final", outputFileName);
      await fs.writeFile(tempFilePath, Buffer.from(fileRes.data));

      audioFilePath = tempFilePath;
    }

    const timeElapsed = (performance.now() - startTime) / 1000;

    if (userObj.ttsUpsamplePref) {
      try {
        const processedFilePath = processAudio(audioFilePath, {
          preset: userObj.ttsEqPref || "clarity",
          userId: userObj.user_id,
        });

        logger.log("API", `Processed audio file to ${processedFilePath}`);

        const serviceEndpoint =
          ttsPreference === "fish" ? "fishTTS" : "alltalk";
        const audioUrl = userObj.is_local
          ? internalGenUrl
          : externalGenUrl

        logger.log(
          "LLM",
          `TTS request completed in ${timeElapsed.toFixed(2)} seconds.`
        );
        return audioUrl;
      } catch (processingError) {
        logger.error(
          "API",
          `Error processing audio: ${processingError.message}`
        );
        const serviceEndpoint =
          ttsPreference === "fish" ? "fishTTS" : "alltalk";
        return userObj.is_local
          ? `${await retrieveConfigValue(`${serviceEndpoint}.ttsServeEndpoint.internal`)}/${path.basename(audioFilePath)}`
          : `${await retrieveConfigValue(`${serviceEndpoint}.ttsServeEndpoint.external`)}/${path.basename(audioFilePath)}`;
      }
    } else {
      const audioUrl = userObj.is_local
        ? internalGenUrl
        : externalGenUrl;

      logger.log(
        "LLM",
        `TTS request completed in ${timeElapsed.toFixed(2)} seconds.`
      );
      return audioUrl;
    }
  } catch (error) {
    logger.error("TTS", `Error during TTS request: ${error.message}`);
    return { error: error.message };
  }
}

export async function respondToDirectVoice(message, userId, withVoice = false) {
  try {
    logger.log(
      "Voice",
      `Processing voice interaction for user ${userId}: "${message.substring(0, 50)}..."`
    );

    const userObj = await returnAuthObject(userId);
    if (!userObj) {
      throw new Error(`User ${userId} not found`);
    }

    // FIXED: Enhanced parallel processing for voice context
    const [voiceCtx, rawContext] = await Promise.allSettled([
      findRelevantVoiceInMilvus(message, userId, 3),
      findRelevantDocuments(message, userId, 6),
    ]);

    const voiceResults = voiceCtx.status === "fulfilled" ? voiceCtx.value : [];
    const contextResults =
      rawContext.status === "fulfilled" ? rawContext.value : [];

    logger.log(
      "Voice",
      `Voice context search completed for user ${userId}. Voice: ${voiceResults.length}, Context: ${contextResults.length}`
    );

    // FIXED: Enhanced reranking with error handling
    const [contextBody, voiceCtxBody] = await Promise.allSettled([
      resultsReranked(contextResults, message, userId, true),
      withVoice
        ? resultsReranked(voiceResults, message, userId, false)
        : Promise.resolve("- No additional voice conversations to supply."),
    ]);

    const finalContextBody =
      contextBody.status === "fulfilled"
        ? contextBody.value
        : "- No additional context available due to processing error.";
    const finalVoiceBody =
      voiceCtxBody.status === "fulfilled"
        ? voiceCtxBody.value
        : "- No additional voice conversations to supply.";

    const promptData = {
      relChats: "- No additional chat content.",
      relContext: finalContextBody,
      relVoice: finalVoiceBody,
      user: userObj.user_name,
    };

    logger.log("Voice", `Generating voice response for user ${userId}`);

    const body = await contextPromptChat(promptData, message, userId);
    const chatTask = await sendChatCompletionRequest(
      body,
      await retrieveConfigValue("models.chat")
    );

    if (!chatTask.response) {
      throw new Error("No response generated for voice interaction");
    }

    await fs.writeFile('./chat_cmp_resp.json', JSON.stringify(chatTask.response, null, 2))

    logger.log(
      "Voice",
      `Voice response generated for user ${userId}. Time to first token: ${chatTask.timeToFirstToken} seconds. Process speed: ${chatTask.tokensPerSecond}tps`
    );

    const strippedResp = await replyStripped(chatTask.response, userId);

    // FIXED: Store voice interaction in vectors
    try {
      const formattedDate = new Date().toLocaleString();
      const summaryString = `On ${formattedDate}, ${userObj.user_name} said via voice: "${message}". You responded by saying: ${strippedResp}`;

      addVoiceMessageAsVector(
        summaryString,
        message,
        userObj.user_name,
        formattedDate,
        strippedResp,
        userId
      ).catch((err) =>
        logger.error("Voice", `Error storing voice vector: ${err.message}`)
      );
    } catch (vectorError) {
      logger.error(
        "Voice",
        `Error preparing voice vector: ${vectorError.message}`
      );
    }

    if (withVoice) {
      logger.log("Voice", `Generating TTS audio for user ${userId}`);
      const audioUrl = await respondWithVoice(strippedResp, userId);
      return {
        response: strippedResp,
        audio_url: audioUrl,
        thoughtProcess: chatTask.thoughtProcess,
      };
    } else {
      return {
        response: strippedResp,
        thoughtProcess: chatTask.thoughtProcess,
      };
    }
  } catch (error) {
    logger.error(
      "Voice",
      `Error in respondToDirectVoice for user ${userId}: ${error.message}`
    );
    return {
      response:
        "I'm sorry, I'm having trouble processing voice interactions right now. Please try again.",
      error: error.message,
    };
  }
}

async function respondToEvent(event, userId) {
  try {
    const eventMessage = await returnTwitchEvent(event, userId);
    const instructPrompt = await eventPromptChat(eventMessage, userId);

    const chatTask = await sendChatCompletionRequest(
      instructPrompt,
      await retrieveConfigValue("models.chat")
    );
    logger.log(
      "LLM",
      `Generated event response. Time to first token: ${chatTask.timeToFirstToken} seconds. Process speed: ${chatTask.tokensPerSecond}tps`
    );

    const strippedResp = await replyStripped(chatTask.response, userId);
    return { response: strippedResp, thoughtProcess: chatTask.thoughtProcess };
  } catch (error) {
    logger.log("System", `Error in respondToEvent: ${error}`);
    return {
      response: "I'm sorry, I encountered an error processing this event.",
      thoughtProcess: `Error: ${error.message}`,
    };
  }
}

async function startIndexingVectors(userId) {
  const authObjects = await returnAuthObject(userId);
  logger.log("Milvus", `Beginning indexing for ${authObjects.user_id}`);
  await processFiles(
    `${await retrieveConfigValue("milvus.localTextDirectory")}`,
    authObjects.user_id
  );
}

async function checkMilvusHealth() {
  const isUp = await client.checkHealth();
  return isUp.isHealthy;
}

async function checkMilvusHealthDetailed(userId = null) {
  try {
    const isHealthy = await client.checkHealth();

    const healthData = {
      isHealthy: isHealthy.isHealthy,
      timestamp: Date.now(),
      metrics: {},
    };

    if (!isHealthy.isHealthy) {
      logger.log("Milvus", "Milvus health check failed");
      return healthData;
    }

    if (userId) {
      const collections = [
        await retrieveConfigValue("milvus.collections.user"),
        await retrieveConfigValue("milvus.collections.intelligence"),
        await retrieveConfigValue("milvus.collections.chat"),
        await retrieveConfigValue("milvus.collections.voice"),
      ];

      const collectionStats = {};

      for (const collection of collections) {
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

            collectionStats[collection] = {
              exists: true,
              rowCount: parseInt(stats.stats.row_count || 0),
              loadState: loadState.state,
            };
          } else {
            collectionStats[collection] = {
              exists: false,
            };
          }
        } catch (err) {
          collectionStats[collection] = {
            exists: "error",
            error: err.message,
          };
        }
      }

      healthData.metrics.collections = collectionStats;
    }

    try {
      const sysInfo = await client.getMetric({ request: {} });

      if (sysInfo && sysInfo.response) {
        healthData.metrics.system = sysInfo.response;
      }
    } catch (error) {
      healthData.metrics.system = { error: error.message };
    }

    healthData.metrics.cache = {
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
    logger.log("Milvus", `Error in detailed health check: ${error}`);
    return {
      isHealthy: false,
      error: error.message,
      timestamp: Date.now(),
    };
  }
}

async function weGottaGoBald(collection, userId) {
  try {
    if (userId === "all") {
      const allUsers = await returnAPIKeys();
      let allDropsSuccessful = true;

      for (const user of allUsers) {
        if (collection === "all") {
          const allCollections = [
            await retrieveConfigValue("milvus.collections.user"),
            await retrieveConfigValue("milvus.collections.intelligence"),
            await retrieveConfigValue("milvus.collections.chat"),
            await retrieveConfigValue("milvus.collections.voice"),
          ];
          for (const coll of allCollections) {
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
    logger.log("Milvus", `Error during database reload: ${error}`);
    return false;
  }
}

async function dropCollection(collection, userId) {
  const collectionName = `${collection}_${userId}`;
  try {
    const exists = await client.hasCollection({
      collection_name: collectionName,
    });

    if (!exists.value) {
      logger.log("Milvus", `Collection '${collectionName}' does not exist.`);
      return false;
    }

    const status = await client.dropCollection({
      collection_name: collectionName,
    });

    if (status.error_code === "Success") {
      logger.log(
        "Milvus",
        `Collection '${collectionName}' dropped successfully.`
      );
      return true;
    } else {
      logger.log(
        "Milvus",
        `Failed to drop collection '${collectionName}'. Reason: ${status.reason}`
      );
      return false;
    }
  } catch (error) {
    logger.log(
      "Milvus",
      `Error dropping collection '${collectionName}': ${error}`
    );
    return false;
  }
}

const isValidJson = (input) => {
  if (typeof input === "string") {
    try {
      JSON.parse(input);
      return true;
    } catch {
      return false;
    }
  } else if (typeof input === "object" && input !== null) {
    return true;
  }
  return false;
};

async function checkEndpoint(endpoint, key, modelName) {
  try {
    if (endpoint === (await retrieveConfigValue("models.embedding.endpoint"))) {
      if (
        (await retrieveConfigValue("models.embedding.apiKeyType")) ===
        "infinity"
      ) {
        const response = await axios.get(`${endpoint}/models`, {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          validateStatus: (status) => status < 500,
        });

        if (
          response.status === 200 &&
          response.data &&
          Array.isArray(response.data.data)
        ) {
          const modelFound = response.data.data.some(
            (model) => model.id === modelName
          );
          if (modelFound) {
            return true;
          } else {
            throw new Error(
              `Model ${modelName} not found in the list of available models.`
            );
          }
        } else {
          throw new Error(
            `Invalid response from embedding endpoint: ${response.status}`
          );
        }
      } else if (
        (await retrieveConfigValue("models.embedding.apiKeyType")) ===
        "enspiraEmb"
      ) {
        const response = await axios.get(
          `${await retrieveConfigValue("models.embedding.endpoint")}/health`,
          {
            headers: {
              Authorization: `Bearer ${await retrieveConfigValue("models.embedding.apiKey")}`,
            },
          }
        );
        if (response.status == 200) {
          return true;
        } else {
          return false;
        }
      }
    } else {
      const openai = new OpenAI({
        baseURL: endpoint,
        apiKey: key,
      });
      const response = await openai.models.list();
      if (
        response.data &&
        Array.isArray(response.data) &&
        response.data.length > 0
      ) {
        return true;
      } else {
        throw new Error(`Invalid or empty response from LLM endpoint`);
      }
    }
  } catch (err) {
    logger.log("INIT", `Error checking endpoint ${endpoint}: ${err}`);
    return false;
  }
}

// ==================== EXPORTS ====================
export {
  checkEndpoint,
  respondWithContext,
  checkMilvusHealth,
  rerankString,
  searchBraveAPI,
  addVoiceMessageAsVector,
  loadCollectionIfNeeded,
  addChatMessageAsVector,
  insertAugmentVectorsToMilvus,
  respondWithoutContext,
  respondWithVoice,
  respondToEvent,
  processFiles,
  startIndexingVectors,
  findRelevantVoiceInMilvus,
  findRelevantDocuments,
  weGottaGoBald,
  checkAndCreateCollection,
  returnRecentChats,
  ensureCollectionLoaded,
  retryMilvusOperation,
  getOptimizedSearchParams,
  scheduleVectorInsertion,
  processVectorBatch,
  getCachedResult,
  setCachedResult,
  clearQueryCache,
  checkMilvusHealthDetailed,
  // Legacy function exports for backward compatibility
  returnCollectionSchema,
  createCollection,
  getCollectionSchema,
  findRelevantChats,
  upsertIntelligenceToMilvus,
  insertVoiceVectorsIntoMilvus,
};
